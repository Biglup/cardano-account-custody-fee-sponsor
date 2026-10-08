import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadServiceWallet } from '../src/wallet.js';
import { FakeProvider } from './support/fake.js';

const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

const testEnv = (): Record<string, string> => ({
  BLOCKFROST_PREPROD_PROJECT_ID: 'preprodTestProjectId',
  SPONSOR_MNEMONIC: TEST_MNEMONIC,
  ACCOUNT_SCRIPT_HASH: 'ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253',
  ADMIN_API_KEY: 'test-admin-key',
});

describe('loadServiceWallet', () => {
  it('derives the sponsor address and key hashes, and zeroes the mnemonic afterwards', async () => {
    const config = loadConfig(testEnv());
    const provider = new FakeProvider();

    const serviceWallet = await loadServiceWallet(config, provider);

    expect(serviceWallet.address).toMatch(/^addr_test/);
    expect(serviceWallet.paymentKeyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(serviceWallet.stakeKeyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(config.sponsorMnemonic).toEqual([]);
  });

  it('derives the same address for the same mnemonic', async () => {
    const provider = new FakeProvider();
    const first = await loadServiceWallet(loadConfig(testEnv()), provider);
    const second = await loadServiceWallet(loadConfig(testEnv()), provider);

    expect(first.address).toBe(second.address);
    expect(first.paymentKeyHash).toBe(second.paymentKeyHash);
    expect(first.stakeKeyHash).toBe(second.stakeKeyHash);
  });

  it('still zeroes the mnemonic when derivation rejects', async () => {
    const config = loadConfig(testEnv());
    config.sponsorMnemonic = Array.from({ length: 12 }, () => 'zzzznotabip39word');
    const provider = new FakeProvider();

    await expect(loadServiceWallet(config, provider)).rejects.toThrow();
    expect(config.sponsorMnemonic).toEqual([]);
  });
});
