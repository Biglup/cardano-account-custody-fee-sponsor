import type Database from 'better-sqlite3';
import { type RequestHandler, Router } from 'express';
import type { CollateralBody, CollateralWitnessBody } from '../api.js';
import type { SharedCollateral } from '../pool/collateral.js';
import type { WitnessService } from '../witness.js';
import { asyncHandler } from './async.js';
import { apiKeyOf, requireApiKey } from './auth.js';
import { parseBody, witnessSchema } from './body.js';
import { toUtxoBody } from './leases.js';

/** What the collateral routes need to know about the sponsor: its address and how far from now a bound may reach. */
export interface CollateralRouteSettings {
  sponsorAddress: string;
  collateralValiditySeconds: number;
}

/**
 * The collateral routes under `/v1/collateral`: every one requires an API
 * key and counts against that key's rate limit. Reading the route names
 * the shared collateral UTxO, for a client whose transaction pays its
 * own fee and needs collateral alone; posting a transaction to the
 * witness route has it checked against the policy in collateral mode
 * and, when it passes, signed by the sponsor. No lease is involved.
 */
export const createCollateralRouter = (
  db: Database.Database,
  collateral: SharedCollateral,
  witness: WitnessService,
  settings: CollateralRouteSettings,
  keyRateLimit: RequestHandler,
): Router => {
  const router = Router();
  router.use(requireApiKey(db));
  router.use(keyRateLimit);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const shared = await collateral.require();
      const body: CollateralBody = {
        ...toUtxoBody(shared, settings.sponsorAddress),
        sponsorAddress: settings.sponsorAddress,
        validitySeconds: settings.collateralValiditySeconds,
      };
      res.json(body);
    }),
  );

  router.post(
    '/witness',
    asyncHandler(async (req, res) => {
      const { transaction } = parseBody(witnessSchema, req.body);
      const issued = await witness.issueCollateral(apiKeyOf(res), transaction);
      const body: CollateralWitnessBody = { witnessSet: issued.witnessSet, txHash: issued.txHash };
      res.json(body);
    }),
  );

  return router;
};
