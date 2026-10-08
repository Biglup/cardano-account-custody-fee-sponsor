import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvider } from '../src/provider.js';

/** What the endpoint saw of one request: the method, the path with its query, and the headers as sent. */
interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

/** A local endpoint that records every request and answers each with an empty list. */
interface RecordingEndpoint {
  server: Server;
  base: string;
  requests: RecordedRequest[];
}

/** Starts a recording endpoint on a free loopback port, serving the given path as the proxy serves a surface. */
const startEndpoint = async (path: string): Promise<RecordingEndpoint> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end('[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}${path}`, requests };
};

/** An address the provider is asked about; the endpoint answers whatever it is given. */
const ADDRESS = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x';

let endpoint: RecordingEndpoint;

beforeEach(async () => {
  endpoint = await startEndpoint('/surface/preprod/api/v0');
});

afterEach(() => {
  endpoint.server.close();
});

describe('createProvider', () => {
  it('reaches the hosted preprod endpoint when no endpoint is configured', () => {
    const provider = createProvider({ blockfrostProjectId: 'preprodTestProjectId', blockfrostBaseUrl: undefined });

    expect(provider.url).toBe('https://cardano-preprod.blockfrost.io/api/v0/');
  });

  it('sends no project id header at all when no project id is configured', async () => {
    const provider = createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: endpoint.base });

    await provider.getUnspentOutputs(ADDRESS);

    const [request] = endpoint.requests;
    expect(request).toBeDefined();
    expect(Object.keys(request!.headers)).not.toContain('project_id');
  });

  it('sends the project id when one is configured alongside the endpoint', async () => {
    const provider = createProvider({ blockfrostProjectId: 'preprodTestProjectId', blockfrostBaseUrl: endpoint.base });

    await provider.getUnspentOutputs(ADDRESS);

    expect(endpoint.requests[0]?.headers.project_id).toBe('preprodTestProjectId');
  });

  it('joins a route to the endpoint with one slash, so a proxy that routes by path sees its surface followed by the route', async () => {
    const provider = createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: endpoint.base });

    await provider.getUnspentOutputs(ADDRESS);
    await provider.getParameters().catch(() => undefined);
    await provider.submitTransaction('80').catch(() => undefined);

    expect(endpoint.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET /surface/preprod/api/v0/addresses/${ADDRESS}/utxos?count=100&page=1`,
      'GET /surface/preprod/api/v0/epochs/latest/parameters',
      'POST /surface/preprod/api/v0/tx/submit',
    ]);
    expect(endpoint.requests[2]?.headers['content-type']).toBe('application/cbor');
  });

  it('accepts an endpoint given with a trailing slash', async () => {
    const provider = createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: `${endpoint.base}/` });

    await provider.getUnspentOutputs(ADDRESS);

    expect(endpoint.requests[0]?.url).toBe(`/surface/preprod/api/v0/addresses/${ADDRESS}/utxos?count=100&page=1`);
  });

  it('leaves a prepared request to a configured endpoint with its method and body', async () => {
    createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: endpoint.base });

    const response = await fetch(new Request(`${endpoint.base}/tx/submit`, { method: 'POST', body: '80' }));
    await response.text();

    const [request] = endpoint.requests;
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-length']).toBe('2');
  });

  it('registers every endpoint it is given and rewrites for each', async () => {
    const second = await startEndpoint('/other/preprod/api/v0');
    try {
      createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: endpoint.base });
      const provider = createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: second.base });

      await provider.getUnspentOutputs(ADDRESS);

      expect(second.requests[0]?.url).toBe(`/other/preprod/api/v0/addresses/${ADDRESS}/utxos?count=100&page=1`);
    } finally {
      second.server.close();
    }
  });

  it('leaves requests to anything but a configured endpoint as they are', async () => {
    const other = await startEndpoint('/elsewhere');
    try {
      createProvider({ blockfrostProjectId: undefined, blockfrostBaseUrl: endpoint.base });

      await fetch(`${other.base}//route`, { headers: { project_id: '' } });

      expect(other.requests[0]?.url).toBe('/elsewhere//route');
      expect(other.requests[0]?.headers.project_id).toBe('');
    } finally {
      other.server.close();
    }
  });
});
