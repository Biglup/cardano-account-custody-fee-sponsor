import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { recordAudit } from '../audit.js';
import type { Config } from '../config.js';
import {
  LeaseConsumedError,
  LeaseExpiredError,
  LeaseReleasedError,
  NoUtxoAvailableError,
  OutOfFundsError,
  QuotaExceededError,
  UnknownLeaseError,
} from '../http/errors.js';
import type { ApiKey } from '../keys.js';
import { minimumSplitLovelace } from './replenish.js';
import type { PoolSync } from './sync.js';
import { type PoolUtxo, type PoolUtxoRow, findPoolUtxo, refreshUtxoStatus, utxoRef } from './utxo.js';

/** How often open leases past their expiry are swept. */
export const SWEEP_INTERVAL_MS = 30_000;

/** Where a lease is in its life. */
export type LeaseStatus = 'open' | 'released' | 'consumed' | 'expired';

/** A lease: the fee and collateral UTxOs one client may build on until the expiry. */
export interface Lease {
  id: string;
  apiKeyId: number;
  fee: PoolUtxo;
  collateral: PoolUtxo;
  expiresAt: string;
  status: LeaseStatus;
  createdAt: string;
}

/**
 * The witness issued for a lease: the hash of the transaction it signs,
 * what it sponsors, the witness set itself, and the slot the transaction
 * stops being valid at, after which the fee UTxO it spends is safe to
 * lease again if the chain still holds it.
 */
export interface Witness {
  txHash: string;
  sponsoredLovelace: number;
  witnessSet: string;
  invalidHereafter: number;
  issuedAt: string;
}

/** A witness quota a key has used up: which one, and the sentence saying its bound. */
export interface QuotaShortfall {
  quota: 'witnesses_per_hour' | 'sponsored_lovelace_per_day';
  detail: string;
}

/** The lease service: hands out, releases, consumes and expires leases, and measures the witness quotas. */
export interface LeaseService {
  /** Reserves one fee UTxO and one collateral UTxO for the key. */
  create(apiKey: ApiKey): Promise<Lease>;
  /** The lease the key holds under the id, whatever its status. */
  find(apiKey: ApiKey, leaseId: string): Lease;
  /** Releases an open lease the key holds, so its UTxOs can be leased again at once. */
  release(apiKey: ApiKey, leaseId: string): Lease;
  /**
   * The witness quota the key would break by obtaining one more witness
   * now, sponsoring `sponsoredLovelace` when that is known yet, or
   * undefined when both quotas hold.
   */
  witnessQuotaShortfall(apiKey: ApiKey, sponsoredLovelace?: number): QuotaShortfall | undefined;
  /**
   * Records the witness issued for an open lease and closes it as
   * consumed, after checking the key's witness quotas once more in the
   * same step; a lease no longer open is refused by its status, a quota
   * that no longer holds by `QuotaExceededError`.
   */
  consume(apiKey: ApiKey, lease: Lease, witness: Omit<Witness, 'issuedAt'>): void;
  /** The witness issued for the lease, if one was. */
  witnessOf(leaseId: string): Witness | undefined;
  /** Closes every open lease past its expiry and returns how many it closed. */
  expireStale(): number;
  /** Starts the periodic sweep of expired leases. */
  start(): void;
  /** Stops the periodic sweep. */
  stop(): void;
}

/** The tunables leasing depends on. */
export type LeaseSettings = Pick<Config, 'leaseTtlSeconds' | 'collateralSharing' | 'feeUtxoLovelace' | 'collateralUtxoLovelace'>;

/** Everything the lease service needs injected; `now` lets tests move the clock. */
export interface LeaseServiceDependencies {
  db: Database.Database;
  sync: PoolSync;
  settings: LeaseSettings;
  now?: () => Date;
  logger?: Logger;
}

type LeaseRow = {
  id: string;
  api_key_id: number;
  fee_utxo: string;
  collateral_utxo: string;
  expires_at: string;
  status: LeaseStatus;
  created_at: string;
};

type WitnessRow = { tx_hash: string; sponsored_lovelace: number; witness_set: string; invalid_hereafter: number; issued_at: string };

/** The windows the witness quotas are measured over. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Why a lease attempt found nothing to reserve. */
type Shortage = 'no_fee_utxo' | 'no_collateral_utxo';

/** Whether an error is sqlite refusing a row that breaks a unique constraint. */
const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_UNIQUE';

