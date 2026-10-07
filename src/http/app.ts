import type Database from 'better-sqlite3';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { createHealthRouter } from './health.js';
import { errorHandler, notFoundHandler } from './errors.js';

/** The largest JSON request body the service accepts. */
const JSON_BODY_LIMIT = '64kb';

/** Everything the app factory needs injected, so tests can supply an in memory database and a quiet logger. */
export interface AppDependencies {
  db: Database.Database;
  logger: Logger;
  network: string;
}

/**
 * Builds the express application. Taking its dependencies as arguments,
 * rather than constructing them here, is what lets tests exercise the
 * real middleware stack against a fake database and logger.
 *
 * The logger passed in must already redact the authorization header; see
 * `src/main.ts` for how the production logger is configured.
 */
export const createApp = ({ db, logger, network }: AppDependencies): Express => {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/health', createHealthRouter(db, network));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
