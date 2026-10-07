import type Database from 'better-sqlite3';
import { Router } from 'express';
import { z } from 'zod';
import type { Lease, LeaseService } from '../pool/leases.js';
import type { PoolUtxo } from '../pool/utxo.js';
import type { WitnessService } from '../witness.js';
import { asyncHandler } from './async.js';
import { apiKeyOf, requireApiKey } from './auth.js';
import { parseBody } from './body.js';

/** The body of a witness request: the unsigned transaction as CBOR hex; whether it decodes is the policy's first rule. */
const witnessSchema = z.object({ transaction: z.string().min(1) }).strict();

/** A leased UTxO as the API presents it, with the address the client must resolve it at. */
export interface LeasedUtxoBody {
  txHash: string;
  index: number;
  address: string;
  lovelace: number;
}

/** The body of a lease response. */
export interface LeaseBody {
  leaseId: string;
  expiresAt: string;
  fee: LeasedUtxoBody;
  collateral: LeasedUtxoBody;
  sponsorAddress: string;
  maxSponsoredLovelace: number;
}

/** What the lease routes need to know about the sponsor. */
export interface LeaseRouteSettings {
  sponsorAddress: string;
  maxSponsoredLovelace: number;
}

const toUtxoBody = (utxo: PoolUtxo, address: string): LeasedUtxoBody => ({
  txHash: utxo.txHash,
  index: utxo.index,
  address,
  lovelace: utxo.lovelace,
});

/** The response body for a lease. */
export const toLeaseBody = (lease: Lease, settings: LeaseRouteSettings): LeaseBody => ({
  leaseId: lease.id,
  expiresAt: lease.expiresAt,
  fee: toUtxoBody(lease.fee, settings.sponsorAddress),
  collateral: toUtxoBody(lease.collateral, settings.sponsorAddress),
  sponsorAddress: settings.sponsorAddress,
  maxSponsoredLovelace: settings.maxSponsoredLovelace,
});

/**
 * The lease routes under `/v1/leases`: every one requires an API key.
 * Creating a lease reserves a fee and a collateral UTxO for the key;
 * deleting one releases it early so its UTxOs return to the pool; posting
 * a transaction to a lease's witness route has it checked against the
 * policy and, when it passes, signed by the sponsor.
 */
export const createLeaseRouter = (
  db: Database.Database,
  leases: LeaseService,
  witness: WitnessService,
  settings: LeaseRouteSettings,
): Router => {
  const router = Router();
  router.use(requireApiKey(db));

  router.post(
    '/',
    asyncHandler(async (_req, res) => {
      const lease = await leases.create(apiKeyOf(res));
      res.status(201).json(toLeaseBody(lease, settings));
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
      res.json({ witnessSet: issued.witnessSet, leaseId: issued.leaseId });
    }),
  );

  return router;
};
