import type Database from 'better-sqlite3';
import { Router } from 'express';

/**
 * The pool as the health and admin routes count it: how many fee UTxOs
 * are free versus leased, whether a collateral UTxO is shared, how many
 * spare collateral UTxOs stand ready to replace it, and how many were
 * consumed so far, which only a phase two failure does.
 */
export interface PoolCounts {
  fee: { free: number; leased: number };
  collateral: { shared: boolean; spare: number; consumed: number };
}

type PoolRow = { kind: 'fee' | 'collateral'; status: 'free' | 'leased' | 'consumed'; count: number };

const POOL_COUNTS_QUERY = `
  SELECT kind, status, COUNT(*) AS count
  FROM pool_utxos
  WHERE status IN ('free', 'leased', 'consumed')
  GROUP BY kind, status
`;

const SHARED_COLLATERAL_QUERY = `
  SELECT 1 FROM shared_collateral s JOIN pool_utxos p ON p.tx_hash = s.tx_hash AND p.tx_index = s.tx_index
  WHERE s.id = 1 AND p.status = 'free'
`;

/** The pool counts, all zero when the pool has not been replenished yet. */
export const poolCounts = (db: Database.Database): PoolCounts => {
  const counts: PoolCounts = { fee: { free: 0, leased: 0 }, collateral: { shared: false, spare: 0, consumed: 0 } };
  const shared = db.prepare(SHARED_COLLATERAL_QUERY).get() !== undefined;
  counts.collateral.shared = shared;
  for (const row of db.prepare(POOL_COUNTS_QUERY).all() as PoolRow[]) {
    if (row.kind === 'fee' && row.status !== 'consumed') {
      counts.fee[row.status] = row.count;
    } else if (row.kind === 'collateral' && row.status === 'free') {
      counts.collateral.spare = row.count - (shared ? 1 : 0);
    } else if (row.kind === 'collateral' && row.status === 'consumed') {
      counts.collateral.consumed = row.count;
    }
  }
  return counts;
};

/**
 * The health router: reports that the process is up, which network it
 * serves, and the current pool counts, so an operator can see fund
 * exhaustion, and a consumed collateral, without calling the admin
 * endpoint.
 */
export const createHealthRouter = (db: Database.Database, network: string): Router => {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ ok: true, network, pool: poolCounts(db) });
  });
  return router;
};
