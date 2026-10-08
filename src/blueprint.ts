import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Cometa } from './cometa.js';

/** The title every handler of the account proxy shares in the blueprint. */
const ACCOUNT_VALIDATOR_TITLE = 'account.account';

/** The title every handler of the account stake validator shares in the blueprint. */
const STAKE_VALIDATOR_TITLE = 'account_stake.account_stake';

/** The parts of an Aiken blueprint the service reads, each left loose so a field it does not read never fails the parse. */
const blueprintSchema = z
  .object({ validators: z.array(z.object({ title: z.string(), compiledCode: z.string().regex(/^[0-9a-f]+$/) }).loose()) })
  .loose();

/** A validator entry of a blueprint, as far as the service reads one. */
type Validator = z.infer<typeof blueprintSchema>['validators'][number];

/** The hash of a validator's compiled code as the Plutus V3 script every validator of the contract is. */
const scriptHashOf = (compiledCode: string): string =>
  Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: compiledCode, version: Cometa.PlutusLanguageVersion.V3 });

/**
 * The compiled code of the account stake validator as the blueprint at
 * `path` carries it, still parameterised by the owner device key and the
 * account script hash. Every handler of a validator shares one compiled
 * code, so the first entry titled after it is representative. The
 * blueprint must be the build whose account proxy hashes to
 * `accountScriptHash`: the stake validator of any other build derives
 * stake scripts the configured proxy does not govern, so a creation
 * registered under one would be paid for while every honest creation
 * would be refused. A blueprint that cannot be read, is not one, lacks
 * either validator or is another build is refused with the path at
 * fault.
 */
export const loadStakeValidator = (path: string, accountScriptHash: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new Error(`The blueprint at ${path} cannot be read: ${message}`);
  }
  const result = blueprintSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`The blueprint at ${path} is not an Aiken blueprint listing validators with their compiled code`);
  }
  const validatorTitled = (title: string): Validator => {
    const validator = result.data.validators.find((entry) => entry.title.startsWith(`${title}.`));
    if (validator === undefined) {
      throw new Error(`The blueprint at ${path} has no validator titled ${title}`);
    }
    return validator;
  };
  const stakeValidator = validatorTitled(STAKE_VALIDATOR_TITLE);
  const builtHash = scriptHashOf(validatorTitled(ACCOUNT_VALIDATOR_TITLE).compiledCode);
  if (builtHash !== accountScriptHash) {
    throw new Error(
      `The blueprint at ${path} is a build whose account proxy hashes to ${builtHash}, not to the ${accountScriptHash} that ACCOUNT_SCRIPT_HASH names`,
    );
  }
  return stakeValidator.compiledCode;
};
