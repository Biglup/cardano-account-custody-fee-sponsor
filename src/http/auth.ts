import { timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { type ApiKey, findApiKeyByHash, hashApiKey } from '../keys.js';
import { UnauthorizedError } from './errors.js';

/** The bearer token of a request, or undefined when the authorization header is missing or not a bearer scheme. */
const bearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (header === undefined) {
    return undefined;
  }
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || rest.length > 0) {
    return undefined;
  }
  return token;
};

/**
 * Whether two secrets match, compared in constant time over their hashes
 * so neither the length nor the position of the first differing byte
 * leaks through timing.
 */
export const secretsMatch = (presented: string, expected: string): boolean =>
  timingSafeEqual(Buffer.from(hashApiKey(presented), 'hex'), Buffer.from(hashApiKey(expected), 'hex'));

/**
 * Requires a bearer API key on the request. The key's SHA-256 hash is
 * looked up, then compared in constant time with the stored hash; a
 * missing, unknown or disabled key is refused with the same 401 so a
 * caller learns nothing about which keys exist. The key record is left
 * on `res.locals` for the route to read through `apiKeyOf`.
 */
export const requireApiKey =
  (db: Database.Database): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (token === undefined) {
      next(new UnauthorizedError());
      return;
    }
    const keyHash = hashApiKey(token);
    const found = findApiKeyByHash(db, keyHash);
    if (!found || !timingSafeEqual(Buffer.from(found.keyHash, 'hex'), Buffer.from(keyHash, 'hex')) || found.disabled) {
      next(new UnauthorizedError());
      return;
    }
    res.locals.apiKey = found.record;
    next();
  };

/** Requires the admin key as the bearer token, compared in constant time. */
export const requireAdminKey =
  (adminApiKey: string): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (token === undefined || !secretsMatch(token, adminApiKey)) {
      next(new UnauthorizedError('The admin API key is required'));
      return;
    }
    next();
  };

/** The API key `requireApiKey` authenticated for this request. */
export const apiKeyOf = (res: Response): ApiKey => {
  const apiKey = res.locals.apiKey as ApiKey | undefined;
  if (!apiKey) {
    throw new UnauthorizedError();
  }
  return apiKey;
};
