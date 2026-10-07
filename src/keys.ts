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

/** A key as the admin routes list it: its record, when it was issued and when it was disabled, if it was; never its hash. */
export interface ApiKeyListing extends ApiKey {
  createdAt: string;
  disabledAt: string | undefined;
}

/** What disabling a key found: the key, and whether it was already disabled. */
export interface DisabledApiKey {
  record: ApiKey;
  alreadyDisabled: boolean;
}

type ApiKeyRow = { id: number; label: string; quotas: string; created_at: string; disabled_at: string | null };

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
const toApiKey = (row: Pick<ApiKeyRow, 'id' | 'label' | 'quotas'>): ApiKey => ({ id: row.id, label: row.label, quotas: quotasFromJson(row.quotas) });

/** The listing a row maps to. */
const toListing = (row: ApiKeyRow): ApiKeyListing => ({ ...toApiKey(row), createdAt: row.created_at, disabledAt: row.disabled_at ?? undefined });

/**
 * Issues a new API key under `label` at `at`. The secret is random,
 * returned once and stored only as its SHA-256 hash alongside the quota
 * overrides, so a database leak reveals no usable key.
 */
export const createApiKey = (db: Database.Database, label: string, quotas: QuotaOverrides, at: Date): IssuedApiKey => {
  const apiKey = randomBytes(API_KEY_BYTES).toString('base64url');
  const result = db
    .prepare('INSERT INTO api_keys (label, key_hash, quotas, created_at) VALUES (?, ?, ?, ?)')
    .run(label, hashApiKey(apiKey), JSON.stringify(quotas), at.toISOString());
  return {
    apiKey,
    record: { id: Number(result.lastInsertRowid), label, quotas: withDefaults(quotas) },
  };
};

/** Every key ever issued, oldest first, with when it was issued and disabled; the hash is never read. */
export const listApiKeys = (db: Database.Database): ApiKeyListing[] =>
  (db.prepare('SELECT id, label, quotas, created_at, disabled_at FROM api_keys ORDER BY id').all() as ApiKeyRow[]).map(toListing);

/**
 * Disables the key with `id` as of `at`, after which every request it
 * presents is refused. A key already disabled keeps its original time
 * and is reported as such; an unknown id yields undefined.
 */
export const disableApiKey = (db: Database.Database, id: number, at: Date): DisabledApiKey | undefined => {
  const row = db.prepare('SELECT id, label, quotas, created_at, disabled_at FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const alreadyDisabled = row.disabled_at !== null;
  if (!alreadyDisabled) {
    db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?').run(at.toISOString(), id);
  }
  return { record: toApiKey(row), alreadyDisabled };
};

/** The key stored under `keyHash`, with whether it has been disabled, or undefined when no key has that hash. */
export const findApiKeyByHash = (
  db: Database.Database,
  keyHash: string,
): { record: ApiKey; keyHash: string; disabled: boolean } | undefined => {
  const row = db
    .prepare('SELECT id, label, quotas, key_hash, created_at, disabled_at FROM api_keys WHERE key_hash = ?')
    .get(keyHash) as (ApiKeyRow & { key_hash: string }) | undefined;
  if (!row) {
    return undefined;
  }
  return { record: toApiKey(row), keyHash: row.key_hash, disabled: row.disabled_at !== null };
};
