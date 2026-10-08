import type { BlockfrostProvider } from '@biglup/cometa';
import { Cometa } from './cometa.js';
import type { Config } from './config.js';

/** What a provider is built from: the endpoint the chain is reached through and the project id, when the endpoint needs one. */
export type ProviderSettings = Pick<Config, 'blockfrostProjectId' | 'blockfrostBaseUrl'>;

/** The header set a Blockfrost request carries, as the library types it. */
type HeaderSet = ReturnType<BlockfrostProvider['headers']>;

/** The endpoints whose requests are rewritten, each ending in a slash as the provider keeps it. */
const rewrittenEndpoints = new Set<string>();

/** The fetch the process started with, which every request ends up in. */
const originalFetch = globalThis.fetch;

/**
 * Folds the doubled slash out of the requests the provider composes for a
 * registered endpoint and passes every other request on untouched. The
 * provider joins most of its routes to its endpoint with a slash on both
 * sides, which the hosted Blockfrost tolerates but an endpoint that routes
 * by path prefix may not. Only a request named by a string or a URL is
 * rewritten, which is every request the provider makes; a prepared request
 * carries a method, a body and a signal this cannot restate, so it is
 * passed on as it came.
 */
const rewrite: typeof fetch = (input, init) => {
  if (input instanceof Request) {
    return originalFetch(input, init);
  }
  const url = typeof input === 'string' ? input : input.href;
  const endpoint = [...rewrittenEndpoints].find((candidate) => url.startsWith(candidate));
  if (endpoint === undefined) {
    return originalFetch(input, init);
  }
  return originalFetch(`${endpoint}${url.slice(endpoint.length).replace(/^\/+/, '')}`, init);
};

/**
 * Puts the rewrite in front of the process's fetch, once, and registers an
 * endpoint with it. cometa reaches the chain through the global fetch and
 * offers no hook on the requests it composes, so this is the one place
 * their paths can be corrected before they leave the process. It goes once
 * the library joins its routes to an endpoint with a single slash.
 */
const rewriteRequestsTo = (endpoint: string): void => {
  if (rewrittenEndpoints.size === 0) {
    globalThis.fetch = rewrite;
  }
  rewrittenEndpoints.add(endpoint);
};

/**
 * A provider that sends no project id header when it has no project id to
 * send. The library sends the header on every request whatever the project
 * id is, so an endpoint that supplies its own, such as a proxy, would see
 * a header that is present but blank and may refuse it or prefer it to the
 * one it supplies.
 */
class SponsorProvider extends Cometa.BlockfrostProvider {
  override headers(): HeaderSet {
    const { project_id: projectId, ...rest } = super.headers();
    return (projectId === '' ? rest : { ...rest, project_id: projectId }) as HeaderSet;
  }
}

/**
 * Creates the provider the service reads the chain and submits through:
 * the hosted preprod endpoint, called with the project id, or the
 * Blockfrost compatible endpoint the configuration names, called with the
 * project id when one is configured and with no project id header at all
 * otherwise. Every entry point builds its provider here, so each reaches
 * the same endpoint the same way.
 */
export const createProvider = ({ blockfrostProjectId, blockfrostBaseUrl }: ProviderSettings): BlockfrostProvider => {
  const provider = new SponsorProvider({
    network: Cometa.NetworkMagic.Preprod,
    projectId: blockfrostProjectId ?? '',
    ...(blockfrostBaseUrl === undefined ? {} : { baseUrl: blockfrostBaseUrl }),
  });
  rewriteRequestsTo(provider.url);
  return provider;
};
