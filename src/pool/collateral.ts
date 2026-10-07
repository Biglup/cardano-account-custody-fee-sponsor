import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { NoUtxoAvailableError, OutOfFundsError } from '../http/errors.js';
import { minimumSplitLovelace } from './sizes.js';
import type { PoolSync } from './sync.js';
import { type PoolUtxo, type PoolUtxoRow, findPoolUtxo, toPoolUtxo, utxoRef } from './utxo.js';

/** The row naming the designated collateral UTxO, as sqlite returns it. */
type DesignationRow = { tx_hash: string; tx_index: number; chosen_at: string };

/** The shared collateral UTxO with the time it was designated. */
export interface Designation {
  utxo: PoolUtxo;
  chosenAt: string;
}

/**
 * The collateral UTxO the service designated, as the pool tracks it,
 * whatever its status, or undefined when none was ever designated or the
 * pool no longer tracks it.
 */
export const designatedCollateral = (db: Database.Database): Designation | undefined => {
  const row = db.prepare('SELECT tx_hash, tx_index, chosen_at FROM shared_collateral WHERE id = 1').get() as DesignationRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const utxo = findPoolUtxo(db, utxoRef(row.tx_hash, row.tx_index));
  return utxo === undefined ? undefined : { utxo, chosenAt: row.chosen_at };
};

/** The shared collateral UTxO every transaction declares: the designated one while the chain still lists it, or undefined when there is none to share. */
export const sharedCollateralOf = (db: Database.Database): PoolUtxo | undefined => {
  const designation = designatedCollateral(db);
  return designation?.utxo.status === 'free' ? designation.utxo : undefined;
};

/**
 * Keeps the designation valid: the designated UTxO stays while the chain
 * still lists it, otherwise the oldest free collateral UTxO takes its
 * place, or the designation is dropped when the pool holds none. The
 * choice is persisted so that a restart keeps the same UTxO, and every
 * change is logged. Returns what is shared once the refresh is done.
 */
export const refreshSharedCollateral = (db: Database.Database, now: string, logger?: Logger): PoolUtxo | undefined => {
  const current = sharedCollateralOf(db);
  if (current !== undefined) {
    return current;
  }
  const next = db
    .prepare("SELECT * FROM pool_utxos WHERE kind = 'collateral' AND status = 'free' ORDER BY discovered_at, tx_hash, tx_index LIMIT 1")
    .get() as PoolUtxoRow | undefined;
  if (next === undefined) {
    db.prepare('DELETE FROM shared_collateral WHERE id = 1').run();
    return undefined;
  }
  db.prepare(
    `INSERT INTO shared_collateral (id, tx_hash, tx_index, chosen_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET tx_hash = excluded.tx_hash, tx_index = excluded.tx_index, chosen_at = excluded.chosen_at`,
  ).run(next.tx_hash, next.tx_index, now);
  logger?.info({ utxo: utxoRef(next.tx_hash, next.tx_index), lovelace: next.lovelace }, 'Shared collateral designated');
  return toPoolUtxo(next);
};

/** The pool sizes a collateral shortage is explained against. */
export type CollateralSettings = Pick<Config, 'collateralUtxoLovelace'>;

/**
 * Why no collateral can be shared: the pool holds no collateral UTxO, and
 * either the reserve can fund one through a replenish or it cannot.
 */
export const collateralShortage = (reserveLovelace: bigint, settings: CollateralSettings): NoUtxoAvailableError | OutOfFundsError => {
  const needed = minimumSplitLovelace(settings.collateralUtxoLovelace);
  if (reserveLovelace < needed) {
    return new OutOfFundsError(`The pool has no collateral UTxO and the reserve holds ${reserveLovelace} lovelace; a split needs at least ${needed}`);
  }
  return new NoUtxoAvailableError(`The pool has no collateral UTxO yet; the reserve holds ${reserveLovelace} lovelace and can be split by replenishing`);
};

/** The shared collateral as the routes and the policy read it. */
export interface SharedCollateral {
  /** The shared collateral UTxO, or undefined when the pool holds none. */
  current(): PoolUtxo | undefined;
  /** The shared collateral UTxO, after one reconciliation with the chain when none is designated; refused by the shortage when there is still none. */
  require(): Promise<PoolUtxo>;
}

/** Everything the shared collateral needs injected. */
export interface SharedCollateralDependencies {
  db: Database.Database;
  sync: PoolSync;
  settings: CollateralSettings;
}

/**
 * Creates the view of the shared collateral the routes and the witness
 * service use. The pool sync is what designates and replaces the UTxO;
 * this only reads the designation, and asks for a reconciliation once
 * when there is none, in case a split or a return of funds has landed.
 */
export const createSharedCollateral = ({ db, sync, settings }: SharedCollateralDependencies): SharedCollateral => {
  const current = (): PoolUtxo | undefined => sharedCollateralOf(db);
  return {
    current,
    require: async () => {
      const shared = current();
      if (shared !== undefined) {
        return shared;
      }
      const { reserve } = await sync.run();
      const refreshed = current();
      if (refreshed !== undefined) {
        return refreshed;
      }
      throw collateralShortage(reserve.lovelace, settings);
    },
  };
};
