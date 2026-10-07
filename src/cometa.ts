import { createRequire } from 'node:module';
import type * as CometaModule from '@biglup/cometa';

/**
 * The cometa.js library, loaded through its CommonJS build. The ES module
 * build bundles its WebAssembly loader with a dynamic require that Node
 * refuses to run, so every module here imports cometa from this one place.
 * Callers must await `Cometa.ready()` once before using anything else.
 */
export const Cometa: typeof CometaModule = createRequire(import.meta.url)('@biglup/cometa') as typeof CometaModule;
