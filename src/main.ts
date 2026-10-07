import { config as loadEnvFile } from 'dotenv';
import pino from 'pino';
import { Cometa } from './cometa.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { applyMigrations } from './db/migrations.js';
import { createApp } from './http/app.js';
import { createLeaseService } from './pool/leases.js';
import { createReplenish } from './pool/replenish.js';
import { createPoolSync } from './pool/sync.js';
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

  const sync = createPoolSync({ db, provider, sponsorAddress: serviceWallet.address, sizes: config, logger });
  const leases = createLeaseService({ db, sync, settings: config, logger });
  const replenish = createReplenish({ db, provider, serviceWallet, sync, settings: config, logger });

  await sync.run();
  sync.start();
  leases.start();

  const app = createApp({
    db,
    logger,
    network: config.network,
    adminApiKey: config.adminApiKey,
    lease: { sponsorAddress: serviceWallet.address, maxSponsoredLovelace: config.maxSponsoredLovelace },
    leases,
    sync,
    replenish,
  });

  app.listen(config.port, () => {
    logger.info({ port: config.port, address: serviceWallet.address }, 'Fee sponsor service listening');
  });
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : 'Unknown startup error';
  console.error(`Fee sponsor service failed to start: ${message}`);
  process.exit(1);
});
