import type Database from 'better-sqlite3';
import { Router } from 'express';

/** How many sponsor UTxOs of each kind are currently free versus leased. */
export interface PoolCounts {
  fee: { free: number; leased: number };
  collateral: { free: number; leased: number };
}

type PoolRow = { kind: 'fee' | 'collateral'; status: 'free' | 'leased'; count: number };

const POOL_COUNTS_QUERY = `
  SELECT kind, status, COUNT(*) AS count
  FROM pool_utxos
  WHERE status IN ('free', 'leased')
  GROUP BY kind, status
`;

/** The free and leased counts for each UTxO kind in the pool, zero when the pool has not been replenished yet. */
export const poolCounts = (db: Database.Database): PoolCounts => {
  const counts: PoolCounts = { fee: { free: 0, leased: 0 }, collateral: { free: 0, leased: 0 } };
  const rows = db.prepare(POOL_COUNTS_QUERY).all() as PoolRow[];
  for (const row of rows) {
    counts[row.kind][row.status] = row.count;
  }
  return counts;
};

/**
 * The health router: reports that the process is up, which network it
 * serves, and the current pool counts, so an operator can see fund
 * exhaustion without calling the admin endpoint.
 */
export const createHealthRouter = (db: Database.Database, network: string): Router => {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ ok: true, network, pool: poolCounts(db) });
  });
  return router;
};
