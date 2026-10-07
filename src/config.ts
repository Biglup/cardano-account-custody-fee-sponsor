import { z } from 'zod';
import { type Network, SLOT_SETTINGS_BY_NETWORK, type SlotSettings } from './slots.js';

/** A single BIP39 mnemonic word as the service accepts it: lowercase ASCII letters only. */
const MNEMONIC_WORD = /^[a-z]+$/;

/** The word counts a valid BIP39 mnemonic may have. */
const VALID_MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

/** The hex alphabet a 28 byte script hash is encoded in. */
const SCRIPT_HASH = /^[0-9a-f]{56}$/;

/**
 * The sponsor mnemonic, split into words and checked for shape only: word
 * count and lowercase letters. The validation message never repeats the
 * value under check, so a failure cannot leak the mnemonic into logs or
 * error responses.
 */
const mnemonicSchema = z
  .string()
  .transform((value) => value.trim().split(/\s+/).filter((word) => word.length > 0))
  .refine(
    (words) => VALID_MNEMONIC_WORD_COUNTS.includes(words.length) && words.every((word) => MNEMONIC_WORD.test(word)),
    'SPONSOR_MNEMONIC must have 12, 15, 18, 21 or 24 lowercase words',
  );

/** The environment variables the service reads, with defaults for every operational tunable. */
const envSchema = z.object({
  BLOCKFROST_PREPROD_PROJECT_ID: z.string().min(1, 'BLOCKFROST_PREPROD_PROJECT_ID is required'),
  SPONSOR_MNEMONIC: mnemonicSchema,
  ACCOUNT_SCRIPT_HASH: z.string().regex(SCRIPT_HASH, 'ACCOUNT_SCRIPT_HASH must be a 56 character hex script hash'),
  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().min(1).default('./data/sponsor.sqlite'),
  LEASE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  MAX_SPONSORED_LOVELACE: z.coerce.number().int().positive().default(6_000_000),
  MAX_FEE_LOVELACE: z.coerce.number().int().positive().default(2_000_000),
  FEE_UTXO_LOVELACE: z.coerce.number().int().positive().default(100_000_000),
  COLLATERAL_UTXO_LOVELACE: z.coerce.number().int().positive().default(5_000_000),
  FEE_UTXO_COUNT: z.coerce.number().int().positive().default(10),
  COLLATERAL_UTXO_COUNT: z.coerce.number().int().positive().default(2),
  VALIDITY_MARGIN_SECONDS: z.coerce.number().int().min(0).default(120),
  COLLATERAL_VALIDITY_SECONDS: z.coerce.number().int().positive().default(600),
  IP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
});

/** The service configuration, derived once from the environment at startup. */
export interface Config {
  network: Network;
  blockfrostProjectId: string;
  sponsorMnemonic: string[];
  accountScriptHash: string;
  adminApiKey: string;
  port: number;
  databasePath: string;
  leaseTtlSeconds: number;
  maxSponsoredLovelace: number;
  maxFeeLovelace: number;
  feeUtxoLovelace: number;
  collateralUtxoLovelace: number;
  feeUtxoCount: number;
  collateralUtxoCount: number;
  /** How the network's slots map to time, for the validity bound a witnessed transaction must carry. */
  slots: SlotSettings;
  /** How far past a lease's expiry a transaction's validity upper bound may reach. */
  validityMarginSeconds: number;
  /** How far from now the validity upper bound of a transaction witnessed in collateral mode may reach. */
  collateralValiditySeconds: number;
  /** How many requests one address may make per minute, whatever key it presents. */
  ipRateLimitPerMinute: number;
  /** How many requests one API key may make per minute. */
  keyRateLimitPerMinute: number;
  /** How many reverse proxies stand in front of the service, so the client address is read from the right forwarded hop. */
  trustProxyHops: number;
}

/**
 * Thrown when the environment fails validation. The message lists which
 * variables are wrong and why, by field name only; it never includes the
 * value that was rejected.
 */
export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses the service configuration out of a set of environment variables.
 * Defaults to `process.env` so the running process reads its real
 * environment, while tests can pass a plain object of fake values instead.
 */
export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  const data = result.data;
  const network: Network = 'preprod';
  return {
    network,
    blockfrostProjectId: data.BLOCKFROST_PREPROD_PROJECT_ID,
    sponsorMnemonic: data.SPONSOR_MNEMONIC,
    accountScriptHash: data.ACCOUNT_SCRIPT_HASH,
    adminApiKey: data.ADMIN_API_KEY,
    port: data.PORT,
    databasePath: data.DATABASE_PATH,
    leaseTtlSeconds: data.LEASE_TTL_SECONDS,
    maxSponsoredLovelace: data.MAX_SPONSORED_LOVELACE,
    maxFeeLovelace: data.MAX_FEE_LOVELACE,
    feeUtxoLovelace: data.FEE_UTXO_LOVELACE,
    collateralUtxoLovelace: data.COLLATERAL_UTXO_LOVELACE,
    feeUtxoCount: data.FEE_UTXO_COUNT,
    collateralUtxoCount: data.COLLATERAL_UTXO_COUNT,
    slots: SLOT_SETTINGS_BY_NETWORK[network],
    validityMarginSeconds: data.VALIDITY_MARGIN_SECONDS,
    collateralValiditySeconds: data.COLLATERAL_VALIDITY_SECONDS,
    ipRateLimitPerMinute: data.IP_RATE_LIMIT_PER_MINUTE,
    keyRateLimitPerMinute: data.KEY_RATE_LIMIT_PER_MINUTE,
    trustProxyHops: data.TRUST_PROXY_HOPS,
  };
};
