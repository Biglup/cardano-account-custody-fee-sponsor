import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStakeValidator } from '../src/blueprint.js';
import { BLUEPRINT_PATH, accountScript, accountScriptHash, unappliedStakeScript, unappliedStakeScriptHash } from './support/account.js';

/** A directory of the test's own for the blueprints it writes, removed afterwards. */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'blueprint-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Writes `content` as a blueprint file in the test's directory and returns its path. */
const blueprintAt = (name: string, content: string): string => {
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
};

describe('loadStakeValidator', () => {
  it('reads the stake validator of the shipped blueprint as the blueprint ships it, before any parameter is applied', () => {
    expect(loadStakeValidator(BLUEPRINT_PATH, accountScriptHash)).toBe(unappliedStakeScript.bytes);
  });

  it('refuses a blueprint that cannot be read, one that is not a blueprint and one lacking either validator, naming the path', () => {
    const missing = join(directory, 'missing.json');
    expect(() => loadStakeValidator(missing, accountScriptHash)).toThrow(`The blueprint at ${missing} cannot be read: ENOENT`);

    const broken = blueprintAt('broken.json', '{');
    expect(() => loadStakeValidator(broken, accountScriptHash)).toThrow(`The blueprint at ${broken} cannot be read`);

    const shapeless = blueprintAt('shapeless.json', JSON.stringify({ validators: [{ title: 'account_stake.account_stake.withdraw' }] }));
    expect(() => loadStakeValidator(shapeless, accountScriptHash)).toThrow(
      `The blueprint at ${shapeless} is not an Aiken blueprint listing validators with their compiled code`,
    );

    const proxyOnly = blueprintAt('proxy-only.json', JSON.stringify({ validators: [{ title: 'account.account.spend', compiledCode: accountScript.bytes }] }));
    expect(() => loadStakeValidator(proxyOnly, accountScriptHash)).toThrow(`The blueprint at ${proxyOnly} has no validator titled account_stake.account_stake`);

    const stakeOnly = blueprintAt('stake-only.json', JSON.stringify({ validators: [{ title: 'account_stake.account_stake.withdraw', compiledCode: unappliedStakeScript.bytes }] }));
    expect(() => loadStakeValidator(stakeOnly, accountScriptHash)).toThrow(`The blueprint at ${stakeOnly} has no validator titled account.account`);
  });

  it('refuses a blueprint of another build, whose account proxy hashes elsewhere than the configured account script hash', () => {
    const otherBuild = blueprintAt(
      'other-build.json',
      JSON.stringify({
        validators: [
          { title: 'account.account.spend', compiledCode: unappliedStakeScript.bytes },
          { title: 'account_stake.account_stake.withdraw', compiledCode: unappliedStakeScript.bytes },
        ],
      }),
    );
    expect(() => loadStakeValidator(otherBuild, accountScriptHash)).toThrow(
      `The blueprint at ${otherBuild} is a build whose account proxy hashes to ${unappliedStakeScriptHash}, not to the ${accountScriptHash} that ACCOUNT_SCRIPT_HASH names`,
    );
    expect(loadStakeValidator(otherBuild, unappliedStakeScriptHash)).toBe(unappliedStakeScript.bytes);
  });
});