/**
 * Creates the lease service. A lease is taken in one sqlite transaction:
 * the key's open lease quota is checked, the oldest free fee UTxO and the
 * collateral UTxO with the fewest open leases below the sharing limit are
 * chosen, the lease is inserted and both UTxOs are marked leased. The
 * partial unique index on open leases makes a fee UTxO leasable once; if
 * another writer takes the same UTxO first the insert fails, the UTxO is
 * recorded as leased and the attempt is retried once from the next
 * candidate. When no fee UTxO is free the pool is resynced with the chain
 * before giving up, in case a split or a return of funds has landed. A
 * key refused for holding its open lease quota is written to the audit
 * trail like one refused for a shortage.
 *
 * Consuming a lease records its witness and marks the fee UTxO consumed
 * rather than free: the signature is out there and the spend can land at
 * any moment, so the UTxO must not be leased again until the chain can no
 * longer accept that transaction, which the pool sync watches for.
 * Collateral is only spent on a phase two failure the policy refuses to
 * witness, so it stays leasable and merely sheds the closed lease.
 *
 * The witness quotas count the witnesses issued to a key's leases over
 * the last hour and the lovelace they sponsored over the last day. They
 * are measured here because the step that consumes a lease is a sqlite
 * transaction, so checking them again inside it makes the bound hold
 * however many requests for one key are in flight at once.
 */
