import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { apiKeyOf } from './auth.js';
import { RateLimitedError } from './errors.js';

/** The window every rate limit is measured over. */
const WINDOW_MS = 60_000;

/** The rate limit options the two limiters share: standard headers, and the refusal routed through the error middleware. */
const shared = {
  windowMs: WINDOW_MS,
  standardHeaders: 'draft-8' as const,
  legacyHeaders: false,
  handler: (_req: unknown, _res: unknown, next: (err: unknown) => void): void => {
    next(new RateLimitedError());
  },
};

/**
 * Limits how many requests one client address makes per minute, whatever
 * it presents as a key, so that guessing keys or flooding the service
 * costs the caller its own address first. The address is the one express
 * resolves, which honours the trust proxy setting.
 */
export const ipRateLimiter = (perMinute: number): RequestHandler => rateLimit({ ...shared, limit: perMinute });

/**
 * Limits how many requests one API key makes per minute, counted after
 * the key authenticated, so that a client that holds a valid key still
 * cannot turn it into a flood; the per key quotas bound what the key
 * obtains, this bounds how often it asks.
 */
export const keyRateLimiter = (perMinute: number): RequestHandler =>
  rateLimit({ ...shared, limit: perMinute, keyGenerator: (_req, res) => `key:${apiKeyOf(res).id}` });
