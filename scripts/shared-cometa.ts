import Module, { createRequire } from 'node:module';

/** The CommonJS resolver, which the type declarations leave out. */
interface CommonJsResolver {
  _resolveFilename: (this: unknown, request: string, ...rest: unknown[]) => string;
}

/** The specifier every copy of the library is loaded under. */
const COMETA = '@biglup/cometa';

/**
 * Points every resolution of cometa in this process at this repository's
 * copy, so that the contract library, linked from a sibling checkout with
 * a copy of its own, shares one instance with the sponsor wallet. cometa
 * keeps its WebAssembly state per loaded copy, and an object one copy
 * creates, such as the reward address the contract's builder registers,
 * holds a pointer into that copy's memory, which another copy reads as
 * garbage without noticing. This module must be imported before the
 * contract library.
 */
const resolver = Module as unknown as CommonJsResolver;
const resolveFilename = resolver._resolveFilename;
const ownCometa = createRequire(import.meta.url).resolve(COMETA);

resolver._resolveFilename = function (request, ...rest) {
  return request === COMETA ? ownCometa : resolveFilename.call(this, request, ...rest);
};
