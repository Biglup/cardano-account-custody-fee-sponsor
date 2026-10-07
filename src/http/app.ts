import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from '../config.js';
import type { SharedCollateral } from '../pool/collateral.js';
import type { LeaseService } from '../pool/leases.js';
import type { ReplenishFn } from '../pool/replenish.js';
import type { PoolSync } from '../pool/sync.js';
import type { WitnessService } from '../witness.js';
import { createAdminRouter } from './admin.js';
import { type CollateralRouteSettings, createCollateralRouter } from './collateral.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './health.js';
import { type LeaseRouteSettings, createLeaseRouter } from './leases.js';
import { ipRateLimiter, keyRateLimiter } from './rate-limit.js';

/** The largest JSON request body the service accepts. */
const JSON_BODY_LIMIT = '64kb';

/** The tunables that bound how often the service answers one caller, and how it tells callers apart behind a proxy. */
export type RateLimitSettings = Pick<Config, 'ipRateLimitPerMinute' | 'keyRateLimitPerMinute' | 'trustProxyHops'>;

/** Everything the app factory needs injected, so tests can supply an in memory database, fakes and a quiet logger. */
export interface AppDependencies {
  db: Database.Database;
  logger: Logger;
  network: string;
  adminApiKey: string;
  rateLimit: RateLimitSettings;
  lease: LeaseRouteSettings;
  collateralSettings: CollateralRouteSettings;
  leases: LeaseService;
  collateral: SharedCollateral;
  witness: WitnessService;
  sync: PoolSync;
  replenish: ReplenishFn;
  /** The clock the admin routes issue and disable keys by. */
  now: () => Date;
}

/**
 * Builds the express application. Taking its dependencies as arguments,
 * rather than constructing them here, is what lets tests exercise the
 * real middleware stack against a fake database, provider and logger.
 *
 * The logger passed in must already redact the authorization header; see
 * `src/logger.ts` for how the production logger is configured.
 *
 * Every request counts against its address's rate limit before anything
 * else reads it, so an unauthenticated flood is refused as cheaply as
 * possible. The address is read from the forwarded headers only for the
 * configured number of proxy hops, since trusting every hop would let any
 * caller choose the address it is limited as.
 */
export const createApp = ({
  db,
  logger,
  network,
  adminApiKey,
  rateLimit,
  lease,
  collateralSettings,
  leases,
  collateral,
  witness,
  sync,
  replenish,
  now,
}: AppDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');
  if (rateLimit.trustProxyHops > 0) {
    app.set('trust proxy', rateLimit.trustProxyHops);
  }
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(ipRateLimiter(rateLimit.ipRateLimitPerMinute));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/health', createHealthRouter(db, network));
  const keyRateLimit = keyRateLimiter(rateLimit.keyRateLimitPerMinute);
  app.use('/v1/leases', createLeaseRouter(db, leases, collateral, witness, lease, keyRateLimit));
  app.use('/v1/collateral', createCollateralRouter(db, collateral, witness, collateralSettings, keyRateLimit));
  app.use('/admin', createAdminRouter({ db, adminApiKey, sync, leases, replenish, now }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
