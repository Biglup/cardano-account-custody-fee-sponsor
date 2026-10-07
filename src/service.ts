import type Database from 'better-sqlite3';
import type { Provider } from '@biglup/cometa';
import type { Express } from 'express';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { openDatabase } from './db/connection.js';
import { applyMigrations } from './db/migrations.js';
import { createApp } from './http/app.js';
import { type SharedCollateral, createSharedCollateral } from './pool/collateral.js';
import { type LeaseService, createLeaseService } from './pool/leases.js';
import { type ReplenishFn, createReplenish } from './pool/replenish.js';
import { type PoolSync, createPoolSync } from './pool/sync.js';
import { type WitnessStore, createWitnessStore } from './pool/witnesses.js';
import { bindSponsorAddress } from './sponsor.js';
import { type ServiceWallet, loadServiceWallet } from './wallet.js';
import { type WitnessService, createWitnessService } from './witness.js';

/** Everything the service is assembled from; `now` lets tests move the clock every component reads. */
export interface ServiceDependencies {
  config: Config;
  provider: Provider;
  logger: Logger;
  now?: () => Date;
}

/** The assembled service: every component the routes and jobs depend on, and the jobs' lifecycle. */
export interface Service {
  config: Config;
  db: Database.Database;
  provider: Provider;
  serviceWallet: ServiceWallet;
  sync: PoolSync;
  collateral: SharedCollateral;
  witnesses: WitnessStore;
  leases: LeaseService;
  witness: WitnessService;
  replenish: ReplenishFn;
  app: Express;
  /** Reconciles the pool with the chain once and starts the periodic sync and the lease sweep. */
  start(): Promise<void>;
  /** Stops the periodic jobs and closes the database. */
  stop(): void;
}

/**
 * Assembles the service from its configuration and a provider: the
 * sponsor wallet derived from the mnemonic, which is wiped from the
 * configuration in the process, the database at the configured path with
 * its migrations applied and bound to the sponsor address, which refuses
 * a database of another sponsor, the pool sync, the shared collateral, the
 * witness store, the lease, replenish and witness services, and the
 * express application over them. Nothing is started;
 * the caller starts the jobs and listens where it sees fit, which is what
 * lets the same composition serve the process, the test suite and a
 * script that runs the service in its own process.
 */
export const createService = async ({ config, provider, logger, now = () => new Date() }: ServiceDependencies): Promise<Service> => {
  let serviceWallet: ServiceWallet;
  try {
    serviceWallet = await loadServiceWallet(config, provider);
  } catch {
    throw new Error('Failed to derive the sponsor wallet from SPONSOR_MNEMONIC');
  }

  const db = openDatabase(config.databasePath);
  applyMigrations(db, now());
  try {
    bindSponsorAddress(db, serviceWallet.address, now());
  } catch (err) {
    db.close();
    throw err;
  }

  const sync = createPoolSync({ db, provider, sponsorAddress: serviceWallet.address, sizes: config, slots: config.slots, now, logger });
  const collateral = createSharedCollateral({ db, sync, settings: config });
  const witnesses = createWitnessStore({ db, now });
  const leases = createLeaseService({ db, sync, witnesses, settings: config, now, logger });
  const replenish = createReplenish({ db, provider, serviceWallet, sync, settings: config, logger });
  const witness = createWitnessService({ db, provider, serviceWallet, leases, witnesses, collateral, settings: config, now, logger });

  const app = createApp({
    db,
    logger,
    network: config.network,
    adminApiKey: config.adminApiKey,
    rateLimit: config,
    lease: { sponsorAddress: serviceWallet.address, maxSponsoredLovelace: config.maxSponsoredLovelace },
    collateralSettings: { sponsorAddress: serviceWallet.address, collateralValiditySeconds: config.collateralValiditySeconds },
    leases,
    collateral,
    witness,
    sync,
    replenish,
    now,
  });

  return {
    config,
    db,
    provider,
    serviceWallet,
    sync,
    collateral,
    witnesses,
    leases,
    witness,
    replenish,
    app,
    start: async () => {
      await sync.run();
      sync.start();
      leases.start();
    },
    stop: () => {
      sync.stop();
      leases.stop();
      db.close();
    },
  };
};
