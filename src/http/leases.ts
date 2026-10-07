import type Database from 'better-sqlite3';
import { type RequestHandler, Router } from 'express';
import type { LeaseBody, SponsorUtxoBody, WitnessBody } from '../api.js';
import type { SharedCollateral } from '../pool/collateral.js';
import type { Lease, LeaseService } from '../pool/leases.js';
import type { PoolUtxo } from '../pool/utxo.js';
import type { WitnessService } from '../witness.js';
import { asyncHandler } from './async.js';
import { apiKeyOf, requireApiKey } from './auth.js';
import { parseBody, witnessSchema } from './body.js';

/** What the lease routes need to know about the sponsor. */
export interface LeaseRouteSettings {
  sponsorAddress: string;
  maxSponsoredLovelace: number;
}

/** A sponsor UTxO as the API presents it, at the sponsor address. */
export const toUtxoBody = (utxo: PoolUtxo, address: string): SponsorUtxoBody => ({
  txHash: utxo.txHash,
  index: utxo.index,
  address,
  lovelace: utxo.lovelace,
});

/** The response body for a lease, with the collateral UTxO shared as of the answer. */
export const toLeaseBody = (lease: Lease, collateral: PoolUtxo, settings: LeaseRouteSettings): LeaseBody => ({
  leaseId: lease.id,
  expiresAt: lease.expiresAt,
  fee: toUtxoBody(lease.fee, settings.sponsorAddress),
  collateral: toUtxoBody(collateral, settings.sponsorAddress),
  sponsorAddress: settings.sponsorAddress,
  maxSponsoredLovelace: settings.maxSponsoredLovelace,
});

/**
 * The lease routes under `/v1/leases`: every one requires an API key and
 * counts against that key's rate limit. Creating a lease reserves a fee
 * UTxO for the key and names the shared collateral UTxO alongside it;
 * deleting one releases it early so its fee UTxO returns to the pool;
 * posting a transaction to a lease's witness route has it checked against
 * the policy and, when it passes, signed by the sponsor. A lease created
 * while the shared collateral turns out to be gone is released at once,
 * since the client never learns of it and it would otherwise hold its fee
 * UTxO until it expires.
 */
export const createLeaseRouter = (
  db: Database.Database,
  leases: LeaseService,
  collateral: SharedCollateral,
  witness: WitnessService,
  settings: LeaseRouteSettings,
  keyRateLimit: RequestHandler,
): Router => {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(keyRateLimit);

  router.post(
    '/',
    asyncHandler(async (_req, res) => {
      const apiKey = apiKeyOf(res);
      const lease = await leases.create(apiKey);
      let shared: PoolUtxo;
      try {
        shared = await collateral.require();
      } catch (err) {
        leases.release(apiKey, lease.id);
        throw err;
      }
      res.status(201).json(toLeaseBody(lease, shared, settings));
    }),
  );

  router.delete('/:id', (req, res) => {
    const lease = leases.release(apiKeyOf(res), req.params.id ?? '');
    res.json({ leaseId: lease.id, status: lease.status });
  });

  router.post(
    '/:id/witness',
    asyncHandler(async (req, res) => {
      const { transaction } = parseBody(witnessSchema, req.body);
      const issued = await witness.issue(apiKeyOf(res), req.params.id ?? '', transaction);
      const body: WitnessBody = { witnessSet: issued.witnessSet, leaseId: issued.leaseId };
      res.json(body);
    }),
  );

  return router;
};
