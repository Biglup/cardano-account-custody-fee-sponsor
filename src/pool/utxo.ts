import type Database from 'better-sqlite3';

/** What a pool UTxO is for: paying a client's fee, or backing collateral. */
export type UtxoKind = 'fee' | 'collateral';

/**
 * Where a pool UTxO is in its life: leasable, held by a lease, spent by a
 * witnessed transaction or taken as collateral, vanished without either,
 * or retired because a pool size change left it outside every pool, after
 * which it is never leased or restored and a replenish may spend it.
 */
export type UtxoStatus = 'free' | 'leased' | 'consumed' | 'gone' | 'retired';

/** One sponsor UTxO as the pool table tracks it. */
export interface PoolUtxo {
  txHash: string;
  index: number;
  lovelace: number;
  kind: UtxoKind;
  status: UtxoStatus;
  discoveredAt: string;
}

/** A pool UTxO as sqlite returns it. */
export interface PoolUtxoRow {
  tx_hash: string;
  tx_index: number;
  lovelace: number;
  kind: UtxoKind;
  status: UtxoStatus;
  discovered_at: string;
}

/** The `txHash#index` form leases use to point at a pool UTxO. */
export const utxoRef = (txHash: string, index: number): string => `${txHash}#${index}`;

/** The transaction hash and output index a reference names. */
export const parseUtxoRef = (ref: string): { txHash: string; index: number } => {
  const separator = ref.lastIndexOf('#');
  if (separator < 0) {
    throw new Error(`Malformed UTxO reference ${ref}`);
  }
  return { txHash: ref.slice(0, separator), index: Number(ref.slice(separator + 1)) };
};

/** The pool UTxO a row describes. */
export const toPoolUtxo = (row: PoolUtxoRow): PoolUtxo => ({
  txHash: row.tx_hash,
  index: row.tx_index,
  lovelace: row.lovelace,
  kind: row.kind,
  status: row.status,
  discoveredAt: row.discovered_at,
});

/** The pool UTxO a lease references, or undefined when the pool no longer tracks it. */
export const findPoolUtxo = (db: Database.Database, ref: string): PoolUtxo | undefined => {
  const { txHash, index } = parseUtxoRef(ref);
  const row = db.prepare('SELECT * FROM pool_utxos WHERE tx_hash = ? AND tx_index = ?').get(txHash, index) as PoolUtxoRow | undefined;
  return row ? toPoolUtxo(row) : undefined;
};

/**
 * Brings a fee UTxO's status in line with the leases on it: leased while
 * an open lease references it, free otherwise. A UTxO already consumed or
 * gone is left alone, since the chain, not a lease, decided that.
 */
export const refreshUtxoStatus = (db: Database.Database, ref: string): void => {
  const { txHash, index } = parseUtxoRef(ref);
  db.prepare(
    `UPDATE pool_utxos
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM leases WHERE status = 'open' AND fee_utxo = ?) THEN 'leased'
       ELSE 'free'
     END
     WHERE tx_hash = ? AND tx_index = ? AND status IN ('free', 'leased')`,
  ).run(ref, txHash, index);
};
