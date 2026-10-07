import type Database from 'better-sqlite3';
import { Router } from 'express';
import type { Lease, LeaseService } from '../pool/leases.js';
import type { PoolUtxo } from '../pool/utxo.js';
import { asyncHandler } from './async.js';
import { apiKeyOf, requireApiKey } from './auth.js';

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
 * deleting one releases it early so its UTxOs return to the pool.
 */
export const createLeaseRouter = (db: Database.Database, leases: LeaseService, settings: LeaseRouteSettings): Router => {
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

  return router;
};
