import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

/**
 * The limits one API key works under: how many leases it may hold open at
 * once, how many witnesses it may obtain per hour, and how much sponsor
 * lovelace those witnesses may move per day.
 */
export interface ApiKeyQuotas {
  openLeases: number;
  witnessesPerHour: number;
  sponsoredLovelacePerDay: number;
}

/** The quotas a key gets unless the admin issuing it says otherwise. */
export const DEFAULT_QUOTAS: ApiKeyQuotas = {
  openLeases: 5,
  witnessesPerHour: 60,
  sponsoredLovelacePerDay: 600_000_000,
};

/** The quota overrides an admin may pass when issuing a key; every field is optional. */
export const quotasSchema = z
  .object({
    openLeases: z.number().int().positive().optional(),
    witnessesPerHour: z.number().int().positive().optional(),
    sponsoredLovelacePerDay: z.number().int().positive().optional(),
  })
  .strict();

/** The quota overrides as the admin endpoint accepts them. */
export type QuotaOverrides = z.infer<typeof quotasSchema>;

/** An issued API key as the service sees it on every request: never the secret itself. */
export interface ApiKey {
  id: number;
  label: string;
  quotas: ApiKeyQuotas;
}

/** A freshly issued key: the secret the caller must keep, and the record it maps to. */
export interface IssuedApiKey {
  apiKey: string;
  record: ApiKey;
}

type ApiKeyRow = { id: number; label: string; quotas: string; disabled_at: string | null };

/** The number of random bytes behind a key, which makes guessing one infeasible. */
const API_KEY_BYTES = 32;

/** The hex SHA-256 digest of an API key, which is all the database ever stores. */
export const hashApiKey = (apiKey: string): string => createHash('sha256').update(apiKey, 'utf8').digest('hex');

/** The effective quotas given some overrides: each override that is set replaces its default. */
const withDefaults = (overrides: QuotaOverrides): ApiKeyQuotas => ({
  openLeases: overrides.openLeases ?? DEFAULT_QUOTAS.openLeases,
  witnessesPerHour: overrides.witnessesPerHour ?? DEFAULT_QUOTAS.witnessesPerHour,
  sponsoredLovelacePerDay: overrides.sponsoredLovelacePerDay ?? DEFAULT_QUOTAS.sponsoredLovelacePerDay,
});

/** The effective quotas of a key from the overrides stored with it. */
const quotasFromJson = (json: string): ApiKeyQuotas => {
  const parsed = quotasSchema.safeParse(JSON.parse(json));
  return withDefaults(parsed.success ? parsed.data : {});
};

/** The key record a row maps to. */
const toApiKey = (row: ApiKeyRow): ApiKey => ({ id: row.id, label: row.label, quotas: quotasFromJson(row.quotas) });

/**
 * Issues a new API key under `label`. The secret is random, returned once
 * and stored only as its SHA-256 hash alongside the quota overrides, so a
 * database leak reveals no usable key.
 */
export const createApiKey = (db: Database.Database, label: string, quotas: QuotaOverrides = {}): IssuedApiKey => {
  const apiKey = randomBytes(API_KEY_BYTES).toString('base64url');
  const result = db
    .prepare('INSERT INTO api_keys (label, key_hash, quotas, created_at) VALUES (?, ?, ?, ?)')
    .run(label, hashApiKey(apiKey), JSON.stringify(quotas), new Date().toISOString());
  return {
    apiKey,
    record: { id: Number(result.lastInsertRowid), label, quotas: withDefaults(quotas) },
  };
};

/** The key stored under `keyHash`, with whether it has been disabled, or undefined when no key has that hash. */
export const findApiKeyByHash = (
  db: Database.Database,
  keyHash: string,
): { record: ApiKey; keyHash: string; disabled: boolean } | undefined => {
  const row = db
    .prepare('SELECT id, label, quotas, key_hash, disabled_at FROM api_keys WHERE key_hash = ?')
    .get(keyHash) as (ApiKeyRow & { key_hash: string }) | undefined;
  if (!row) {
    return undefined;
  }
  return { record: toApiKey(row), keyHash: row.key_hash, disabled: row.disabled_at !== null };
};
