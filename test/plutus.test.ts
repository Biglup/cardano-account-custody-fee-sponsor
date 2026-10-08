import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_LOGIC_HASH, LOGIC_V2_HASH } from '../src/config.js';
import { AIKEN_APPLIED_STAKE_HASH, accountScriptHash, logicHash, logicV2Hash, stakeScriptHash, unappliedStakeScriptHash } from './support/account.js';

/** The blueprint the service ships with, and the one the sibling contract checkout builds, when that checkout is present. */
const SHIPPED_PATH = resolve(import.meta.dirname, '..', 'contract', 'plutus.json');
const SIBLING_PATH = resolve(import.meta.dirname, '..', '..', 'cardano-account-custody-contract', 'plutus.json');

/** A blueprint parsed, so that formatting differences do not count. */
const blueprint = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('shipped blueprint', () => {
  it.skipIf(!existsSync(SIBLING_PATH))('is the blueprint the sibling contract checkout builds', () => {
    expect(blueprint(SHIPPED_PATH)).toEqual(blueprint(SIBLING_PATH));
  });

  it('hashes to the proxy the service is configured for, the two logics it serves by default and the stake validator, unapplied and applied to the fixture device', () => {
    expect(accountScriptHash).toBe('ed61963ac94d12c0b320be5a336c36af66bc02c380e0aa3001899253');
    expect(logicHash).toBe(CURRENT_LOGIC_HASH);
    expect(logicHash).toBe('2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a');
    expect(logicV2Hash).toBe(LOGIC_V2_HASH);
    expect(logicV2Hash).toBe('69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d');
    expect(unappliedStakeScriptHash).toBe('edcfa41389b7b924916ad7408cd2d0f75a7a3dae8717f9bbf1a668c6');
    expect(stakeScriptHash).toBe(AIKEN_APPLIED_STAKE_HASH);
  });
});
