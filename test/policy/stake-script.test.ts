import { describe, expect, it, vi } from 'vitest';
import type * as Uplc from '@harmoniclabs/uplc';
import { parseUPLC } from '@harmoniclabs/uplc';
import { loadStakeValidator } from '../../src/blueprint.js';
import { Cometa } from '../../src/cometa.js';
import { MAX_CACHED_DERIVATIONS, applyParameters, createStakeScriptDerivation } from '../../src/policy/stake-script.js';
import {
  AGENT_KEY,
  AIKEN_APPLIED_STAKE_HASH,
  BLUEPRINT_PATH,
  DEVICE_KEY,
  STRANGER_KEY,
  accountOf,
  accountScriptHash,
  stakeScriptHash,
  unappliedStakeScript,
  unappliedStakeScriptHash,
} from '../support/account.js';

vi.mock('@harmoniclabs/uplc', async (importOriginal) => {
  const actual = await importOriginal<typeof Uplc>();
  return { ...actual, parseUPLC: vi.fn(actual.parseUPLC) };
});

/** The stake validator of the shipped blueprint, still unapplied. */
const compiledCode = loadStakeValidator(BLUEPRINT_PATH, accountScriptHash);

/** The bytes of a hex string, as a parameter is applied. */
const bytes = (hex: string): Uint8Array => Cometa.hexToUint8Array(hex);

/** The hash of compiled code as the Plutus V3 script it is. */
const hashOf = (code: string): string => Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: code, version: Cometa.PlutusLanguageVersion.V3 });

describe('stake script derivation', () => {
  it('reaches the hash the Aiken CLI reports for the fixture device and the proxy hash, which the contract library reaches too', () => {
    const stakeScriptHashOf = createStakeScriptDerivation(compiledCode, accountScriptHash);

    expect(stakeScriptHashOf(DEVICE_KEY)).toBe(AIKEN_APPLIED_STAKE_HASH);
    expect(stakeScriptHashOf(DEVICE_KEY)).toBe(stakeScriptHash);
    expect(stakeScriptHashOf(AGENT_KEY)).toBe(accountOf(AGENT_KEY).stakeScriptHash);
    expect(stakeScriptHashOf(AGENT_KEY)).not.toBe(AIKEN_APPLIED_STAKE_HASH);
  });

  it('applies the device before the proxy hash, so the two swapped derive another script', () => {
    expect(createStakeScriptDerivation(compiledCode, DEVICE_KEY)(accountScriptHash)).not.toBe(AIKEN_APPLIED_STAKE_HASH);
  });

  it('leaves the code as the blueprint reports it under no parameters and applies them one at a time as it does at once', () => {
    expect(applyParameters(compiledCode, [])).toBe(unappliedStakeScript.bytes);
    expect(hashOf(compiledCode)).toBe(unappliedStakeScriptHash);
    const ownerApplied = applyParameters(compiledCode, [bytes(DEVICE_KEY)]);
    expect(applyParameters(ownerApplied, [bytes(accountScriptHash)])).toBe(applyParameters(compiledCode, [bytes(DEVICE_KEY), bytes(accountScriptHash)]));
    expect(hashOf(applyParameters(ownerApplied, [bytes(accountScriptHash)]))).toBe(AIKEN_APPLIED_STAKE_HASH);
  });

  it('derives each device key once, and again only once the cache has forgotten it', () => {
    vi.mocked(parseUPLC).mockClear();
    const stakeScriptHashOf = createStakeScriptDerivation(compiledCode, accountScriptHash, 2);

    expect(stakeScriptHashOf(DEVICE_KEY)).toBe(AIKEN_APPLIED_STAKE_HASH);
    expect(stakeScriptHashOf(DEVICE_KEY)).toBe(AIKEN_APPLIED_STAKE_HASH);
    expect(stakeScriptHashOf(AGENT_KEY)).toBe(accountOf(AGENT_KEY).stakeScriptHash);
    expect(stakeScriptHashOf(AGENT_KEY)).toBe(accountOf(AGENT_KEY).stakeScriptHash);
    expect(parseUPLC).toHaveBeenCalledTimes(2);

    expect(stakeScriptHashOf(STRANGER_KEY)).toBe(accountOf(STRANGER_KEY).stakeScriptHash);
    expect(parseUPLC).toHaveBeenCalledTimes(3);
    expect(stakeScriptHashOf(AGENT_KEY)).toBe(accountOf(AGENT_KEY).stakeScriptHash);
    expect(parseUPLC).toHaveBeenCalledTimes(3);
    expect(stakeScriptHashOf(DEVICE_KEY)).toBe(AIKEN_APPLIED_STAKE_HASH);
    expect(parseUPLC).toHaveBeenCalledTimes(4);
    expect(MAX_CACHED_DERIVATIONS).toBeGreaterThan(8);
  });
});
