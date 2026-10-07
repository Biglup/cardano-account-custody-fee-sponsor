import type Database from 'better-sqlite3';
import type { Express } from 'express';
import type { UTxO } from '@biglup/cometa';
import pino from 'pino';
import { type Config, loadConfig } from '../../src/config.js';
import { openDatabase } from '../../src/db/connection.js';
import { applyMigrations } from '../../src/db/migrations.js';
import { createApp } from '../../src/http/app.js';
import { type ApiKey, type QuotaOverrides, createApiKey } from '../../src/keys.js';
import { type LeaseService, createLeaseService } from '../../src/pool/leases.js';
import { type ReplenishFn, createReplenish } from '../../src/pool/replenish.js';
import { type PoolSync, createPoolSync } from '../../src/pool/sync.js';
import { type ServiceWallet, loadServiceWallet } from '../../src/wallet.js';
import { FakeProvider } from './fake.js';
import { fakeTransactionId, transactionParts } from './transaction.js';

/** A mnemonic for tests only; it holds nothing on any network. */
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** The admin key the test service is configured with. */
export const TEST_ADMIN_KEY = 'test-admin-key';

/** A logger that writes nothing. */
export const silentLogger = pino({ level: 'silent' });

/** The environment the test service is configured from. */
export const testEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  BLOCKFROST_PREPROD_PROJECT_ID: 'preprodTestProjectId',
  SPONSOR_MNEMONIC: TEST_MNEMONIC,
  ACCOUNT_SCRIPT_HASH: '0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3',
  ADMIN_API_KEY: TEST_ADMIN_KEY,
  ...overrides,
});

/**
 * A fake provider that also accepts submissions: a submitted transaction
 * is recorded, its inputs disappear and its outputs appear at their
 * addresses, as a confirmed transaction would make them on chain.
 */
export class FakeChain extends FakeProvider {
  readonly submitted: string[] = [];

  override submitTransaction(tx: string): Promise<string> {
    const txId = fakeTransactionId(tx);
    const parts = transactionParts(tx);
    for (const input of parts.inputs) {
      this.removeUtxo(input);
    }
    parts.outputs.forEach((output, index) => this.addUtxo({ input: { txId, index }, output }));
    this.submitted.push(tx);
    return Promise.resolve(txId);
  }
}

/** The test service: every component the routes and jobs depend on, built on an in memory database and the fake chain. */
export interface TestService {
  config: Config;
  db: Database.Database;
  provider: FakeChain;
  serviceWallet: ServiceWallet;
  sync: PoolSync;
  leases: LeaseService;
  replenish: ReplenishFn;
  app: Express;
  /** The clock the lease service reads; move it to expire leases. */
  clock: { now: Date };
  /** Issues an API key and returns both the secret and its record. */
  issueKey(label?: string, quotas?: QuotaOverrides): { apiKey: string; record: ApiKey };
  /** Puts a UTxO of `lovelace` at the sponsor address on the fake chain. */
  fund(txId: string, index: number, lovelace: bigint): UTxO;
  close(): void;
}

/** Builds the test service from the test environment, with `overrides` applied to it. */
export const createTestService = async (overrides: Record<string, string> = {}): Promise<TestService> => {
  const config = loadConfig(testEnv(overrides));
  const provider = new FakeChain();
  const serviceWallet = await loadServiceWallet(config, provider);
  const db = openDatabase(':memory:');
  applyMigrations(db);
  const clock = { now: new Date('2024-01-01T00:00:00.000Z') };
  const sync = createPoolSync({ db, provider, sponsorAddress: serviceWallet.address, sizes: config });
  const leases = createLeaseService({ db, sync, settings: config, now: () => clock.now });
  const replenish = createReplenish({ db, provider, serviceWallet, sync, settings: config });
  const app = createApp({
    db,
    logger: silentLogger,
    network: config.network,
    adminApiKey: config.adminApiKey,
    lease: { sponsorAddress: serviceWallet.address, maxSponsoredLovelace: config.maxSponsoredLovelace },
    leases,
    sync,
    replenish,
  });
  return {
    config,
    db,
    provider,
    serviceWallet,
    sync,
    leases,
    replenish,
    app,
    clock,
    issueKey: (label = 'test', quotas = {}) => {
      const issued = createApiKey(db, label, quotas);
      return { apiKey: issued.apiKey, record: issued.record };
    },
    fund: (txId, index, lovelace) => {
      const utxo: UTxO = { input: { txId, index }, output: { address: serviceWallet.address, value: { coins: lovelace } } };
      provider.addUtxo(utxo);
      return utxo;
    },
    close: () => {
      sync.stop();
      leases.stop();
      db.close();
    },
  };
};

/** A fictitious transaction hash, distinct per `n`. */
export const txHash = (n: number): string => n.toString(16).padStart(64, '0');