export const createLeaseService = ({ db, sync, settings, now = () => new Date(), logger }: LeaseServiceDependencies): LeaseService => {
  let timer: NodeJS.Timeout | undefined;

  const countOpenLeases = db.prepare("SELECT COUNT(*) AS count FROM leases WHERE api_key_id = ? AND status = 'open'");
  const selectOldestFreeFee = db.prepare(
    "SELECT * FROM pool_utxos WHERE kind = 'fee' AND status = 'free' ORDER BY discovered_at, tx_hash, tx_index LIMIT 1",
  );
  const selectLeastSharedCollateral = db.prepare(
    `SELECT p.*, (
       SELECT COUNT(*) FROM leases l WHERE l.status = 'open' AND l.collateral_utxo = p.tx_hash || '#' || p.tx_index
     ) AS open_leases
     FROM pool_utxos p
     WHERE p.kind = 'collateral' AND p.status IN ('free', 'leased')
     ORDER BY open_leases, p.discovered_at, p.tx_hash, p.tx_index
     LIMIT 1`,
  );
  const insertLease = db.prepare(
    `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  );
  const markLeased = db.prepare("UPDATE pool_utxos SET status = 'leased' WHERE tx_hash = ? AND tx_index = ?");
  const selectLease = db.prepare('SELECT * FROM leases WHERE id = ? AND api_key_id = ?');
  const setLeaseStatus = db.prepare("UPDATE leases SET status = ? WHERE id = ? AND status = 'open'");
  const selectExpired = db.prepare("SELECT * FROM leases WHERE status = 'open' AND expires_at <= ?");
  const selectLeaseById = db.prepare('SELECT * FROM leases WHERE id = ?');
  const insertWitness = db.prepare(
    'INSERT INTO witnesses (lease_id, tx_hash, sponsored_lovelace, witness_set, invalid_hereafter, issued_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectWitness = db.prepare(
    'SELECT tx_hash, sponsored_lovelace, witness_set, invalid_hereafter, issued_at FROM witnesses WHERE lease_id = ?',
  );
  const countRecentWitnesses = db.prepare(
    'SELECT COUNT(*) AS count FROM witnesses w JOIN leases l ON l.id = w.lease_id WHERE l.api_key_id = ? AND w.issued_at > ?',
  );
  const sumRecentSponsored = db.prepare(
    'SELECT COALESCE(SUM(w.sponsored_lovelace), 0) AS total FROM witnesses w JOIN leases l ON l.id = w.lease_id WHERE l.api_key_id = ? AND w.issued_at > ?',
  );
  const markConsumed = db.prepare("UPDATE pool_utxos SET status = 'consumed' WHERE tx_hash = ? AND tx_index = ?");
  const countLeasedFee = db.prepare("SELECT COUNT(*) AS count FROM pool_utxos WHERE kind = 'fee' AND status = 'leased'");
  const selectSoonestExpiry = db.prepare("SELECT MIN(expires_at) AS soonest FROM leases WHERE status = 'open'");

  const toLease = (row: LeaseRow): Lease => {
    const fee = findPoolUtxo(db, row.fee_utxo);
    const collateral = findPoolUtxo(db, row.collateral_utxo);
    if (!fee || !collateral) {
      throw new Error(`Lease ${row.id} references a UTxO the pool no longer tracks`);
    }
    return {
      id: row.id,
      apiKeyId: row.api_key_id,
      fee,
      collateral,
      expiresAt: row.expires_at,
      status: row.status,
      createdAt: row.created_at,
    };
  };

  const closeLease = db.transaction((row: LeaseRow, status: LeaseStatus): void => {
    setLeaseStatus.run(status, row.id);
    refreshUtxoStatus(db, row.fee_utxo);
    refreshUtxoStatus(db, row.collateral_utxo);
  });

  const expireStale = (): number => {
    const rows = selectExpired.all(now().toISOString()) as LeaseRow[];
    for (const row of rows) {
      closeLease(row, 'expired');
      recordAudit(db, { apiKeyId: row.api_key_id, action: 'lease', outcome: 'expired', detail: { leaseId: row.id } });
    }
    return rows.length;
  };

  let candidate: PoolUtxoRow | undefined;

  const attempt = db.transaction((apiKey: ApiKey): LeaseRow | Shortage => {
    candidate = undefined;
    const open = (countOpenLeases.get(apiKey.id) as { count: number }).count;
    if (open >= apiKey.quotas.openLeases) {
      throw new QuotaExceededError('open_leases', `at most ${apiKey.quotas.openLeases} open leases per key`);
    }
    const fee = selectOldestFreeFee.get() as PoolUtxoRow | undefined;
    if (!fee) {
      return 'no_fee_utxo';
    }
    candidate = fee;
    const collateral = selectLeastSharedCollateral.get() as (PoolUtxoRow & { open_leases: number }) | undefined;
    if (!collateral || collateral.open_leases >= settings.collateralSharing) {
      return 'no_collateral_utxo';
    }
    const createdAt = now();
    const row: LeaseRow = {
      id: randomUUID(),
      api_key_id: apiKey.id,
      fee_utxo: utxoRef(fee.tx_hash, fee.tx_index),
      collateral_utxo: utxoRef(collateral.tx_hash, collateral.tx_index),
      expires_at: new Date(createdAt.getTime() + settings.leaseTtlSeconds * 1000).toISOString(),
      status: 'open',
      created_at: createdAt.toISOString(),
    };
    insertLease.run(row.id, row.api_key_id, row.fee_utxo, row.collateral_utxo, row.expires_at, row.created_at);
    markLeased.run(fee.tx_hash, fee.tx_index);
    markLeased.run(collateral.tx_hash, collateral.tx_index);
    return row;
  });

  const attemptWithRetry = (apiKey: ApiKey): LeaseRow | Shortage => {
    try {
      return attempt(apiKey);
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      if (candidate) {
        markLeased.run(candidate.tx_hash, candidate.tx_index);
      }
      logger?.warn({ apiKeyId: apiKey.id }, 'Lease attempt lost a race and is retried');
      return attempt(apiKey);
    }
  };

  const shortageError = (shortage: Shortage): NoUtxoAvailableError | OutOfFundsError => {
    if (shortage === 'no_collateral_utxo') {
      return new NoUtxoAvailableError('Every collateral UTxO is shared by the most leases allowed');
    }
    const leased = (countLeasedFee.get() as { count: number }).count;
    if (leased > 0) {
      const soonest = (selectSoonestExpiry.get() as { soonest: string | null }).soonest ?? 'unknown';
      return new NoUtxoAvailableError(`All ${leased} fee UTxOs are leased; the soonest lease expires at ${soonest}`);
    }
    const reserve = sync.reserve().lovelace;
    const needed = minimumSplitLovelace(settings);
    if (reserve < needed) {
      return new OutOfFundsError(`The pool has no fee UTxO and the reserve holds ${reserve} lovelace; a split needs at least ${needed}`);
    }
    return new NoUtxoAvailableError(`The pool has no fee UTxO yet; the reserve holds ${reserve} lovelace and can be split by replenishing`);
  };

  /** Records a refusal under the open lease quota and rethrows it; any other failure passes through untouched. */
  const auditQuota = (apiKey: ApiKey, err: unknown): never => {
    if (err instanceof QuotaExceededError) {
      recordAudit(db, { apiKeyId: apiKey.id, action: 'lease', outcome: err.code, detail: { quota: err.quota, reason: err.detail } });
    }
    throw err;
  };

  const create = async (apiKey: ApiKey): Promise<Lease> => {
    expireStale();
    let outcome: LeaseRow | Shortage;
    try {
      outcome = attemptWithRetry(apiKey);
      if (outcome === 'no_fee_utxo') {
        await sync.run();
        outcome = attemptWithRetry(apiKey);
      }
    } catch (err) {
      return auditQuota(apiKey, err);
    }
    if (typeof outcome === 'string') {
      const error = shortageError(outcome);
      recordAudit(db, { apiKeyId: apiKey.id, action: 'lease', outcome: error.code, detail: { reason: outcome } });
      throw error;
    }
    recordAudit(db, {
      apiKeyId: apiKey.id,
      action: 'lease',
      outcome: 'created',
      detail: { leaseId: outcome.id, feeUtxo: outcome.fee_utxo, collateralUtxo: outcome.collateral_utxo, expiresAt: outcome.expires_at },
    });
    return toLease(outcome);
  };

  const find = (apiKey: ApiKey, leaseId: string): Lease => {
    const row = selectLease.get(leaseId, apiKey.id) as LeaseRow | undefined;
    if (!row) {
      throw new UnknownLeaseError(leaseId);
    }
    return toLease(row);
  };

  /** The start of the window of `length` milliseconds ending now, as the witness table stores times. */
  const windowStart = (length: number): string => new Date(now().getTime() - length).toISOString();

  const witnessQuotaShortfall = (apiKey: ApiKey, sponsoredLovelace?: number): QuotaShortfall | undefined => {
    const issued = (countRecentWitnesses.get(apiKey.id, windowStart(HOUR_MS)) as { count: number }).count;
    if (issued >= apiKey.quotas.witnessesPerHour) {
      return { quota: 'witnesses_per_hour', detail: `at most ${apiKey.quotas.witnessesPerHour} witnesses per hour per key` };
    }
    if (sponsoredLovelace === undefined) {
      return undefined;
    }
    const total = BigInt((sumRecentSponsored.get(apiKey.id, windowStart(DAY_MS)) as { total: number }).total);
    if (total + BigInt(sponsoredLovelace) > BigInt(apiKey.quotas.sponsoredLovelacePerDay)) {
      return {
        quota: 'sponsored_lovelace_per_day',
        detail: `at most ${apiKey.quotas.sponsoredLovelacePerDay} sponsored lovelace per day per key`,
      };
    }
    return undefined;
  };

  const consume = db.transaction((apiKey: ApiKey, lease: Lease, witness: Omit<Witness, 'issuedAt'>): void => {
    const shortfall = witnessQuotaShortfall(apiKey, witness.sponsoredLovelace);
    if (shortfall !== undefined) {
      throw new QuotaExceededError(shortfall.quota, shortfall.detail);
    }
    const changed = setLeaseStatus.run('consumed', lease.id).changes;
    if (changed === 0) {
      const row = selectLeaseById.get(lease.id) as LeaseRow | undefined;
      if (row?.status === 'expired') {
        throw new LeaseExpiredError(lease.id);
      }
      if (row?.status === 'released') {
        throw new LeaseReleasedError(lease.id);
      }
      throw new LeaseConsumedError(lease.id);
    }
    insertWitness.run(lease.id, witness.txHash, witness.sponsoredLovelace, witness.witnessSet, witness.invalidHereafter, now().toISOString());
    markConsumed.run(lease.fee.txHash, lease.fee.index);
    refreshUtxoStatus(db, utxoRef(lease.collateral.txHash, lease.collateral.index));
  });

  const witnessOf = (leaseId: string): Witness | undefined => {
    const row = selectWitness.get(leaseId) as WitnessRow | undefined;
    return row
      ? {
          txHash: row.tx_hash,
          sponsoredLovelace: row.sponsored_lovelace,
          witnessSet: row.witness_set,
          invalidHereafter: row.invalid_hereafter,
          issuedAt: row.issued_at,
        }
      : undefined;
  };

  const release = (apiKey: ApiKey, leaseId: string): Lease => {
    expireStale();
    const row = selectLease.get(leaseId, apiKey.id) as LeaseRow | undefined;
    if (!row) {
      throw new UnknownLeaseError(leaseId);
    }
    if (row.status === 'expired') {
      throw new LeaseExpiredError(leaseId);
    }
    if (row.status === 'consumed') {
      throw new LeaseConsumedError(leaseId);
    }
    if (row.status === 'open') {
      closeLease(row, 'released');
      recordAudit(db, { apiKeyId: apiKey.id, action: 'lease', outcome: 'released', detail: { leaseId } });
    }
    return toLease({ ...row, status: 'released' });
  };

  return {
    create,
    find,
    release,
    witnessQuotaShortfall,
    consume,
    witnessOf,
    expireStale,
    start: () => {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        try {
          const expired = expireStale();
          if (expired > 0) {
            logger?.info({ expired }, 'Expired leases swept');
          }
        } catch (err) {
          logger?.error({ err }, 'Lease sweep failed');
        }
      }, SWEEP_INTERVAL_MS);
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
