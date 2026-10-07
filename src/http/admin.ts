import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import { createApiKey, quotasSchema } from '../keys.js';
import type { LeaseService } from '../pool/leases.js';
import type { ReplenishFn } from '../pool/replenish.js';
import type { PoolSync } from '../pool/sync.js';
import { type PoolUtxoRow, toPoolUtxo } from '../pool/utxo.js';
import { asyncHandler } from './async.js';
import { requireAdminKey } from './auth.js';
import { ValidationError } from './errors.js';
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

/** What the admin routes need injected. */
export interface AdminDependencies {
  db: Database.Database;
  adminApiKey: string;
  sync: PoolSync;
  leases: LeaseService;
  replenish: ReplenishFn;
}

/** Parses a request body against `schema`, reporting the first issue as a validation error. */
const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
};

/**
 * The admin routes under `/admin`: every one requires the admin key.
 * Keys are issued here and shown once; the pool can be inspected and
 * replenished from the sponsor wallet.
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
    res.json({
      pool: poolCounts(db),
      reserve: { utxos: reserve.utxos.length, lovelace: reserve.lovelace.toString(), syncedAt: reserve.syncedAt ?? null },
      leases: { open: openLeases },
      utxos,
    });
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
