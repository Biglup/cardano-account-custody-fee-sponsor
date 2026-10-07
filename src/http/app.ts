import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { LeaseService } from '../pool/leases.js';
import type { ReplenishFn } from '../pool/replenish.js';
import type { PoolSync } from '../pool/sync.js';
import { createAdminRouter } from './admin.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createHealthRouter } from './health.js';
import { type LeaseRouteSettings, createLeaseRouter } from './leases.js';

/** The largest JSON request body the service accepts. */
const JSON_BODY_LIMIT = '64kb';

/** Everything the app factory needs injected, so tests can supply an in memory database, fakes and a quiet logger. */
export interface AppDependencies {
  db: Database.Database;
  logger: Logger;
  network: string;
  adminApiKey: string;
  lease: LeaseRouteSettings;
  leases: LeaseService;
  sync: PoolSync;
  replenish: ReplenishFn;
}

/**
 * Builds the express application. Taking its dependencies as arguments,
 * rather than constructing them here, is what lets tests exercise the
 * real middleware stack against a fake database, provider and logger.
 *
 * The logger passed in must already redact the authorization header; see
 * `src/main.ts` for how the production logger is configured.
 */
export const createApp = ({ db, logger, network, adminApiKey, lease, leases, sync, replenish }: AppDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/health', createHealthRouter(db, network));
  app.use('/v1/leases', createLeaseRouter(db, leases, lease));
  app.use('/admin', createAdminRouter({ db, adminApiKey, sync, leases, replenish }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
