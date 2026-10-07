import type { Express } from 'express';
import request from 'supertest';

/** The request methods the client adapter uses, as supertest names them. */
type Method = 'get' | 'post' | 'delete';

/** The URL a fetch call names, whatever form it was given in. */
const urlOf = (input: string | URL | Request): URL => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/**
 * A fetch that reaches an express application in process through
 * supertest, so that a client built on the global fetch can be
 * exercised against the real middleware stack without a listening
 * socket. The host of the URL is ignored; the path, the query, the
 * method, the headers and the body go through as they are.
 */
export const appFetch =
  (app: Express): typeof fetch =>
  async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? 'GET').toLowerCase() as Method;
    let test = request(app)[method](`${url.pathname}${url.search}`);
    for (const [name, value] of new Headers(init?.headers)) {
      test = test.set(name, value);
    }
    if (typeof init?.body === 'string') {
      test = test.send(init.body);
    }
    const response = await test;
    return new Response(response.text, { status: response.status, headers: response.headers as Record<string, string> });
  };
