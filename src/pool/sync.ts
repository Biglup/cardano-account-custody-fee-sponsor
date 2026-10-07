import type Database from 'better-sqlite3';
import type { Provider, UTxO } from '@biglup/cometa';
import type { Logger } from 'pino';
import { recordAudit } from '../audit.js';
import type { Config } from '../config.js';
import { type SlotSettings, slotAt } from '../slots.js';
import { type PoolUtxoRow, type UtxoKind, refreshUtxoStatus, utxoRef } from './utxo.js';

/** How often the pool is reconciled with the chain. */
export const SYNC_INTERVAL_MS = 30_000;

/**
 * How many slots past the validity upper bound of its last witness a
 * consumed fee UTxO stays consumed before it is leased again, so that a
 * service clock a little ahead of the chain, or a block the provider has
 * not shown yet, cannot let a witnessed spend land on a UTxO already
 * leased out again.
 */
export const RESTORE_MARGIN_SLOTS = 120n;

/**
 * How far a UTxO's lovelace may sit from a pool size and still count as
 * that kind, as a fraction of the size. A split creates outputs of the
 * exact size, so the tolerance only matters for change and for UTxOs
 * funded by hand.
 */
const CLASSIFICATION_TOLERANCE = 0.1;

/** The pool sizes a UTxO is classified against. */
export type PoolSizes = Pick<Config, 'feeUtxoLovelace' | 'collateralUtxoLovelace'>;

/** What the sponsor address holds outside the pool: UTxOs that are neither fee nor collateral sized, and so can be split. */
export interface ReserveSnapshot {
  utxos: UTxO[];
  lovelace: bigint;
  syncedAt: string | undefined;
}

/** What one reconciliation changed. */
export interface SyncReport {
  discovered: number;
  consumed: number;
  gone: number;
  restored: number;
  reserve: ReserveSnapshot;
}

/** The pool synchronizer: reconciles on demand, on a timer, and remembers the reserve it last saw. */
export interface PoolSync {
  /** Reconciles the pool with the chain now, sharing one run with any caller already waiting on it. */
  run(): Promise<SyncReport>;
  /** The reserve as of the last run; empty and unsynced before the first. */
  reserve(): ReserveSnapshot;
  /** Starts the periodic reconciliation. */
  start(): void;
  /** Stops the periodic reconciliation. */
  stop(): void;
}

/** Everything the synchronizer needs injected; `now` lets tests move the clock the validity bounds are measured against. */
export interface PoolSyncDependencies {
  db: Database.Database;
  provider: Provider;
  sponsorAddress: string;
  sizes: PoolSizes;
  slots: SlotSettings;
  now?: () => Date;
  logger?: Logger;
}

/** Whether `lovelace` is within the tolerance of `size`. */
const isNear = (lovelace: bigint, size: number): boolean => {
  const distance = lovelace > BigInt(size) ? lovelace - BigInt(size) : BigInt(size) - lovelace;
  return distance <= BigInt(Math.floor(size * CLASSIFICATION_TOLERANCE));
};

/**
 * Which pool a UTxO of `lovelace` belongs to: fee when near the fee size,
 * collateral when near the collateral size, otherwise the reserve, which
 * is never leased and is what a split draws on.
 */
export const classifyUtxo = (lovelace: bigint, sizes: PoolSizes): UtxoKind | 'reserve' => {
  if (isNear(lovelace, sizes.feeUtxoLovelace)) {
    return 'fee';
  }
  if (isNear(lovelace, sizes.collateralUtxoLovelace)) {
    return 'collateral';
  }
  return 'reserve';
};

/** A row of the pool table restricted to what reconciliation reads. */
type TrackedRow = Pick<PoolUtxoRow, 'tx_hash' | 'tx_index' | 'kind' | 'status'>;

/** An open lease on a vanished UTxO: its key and UTxOs, and whether a witness was issued for it, as sqlite reports a boolean. */
type OpenLeaseRow = { id: string; api_key_id: number; fee_utxo: string; collateral_utxo: string; witnessed: 0 | 1 };

/** Whether a UTxO holds only lovelace, as every pool UTxO must. */
const holdsOnlyLovelace = (utxo: UTxO): boolean => Object.keys(utxo.output.value.assets ?? {}).length === 0;

/** The pool a listed UTxO belongs to; one carrying tokens is never leased, whatever its lovelace. */
const poolOf = (utxo: UTxO, sizes: PoolSizes): UtxoKind | 'reserve' =>
  holdsOnlyLovelace(utxo) ? classifyUtxo(utxo.output.value.coins, sizes) : 'reserve';

/**
 * Creates the synchronizer. Each run lists the sponsor address through the
 * provider, classifies what it finds by lovelace, inserts unknown fee and
 * collateral UTxOs as free, and settles the ones the pool knew but the
 * chain no longer shows: a fee UTxO is consumed when a witness was issued
 * for a lease on it, gone otherwise; a collateral UTxO is always gone,
 * since no witnessed transaction spends it, so whatever took it was not a
 * witness and a rollback may bring it back. A lease still open on a
 * vanished UTxO is closed, since nothing can be built on it any more:
 * consumed when the witness was issued for that lease, expired otherwise,
 * so that a lease sharing a collateral UTxO with a witnessed one is not
 * reported as consumed. The other UTxO of a closed lease is freed unless
 * another open lease still holds it, and every lease closed here is
 * written to the audit trail like one closed by its expiry or its client.
 * A UTxO marked gone that reappears after a rollback becomes free again.
 * One marked consumed that the chain still lists stays consumed while any
 * witness issued on it can still land, and becomes free once the current
 * slot, read off the clock, is more than `RESTORE_MARGIN_SLOTS` past the
 * validity upper bound of every one of them, since no block can include
 * those transactions any more.
 */
