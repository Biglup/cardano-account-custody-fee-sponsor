import type { UTxO } from '@biglup/cometa';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { type ApiKey, type QuotaOverrides, createApiKey } from '../../src/keys.js';
import { type Service, createService } from '../../src/service.js';
import { FakeProvider } from './fake.js';
import { fakeTransactionId, transactionParts } from './transaction.js';

/** A mnemonic for tests only; it holds nothing on any network. */
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

/** The admin key the test service is configured with. */
export const TEST_ADMIN_KEY = 'test-admin-key';

/** A logger that writes nothing. */
export const silentLogger = pino({ level: 'silent' });

/** The environment the test service is configured from: fake credentials and a database that lives only for the test. */
export const testEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  BLOCKFROST_PREPROD_PROJECT_ID: 'preprodTestProjectId',
  SPONSOR_MNEMONIC: TEST_MNEMONIC,
  ACCOUNT_SCRIPT_HASH: '0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3',
  ADMIN_API_KEY: TEST_ADMIN_KEY,
  DATABASE_PATH: ':memory:',
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

/** The test service: the real composition on an in memory database and the fake chain, with a clock the tests move. */
export interface TestService extends Omit<Service, 'provider' | 'start' | 'stop'> {
  provider: FakeChain;
  /** The clock the lease service, the witness service and the pool sync read; move it to expire leases and to pass validity bounds. */
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
  const clock = { now: new Date('2024-01-01T00:00:00.000Z') };
  const service = await createService({ config, provider, logger: silentLogger, now: () => clock.now });
  return {
    config: service.config,
    db: service.db,
    provider,
    serviceWallet: service.serviceWallet,
    sync: service.sync,
    leases: service.leases,
    witness: service.witness,
    replenish: service.replenish,
    app: service.app,
    clock,
    issueKey: (label = 'test', quotas = {}) => {
      const issued = createApiKey(service.db, label, quotas);
      return { apiKey: issued.apiKey, record: issued.record };
    },
    fund: (txId, index, lovelace) => {
      const utxo: UTxO = { input: { txId, index }, output: { address: service.serviceWallet.address, value: { coins: lovelace } } };
      provider.addUtxo(utxo);
      return utxo;
    },
    close: () => service.stop(),
  };
};

/** A fictitious transaction hash, distinct per `n`. */
export const txHash = (n: number): string => n.toString(16).padStart(64, '0');
