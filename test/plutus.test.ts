import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The blueprint the fixtures read, and the one the sibling contract checkout builds, when that checkout is present. */
const FIXTURE_PATH = resolve(import.meta.dirname, 'support', 'plutus.json');
const SIBLING_PATH = resolve(import.meta.dirname, '..', '..', 'cardano-account-custody-contract', 'plutus.json');

/** A blueprint parsed, so that formatting differences do not count. */
const blueprint = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

describe('blueprint fixture', () => {
  it.skipIf(!existsSync(SIBLING_PATH))('is the blueprint the sibling contract checkout builds', () => {
    expect(blueprint(FIXTURE_PATH)).toEqual(blueprint(SIBLING_PATH));
  });
});
