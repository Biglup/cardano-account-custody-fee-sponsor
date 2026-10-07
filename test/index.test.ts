import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The source root the package root lives in. */
const SRC = resolve(import.meta.dirname, '..', 'src');

/** The modules the package root may reach: the adapter, the API bodies, the hash helper and the cometa loader, and nothing of the service. */
const CLIENT_MODULES = ['index.ts', 'api.ts', 'cometa.ts', 'transaction-hash.ts', 'client/sponsor-wallet.ts'].map((file) => resolve(SRC, file));

/** The relative specifiers a module imports or re-exports from, which name the source files its declarations will reference. */
const relativeImportsOf = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)].map((match) => resolve(dirname(file), `${match[1]}.ts`));

/** Every module reachable from `entry` through relative imports, the entry included. */
const reachableFrom = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (!seen.has(file)) {
      seen.add(file);
      pending.push(...relativeImportsOf(file));
    }
  }
  return seen;
};

describe('package root', () => {
  it('reaches only the client modules, so a consumer type checks the adapter without the service and its dependencies', () => {
    expect([...reachableFrom(resolve(SRC, 'index.ts'))].sort()).toEqual([...CLIENT_MODULES].sort());
  });
});