export const createPoolSync = ({ db, provider, sponsorAddress, sizes, slots, now = () => new Date(), logger }: PoolSyncDependencies): PoolSync => {
  let reserve: ReserveSnapshot = { utxos: [], lovelace: 0n, syncedAt: undefined };
  let inFlight: Promise<SyncReport> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const selectTracked = db.prepare('SELECT tx_hash, tx_index, kind, status FROM pool_utxos');
  const insertUtxo = db.prepare(
    "INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES (?, ?, ?, ?, 'free', ?)",
  );
  const restoreUtxo = db.prepare("UPDATE pool_utxos SET status = 'free' WHERE tx_hash = ? AND tx_index = ? AND status = 'gone'");
  const hasWitness = db.prepare('SELECT 1 FROM witnesses w JOIN leases l ON l.id = w.lease_id WHERE l.fee_utxo = ? LIMIT 1');
  const settleUtxo = db.prepare('UPDATE pool_utxos SET status = ? WHERE tx_hash = ? AND tx_index = ?');
  const selectLatestBound = db.prepare(
    `SELECT MAX(w.invalid_hereafter) AS bound FROM witnesses w JOIN leases l ON l.id = w.lease_id
     WHERE l.fee_utxo = ?`,
  );
  const freeConsumed = db.prepare("UPDATE pool_utxos SET status = 'free' WHERE tx_hash = ? AND tx_index = ? AND status = 'consumed'");
  const selectOpenLeases = db.prepare(
    `SELECT l.id, l.api_key_id, l.fee_utxo, l.collateral_utxo,
       EXISTS (SELECT 1 FROM witnesses w WHERE w.lease_id = l.id) AS witnessed
     FROM leases l
     WHERE l.status = 'open' AND (l.fee_utxo = ? OR l.collateral_utxo = ?)`,
  );
  const settleLease = db.prepare("UPDATE leases SET status = ? WHERE id = ? AND status = 'open'");

  /** Whether every transaction witnessed against the fee UTxO has passed its validity upper bound by the margin at `slot`. */
  const everyWitnessLapsed = (ref: string, slot: bigint): boolean => {
    const { bound } = selectLatestBound.get(ref) as { bound: number | null };
    return bound !== null && BigInt(bound) + RESTORE_MARGIN_SLOTS < slot;
  };

  const reconcile = db.transaction((listed: UTxO[], now: string, slot: bigint): Omit<SyncReport, 'reserve'> => {
    const report = { discovered: 0, consumed: 0, gone: 0, restored: 0 };
    const tracked = new Map<string, TrackedRow>();
    for (const row of selectTracked.all() as TrackedRow[]) {
      tracked.set(utxoRef(row.tx_hash, row.tx_index), row);
    }

    const seen = new Set<string>();
    for (const utxo of listed) {
      const ref = utxoRef(utxo.input.txId, utxo.input.index);
      seen.add(ref);
      const kind = poolOf(utxo, sizes);
      if (kind === 'reserve') {
        continue;
      }
      const known = tracked.get(ref);
      if (known === undefined) {
        insertUtxo.run(utxo.input.txId, utxo.input.index, Number(utxo.output.value.coins), kind, now);
        report.discovered += 1;
      } else if (known.status === 'gone') {
        restoreUtxo.run(utxo.input.txId, utxo.input.index);
        report.restored += 1;
      } else if (known.status === 'consumed' && everyWitnessLapsed(ref, slot)) {
        freeConsumed.run(utxo.input.txId, utxo.input.index);
        recordAudit(db, { action: 'pool', outcome: 'restored', detail: { utxo: ref, slot: slot.toString() } });
        report.restored += 1;
      }
    }

    for (const [ref, row] of tracked) {
      if (seen.has(ref) || row.status === 'gone' || row.status === 'consumed') {
        continue;
      }
      const status = row.kind === 'fee' && hasWitness.get(ref) !== undefined ? 'consumed' : 'gone';
      settleUtxo.run(status, row.tx_hash, row.tx_index);
      for (const lease of selectOpenLeases.all(ref, ref) as OpenLeaseRow[]) {
        const outcome = lease.witnessed ? 'consumed' : 'expired';
        settleLease.run(outcome, lease.id);
        refreshUtxoStatus(db, lease.fee_utxo);
        refreshUtxoStatus(db, lease.collateral_utxo);
        recordAudit(db, { apiKeyId: lease.api_key_id, action: 'lease', outcome, detail: { leaseId: lease.id, reason: 'utxo_vanished', utxo: ref } });
      }
      report[status] += 1;
    }
    return report;
  });

  const runOnce = async (): Promise<SyncReport> => {
    const listed = await provider.getUnspentOutputs(sponsorAddress);
    const current = now();
    const syncedAt = current.toISOString();
    const changes = reconcile(listed, syncedAt, slotAt(slots, current));
    const reserveUtxos = listed.filter((utxo) => poolOf(utxo, sizes) === 'reserve');
    reserve = {
      utxos: reserveUtxos,
      lovelace: reserveUtxos.reduce((total, utxo) => total + utxo.output.value.coins, 0n),
      syncedAt,
    };
    const report = { ...changes, reserve };
    logger?.info(
      { discovered: report.discovered, consumed: report.consumed, gone: report.gone, restored: report.restored, reserveLovelace: reserve.lovelace.toString() },
      'Pool synced',
    );
    return report;
  };

  const run = (): Promise<SyncReport> => {
    if (inFlight === undefined) {
      inFlight = runOnce().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };

  return {
    run,
    reserve: () => reserve,
    start: () => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        run().catch((err: unknown) => logger?.error({ err }, 'Pool sync failed'));
      }, SYNC_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
};
