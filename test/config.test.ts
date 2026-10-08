import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_LOGIC_HASH, ConfigError, LOGIC_V2_HASH, loadConfig } from '../src/config.js';
import { SLOT_SETTINGS_BY_NETWORK } from '../src/slots.js';

const VALID_MNEMONIC = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';

/** The blueprint the service ships with, at the repository root whatever the working directory. */
const SHIPPED_BLUEPRINT_PATH = resolve(import.meta.dirname, '..', 'contract', 'plutus.json');

/** The example environment file an operator copies before filling in the required variables. */
const EXAMPLE_ENV_PATH = resolve(import.meta.dirname, '..', '.env.example');

/** What the example environment file sets a variable to, and nothing when it does not set it. */
const exampleValueOf = (name: string): string | undefined =>
  readFileSync(EXAMPLE_ENV_PATH, 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const validEnv = (): Record<string, string> => ({
  BLOCKFROST_PREPROD_PROJECT_ID: 'preprodTestProjectId',
  SPONSOR_MNEMONIC: VALID_MNEMONIC,
  ACCOUNT_SCRIPT_HASH: 'ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253',
  ADMIN_API_KEY: 'test-admin-key',
});

/** The environment without the project id, as a deployment behind a proxy that supplies its own has it. */
const envWithoutProjectId = (): Record<string, string> => {
  const env = validEnv();
  delete (env as Record<string, string | undefined>).BLOCKFROST_PREPROD_PROJECT_ID;
  return env;
};

/** A proxy endpoint for preprod: the proxy's base, the surface its operators allocated to the service, the network and the API version. */
const PROXY_ENDPOINT = 'https://proxy.example/sponsor/preprod/api/v0';

describe('loadConfig', () => {
  it('reaches the hosted preprod endpoint with the project id when no endpoint is configured', () => {
    const config = loadConfig(validEnv());

    expect(config.blockfrostProjectId).toBe('preprodTestProjectId');
    expect(config.blockfrostBaseUrl).toBeUndefined();
  });

  it('reaches a configured endpoint with no project id, as a proxy that supplies its own needs none', () => {
    const config = loadConfig({ ...envWithoutProjectId(), PROVIDER_BASE_URL: PROXY_ENDPOINT });

    expect(config.blockfrostProjectId).toBeUndefined();
    expect(config.blockfrostBaseUrl).toBe(PROXY_ENDPOINT);
  });

  it('reaches a configured endpoint with the project id when both are set', () => {
    const config = loadConfig({ ...validEnv(), PROVIDER_BASE_URL: 'http://localhost:8080/api/v1' });

    expect(config.blockfrostProjectId).toBe('preprodTestProjectId');
    expect(config.blockfrostBaseUrl).toBe('http://localhost:8080/api/v1');
  });

  it('refuses an environment with neither a project id nor an endpoint, naming both variables', () => {
    expect(() => loadConfig(envWithoutProjectId())).toThrow(
      /BLOCKFROST_PREPROD_PROJECT_ID: BLOCKFROST_PREPROD_PROJECT_ID is required unless PROVIDER_BASE_URL names a Blockfrost compatible endpoint that needs no project id/,
    );
  });

  it('reads a blank project id or a blank endpoint as unset, as an environment file with an empty line for it gives', () => {
    expect(loadConfig({ ...validEnv(), BLOCKFROST_PREPROD_PROJECT_ID: '', PROVIDER_BASE_URL: PROXY_ENDPOINT }).blockfrostProjectId).toBeUndefined();
    expect(loadConfig({ ...validEnv(), PROVIDER_BASE_URL: '' }).blockfrostBaseUrl).toBeUndefined();
    expect(() => loadConfig({ ...validEnv(), BLOCKFROST_PREPROD_PROJECT_ID: '', PROVIDER_BASE_URL: '' })).toThrow(/BLOCKFROST_PREPROD_PROJECT_ID is required unless PROVIDER_BASE_URL/);
  });

  it('refuses an endpoint that is not a URL', () => {
    expect(() => loadConfig({ ...validEnv(), PROVIDER_BASE_URL: 'not a url' })).toThrow(/PROVIDER_BASE_URL must be a URL/);
  });

  it('parses a complete environment and fills in the documented defaults', () => {
    const config = loadConfig(validEnv());

    expect(config.network).toBe('preprod');
    expect(config.blockfrostProjectId).toBe('preprodTestProjectId');
    expect(config.blockfrostBaseUrl).toBeUndefined();
    expect(config.sponsorMnemonic).toEqual(VALID_MNEMONIC.split(' '));
    expect(config.accountScriptHash).toBe('ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253');
    expect(config.knownLogicHashes).toEqual([CURRENT_LOGIC_HASH, LOGIC_V2_HASH]);
    expect(config.adminApiKey).toBe('test-admin-key');
    expect(config.port).toBe(8787);
    expect(config.databasePath).toBe('./data/sponsor.sqlite');
    expect(config.blueprintPath).toBe(SHIPPED_BLUEPRINT_PATH);
    expect(config.leaseTtlSeconds).toBe(600);
    expect(config.maxSponsoredLovelace).toBe(6_000_000);
    expect(config.maxFeeLovelace).toBe(2_000_000);
    expect(config.feeUtxoLovelace).toBe(100_000_000);
    expect(config.collateralUtxoLovelace).toBe(5_000_000);
    expect(config.feeUtxoCount).toBe(10);
    expect(config.collateralUtxoCount).toBe(2);
    expect(config.slots).toEqual(SLOT_SETTINGS_BY_NETWORK.preprod);
    expect(config.validityMarginSeconds).toBe(120);
    expect(config.collateralValiditySeconds).toBe(600);
    expect(config.ipRateLimitPerMinute).toBe(120);
    expect(config.keyRateLimitPerMinute).toBe(60);
    expect(config.trustProxyHops).toBe(0);
  });

  it('honours overrides for the operational tunables', () => {
    const config = loadConfig({
      ...validEnv(),
      PORT: '9000',
      BLUEPRINT_PATH: './build/plutus.json',
      LEASE_TTL_SECONDS: '120',
      MAX_FEE_LOVELACE: '1000000',
      VALIDITY_MARGIN_SECONDS: '0',
      COLLATERAL_VALIDITY_SECONDS: '300',
      IP_RATE_LIMIT_PER_MINUTE: '10',
      KEY_RATE_LIMIT_PER_MINUTE: '5',
      TRUST_PROXY_HOPS: '1',
    });

    expect(config.port).toBe(9000);
    expect(config.blueprintPath).toBe('./build/plutus.json');
    expect(config.leaseTtlSeconds).toBe(120);
    expect(config.maxFeeLovelace).toBe(1_000_000);
    expect(config.validityMarginSeconds).toBe(0);
    expect(config.collateralValiditySeconds).toBe(300);
    expect(config.ipRateLimitPerMinute).toBe(10);
    expect(config.keyRateLimitPerMinute).toBe(5);
    expect(config.trustProxyHops).toBe(1);
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

  it('rejects fee and collateral sizes within 10 percent of each other, which the pool could never tell apart', () => {
    expect(() => loadConfig({ ...validEnv(), FEE_UTXO_LOVELACE: '10000000', COLLATERAL_UTXO_LOVELACE: '9500000' })).toThrow(
      /COLLATERAL_UTXO_LOVELACE: FEE_UTXO_LOVELACE and COLLATERAL_UTXO_LOVELACE must differ by more than 10 percent/,
    );
    expect(() => loadConfig({ ...validEnv(), FEE_UTXO_LOVELACE: '5000000', COLLATERAL_UTXO_LOVELACE: '5000000' })).toThrow(/differ by more than 10 percent/);
    expect(() => loadConfig({ ...validEnv(), FEE_UTXO_LOVELACE: '5000000', COLLATERAL_UTXO_LOVELACE: '5500000' })).toThrow(/differ by more than 10 percent/);
    expect(loadConfig({ ...validEnv(), FEE_UTXO_LOVELACE: '10000000', COLLATERAL_UTXO_LOVELACE: '8000000' }).collateralUtxoLovelace).toBe(8_000_000);
  });

  it('rejects a malformed ACCOUNT_SCRIPT_HASH', () => {
    expect(() => loadConfig({ ...validEnv(), ACCOUNT_SCRIPT_HASH: 'not-a-hash' })).toThrow(/ACCOUNT_SCRIPT_HASH/);
  });

  it('reads KNOWN_LOGIC_HASHES as a comma separated list, trimmed, and rejects an empty, malformed or repeating one', () => {
    const second = '11'.repeat(28);

    expect(loadConfig({ ...validEnv(), KNOWN_LOGIC_HASHES: ` ${CURRENT_LOGIC_HASH} , ${second} ,` }).knownLogicHashes).toEqual([CURRENT_LOGIC_HASH, second]);
    expect(() => loadConfig({ ...validEnv(), KNOWN_LOGIC_HASHES: ' , ' })).toThrow(/KNOWN_LOGIC_HASHES must name at least one logic script hash/);
    expect(() => loadConfig({ ...validEnv(), KNOWN_LOGIC_HASHES: `${CURRENT_LOGIC_HASH},nonsense` })).toThrow(
      /KNOWN_LOGIC_HASHES must be 56 character hex script hashes separated by commas/,
    );
    expect(() => loadConfig({ ...validEnv(), KNOWN_LOGIC_HASHES: `${CURRENT_LOGIC_HASH},${CURRENT_LOGIC_HASH}` })).toThrow(
      /KNOWN_LOGIC_HASHES must not name the same logic script hash twice/,
    );
  });

  it('is offered the same two logic hashes by the example environment file, the version new accounts run first', () => {
    const example = exampleValueOf('KNOWN_LOGIC_HASHES');

    expect(example).toBe(`${CURRENT_LOGIC_HASH},${LOGIC_V2_HASH}`);
    expect(loadConfig({ ...validEnv(), KNOWN_LOGIC_HASHES: example }).knownLogicHashes).toEqual([CURRENT_LOGIC_HASH, LOGIC_V2_HASH]);
  });
});
