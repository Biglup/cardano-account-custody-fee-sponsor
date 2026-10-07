import { config as loadEnvFile } from 'dotenv';
import pino from 'pino';
import { Cometa } from './cometa.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { applyMigrations } from './db/migrations.js';
import { createApp } from './http/app.js';
import { loadServiceWallet } from './wallet.js';

loadEnvFile({ quiet: true });

/** The logger every part of the service uses. The authorization header is redacted so a bearer key can never reach a log line. */
const createLogger = (): pino.Logger =>
  pino({
    redact: { paths: ['req.headers.authorization'], censor: '[redacted]' },
  });

const main = async (): Promise<void> => {
  const logger = createLogger();
  const config = loadConfig();
  delete process.env.SPONSOR_MNEMONIC;
  delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  delete process.env.ADMIN_API_KEY;

  await Cometa.ready();

  const provider = new Cometa.BlockfrostProvider({
    network: Cometa.NetworkMagic.Preprod,
    projectId: config.blockfrostProjectId,
  });

  let serviceWallet;
  try {
    serviceWallet = await loadServiceWallet(config, provider);
  } catch {
    throw new Error('Failed to derive the sponsor wallet from SPONSOR_MNEMONIC');
  }

  const db = openDatabase(config.databasePath);
  applyMigrations(db);

  const app = createApp({ db, logger, network: config.network });

  app.listen(config.port, () => {
    logger.info({ port: config.port, address: serviceWallet.address }, 'Fee sponsor service listening');
  });
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown startup error';
  console.error(`Fee sponsor service failed to start: ${message}`);
  process.exit(1);
});
