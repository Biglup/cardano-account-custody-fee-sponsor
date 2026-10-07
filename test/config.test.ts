import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const VALID_MNEMONIC = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

const validEnv = (): Record<string, string> => ({
  BLOCKFROST_PREPROD_PROJECT_ID: 'preprodTestProjectId',
  SPONSOR_MNEMONIC: VALID_MNEMONIC,
  ACCOUNT_SCRIPT_HASH: '0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3',
  ADMIN_API_KEY: 'test-admin-key',
});

describe('loadConfig', () => {
  it('parses a complete environment and fills in the documented defaults', () => {
    const config = loadConfig(validEnv());

    expect(config.network).toBe('preprod');
    expect(config.blockfrostProjectId).toBe('preprodTestProjectId');
    expect(config.sponsorMnemonic).toEqual(VALID_MNEMONIC.split(' '));
    expect(config.accountScriptHash).toBe('0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3');
    expect(config.adminApiKey).toBe('test-admin-key');
    expect(config.port).toBe(8787);
    expect(config.databasePath).toBe('./data/sponsor.sqlite');
    expect(config.leaseTtlSeconds).toBe(600);
    expect(config.maxSponsoredLovelace).toBe(6_000_000);
    expect(config.maxFeeLovelace).toBe(2_000_000);
    expect(config.collateralSharing).toBe(20);
    expect(config.feeUtxoLovelace).toBe(100_000_000);
    expect(config.collateralUtxoLovelace).toBe(5_000_000);
  });

  it('honours overrides for the operational tunables', () => {
    const config = loadConfig({ ...validEnv(), PORT: '9000', LEASE_TTL_SECONDS: '120', MAX_FEE_LOVELACE: '1000000' });

    expect(config.port).toBe(9000);
    expect(config.leaseTtlSeconds).toBe(120);
    expect(config.maxFeeLovelace).toBe(1_000_000);
  });

  it('fails with a clear message when SPONSOR_MNEMONIC is missing, without echoing any value', () => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>).SPONSOR_MNEMONIC;

    try {
      loadConfig(env);
      expect.unreachable('loadConfig should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('SPONSOR_MNEMONIC');
      expect(message).not.toContain(env.BLOCKFROST_PREPROD_PROJECT_ID);
    }
  });

  it('rejects a mnemonic with the wrong word count, without echoing the value in the message', () => {
    const badMnemonic = Array.from({ length: 13 }, () => 'word').join(' ');
    try {
      loadConfig({ ...validEnv(), SPONSOR_MNEMONIC: badMnemonic });
      expect.unreachable('loadConfig should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('SPONSOR_MNEMONIC must have 12, 15, 18, 21 or 24 lowercase words');
      expect(message).not.toContain(badMnemonic);
    }
  });

  it('rejects a mnemonic with uppercase or non alphabetic words', () => {
    const badMnemonic = Array.from({ length: 12 }, () => 'Word1').join(' ');
    expect(() => loadConfig({ ...validEnv(), SPONSOR_MNEMONIC: badMnemonic })).toThrow(
      /SPONSOR_MNEMONIC must have 12, 15, 18, 21 or 24 lowercase words/,
    );
  });

  it('rejects a malformed ACCOUNT_SCRIPT_HASH', () => {
    expect(() => loadConfig({ ...validEnv(), ACCOUNT_SCRIPT_HASH: 'not-a-hash' })).toThrow(/ACCOUNT_SCRIPT_HASH/);
  });
});
