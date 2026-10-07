import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import { type AuditRow, toAuditEntry } from '../audit.js';
import { createApiKey, quotasSchema } from '../keys.js';
import { designatedCollateral } from '../pool/collateral.js';
import type { LeaseService } from '../pool/leases.js';
import type { ReplenishFn } from '../pool/replenish.js';
import type { PoolSync } from '../pool/sync.js';
import { type PoolUtxoRow, toPoolUtxo } from '../pool/utxo.js';
import { asyncHandler } from './async.js';
import { requireAdminKey } from './auth.js';
import { parseBody } from './body.js';
import { poolCounts } from './health.js';

/** The body of a key issuance request: a label to recognise the key by, and optional quota overrides. */
const createKeySchema = z.object({ label: z.string().trim().min(1).max(100), quotas: quotasSchema.optional() }).strict();

/** The body of a replenish request; every field is optional and defaults to the configuration. */
const replenishSchema = z
  .object({
    feeUtxoLovelace: z.number().int().positive().optional(),
    feeUtxoCount: z.number().int().min(0).optional(),
    collateralLovelace: z.number().int().positive().optional(),
    collateralCount: z.number().int().min(0).optional(),
  })
  .strict();

/** The most audit entries one request returns, and how many it returns when asked for no particular number. */
const AUDIT_PAGE_LIMIT = 1000;
const AUDIT_PAGE_DEFAULT = 100;

/**
 * The query of an audit request: entries at or after `since`, at most
 * `limit` of them, oldest first. `since` may carry an offset or omit the
 * fraction, and is brought to the UTC millisecond form the trail stores,
 * since the comparison is on text.
 */
const auditQuerySchema = z
  .object({
    since: z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
    limit: z.coerce.number().int().positive().max(AUDIT_PAGE_LIMIT).default(AUDIT_PAGE_DEFAULT),
  })
  .strict();

/** What the admin routes need injected. */
export interface AdminDependencies {
  db: Database.Database;
  adminApiKey: string;
  sync: PoolSync;
  leases: LeaseService;
  replenish: ReplenishFn;
}

/**
 * The admin routes under `/admin`: every one requires the admin key.
 * Keys are issued here and shown once; the pool can be inspected, with
 * the collateral UTxO currently shared and when it was chosen, and
 * replenished from the sponsor wallet; the audit trail can be read back
 * from a point in time, so an operator can follow what every key did.
 */
export const createAdminRouter = ({ db, adminApiKey, sync, leases, replenish }: AdminDependencies): Router => {
  const router = Router();
  router.use(requireAdminKey(adminApiKey));

  router.post('/keys', (req, res) => {
    const { label, quotas } = parseBody(createKeySchema, req.body);
    const issued = createApiKey(db, label, quotas);
    res.status(201).json({ apiKey: issued.apiKey, id: issued.record.id, label: issued.record.label, quotas: issued.record.quotas });
  });

  router.get('/pool', (_req, res) => {
    leases.expireStale();
    const reserve = sync.reserve();
    const utxos = (db.prepare("SELECT * FROM pool_utxos WHERE status IN ('free', 'leased') ORDER BY kind, discovered_at").all() as PoolUtxoRow[]).map(
      toPoolUtxo,
    );
    const openLeases = (db.prepare("SELECT COUNT(*) AS count FROM leases WHERE status = 'open'").get() as { count: number }).count;
    const designated = designatedCollateral(db);
    res.json({
      pool: poolCounts(db),
      reserve: { utxos: reserve.utxos.length, lovelace: reserve.lovelace.toString(), syncedAt: reserve.syncedAt ?? null },
      leases: { open: openLeases },
      sharedCollateral:
        designated === undefined || designated.utxo.status !== 'free'
          ? null
          : { txHash: designated.utxo.txHash, index: designated.utxo.index, lovelace: designated.utxo.lovelace, chosenAt: designated.chosenAt },
      utxos,
    });
  });

  router.get('/audit', (req, res) => {
    const { since, limit } = parseBody(auditQuerySchema, req.query);
    const rows = db
      .prepare('SELECT id, ts, api_key_id, action, outcome, detail FROM audit WHERE ts >= ? ORDER BY id LIMIT ?')
      .all(since ?? '', limit) as AuditRow[];
    res.json({ entries: rows.map(toAuditEntry) });
  });

  router.post(
    '/pool/replenish',
    asyncHandler(async (req, res) => {
      const request = parseBody(replenishSchema, req.body);
      const result = await replenish(request);
      res.json({
        txId: result.txId ?? null,
        feeOutputs: result.feeOutputs,
        collateralOutputs: result.collateralOutputs,
        reserveLovelace: result.reserveLovelace.toString(),
      });
    }),
  );

  return router;
};
