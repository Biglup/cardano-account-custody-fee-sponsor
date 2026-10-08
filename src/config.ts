import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { type Network, SLOT_SETTINGS_BY_NETWORK, type SlotSettings } from './slots.js';

/** A single BIP39 mnemonic word as the service accepts it: lowercase ASCII letters only. */
const MNEMONIC_WORD = /^[a-z]+$/;

/** The word counts a valid BIP39 mnemonic may have. */
const VALID_MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

/** The hex alphabet a 28 byte script hash is encoded in. */
const SCRIPT_HASH = /^[0-9a-f]{56}$/;

/**
 * The logic script a new account is created under: the contract's first
 * logic version applied to the account proxy's hash. An account's
 * control UTxO names its logic by hash, and the service refuses to pay
 * for or lend collateral to an account whose rules it does not know.
 */
export const CURRENT_LOGIC_HASH = '2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a';

/**
 * The contract's second logic version applied to the account proxy's
 * hash: the version an account arrives at when its devices sign an
 * upgrade.
 */
export const LOGIC_V2_HASH = '69baa8a8c877247028c56c8130449e186e3658d541536d168f92db3d';

/**
 * The logic versions the service serves unless the operator names
 * others: the current one and the one accounts upgrade to. An upgrade
 * runs both logics, and accounts sit on either side of it for as long as
 * the upgrade window lasts, so serving one of the two alone would either
 * refuse every upgrade or strand every account that has already moved.
 */
export const DEFAULT_KNOWN_LOGIC_HASHES = [CURRENT_LOGIC_HASH, LOGIC_V2_HASH];

/** The logic hashes a comma separated list names, with surrounding spaces and empty entries dropped. */
const logicHashesSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((hash) => hash.trim())
      .filter((hash) => hash.length > 0),
  )
  .refine((hashes) => hashes.length > 0, 'KNOWN_LOGIC_HASHES must name at least one logic script hash')
  .refine((hashes) => hashes.every((hash) => SCRIPT_HASH.test(hash)), 'KNOWN_LOGIC_HASHES must be 56 character hex script hashes separated by commas')
  .refine((hashes) => new Set(hashes).size === hashes.length, 'KNOWN_LOGIC_HASHES must not name the same logic script hash twice');

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

/** The blueprint of the contract build the service ships with, read unless `BLUEPRINT_PATH` names another. */
const DEFAULT_BLUEPRINT_PATH = fileURLToPath(new URL('../contract/plutus.json', import.meta.url));

/** A variable left blank, as an environment file with an empty line for it gives, counts as unset. */
const blankAsUnset = (value: unknown): unknown => (value === '' ? undefined : value);

/** The environment variables the service reads, with defaults for every operational tunable. */
const envSchema = z.object({
  BLOCKFROST_PREPROD_PROJECT_ID: z.preprocess(blankAsUnset, z.string().optional()),
  PROVIDER_BASE_URL: z.preprocess(blankAsUnset, z.string().url('PROVIDER_BASE_URL must be a URL').optional()),
  SPONSOR_MNEMONIC: mnemonicSchema,
  ACCOUNT_SCRIPT_HASH: z.string().regex(SCRIPT_HASH, 'ACCOUNT_SCRIPT_HASH must be a 56 character hex script hash'),
  KNOWN_LOGIC_HASHES: logicHashesSchema.default(DEFAULT_KNOWN_LOGIC_HASHES),
  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().min(1).default('./data/sponsor.sqlite'),
  BLUEPRINT_PATH: z.string().min(1).default(DEFAULT_BLUEPRINT_PATH),
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

/**
 * How far apart the fee and the collateral sizes must be, as a fraction
 * of the larger: the pool sync classifies a UTxO by which size it lies
 * within a tenth of, so two sizes that close would make every UTxO of
 * either size a fee UTxO and never yield a collateral one.
 */
const MINIMUM_SIZE_SEPARATION = 0.1;

/** Whether the fee and the collateral sizes are far enough apart for a UTxO of either to be told from the other. */
const sizesAreDistinct = ({ FEE_UTXO_LOVELACE: fee, COLLATERAL_UTXO_LOVELACE: collateral }: { FEE_UTXO_LOVELACE: number; COLLATERAL_UTXO_LOVELACE: number }): boolean =>
  Math.abs(fee - collateral) > Math.max(fee, collateral) * MINIMUM_SIZE_SEPARATION;

/**
 * Whether the chain can be reached: the hosted endpoint needs a project
 * id, while a configured endpoint may supply its own, as a proxy does,
 * and need none from the service.
 */
const chainIsReachable = ({ BLOCKFROST_PREPROD_PROJECT_ID: projectId, PROVIDER_BASE_URL: baseUrl }: { BLOCKFROST_PREPROD_PROJECT_ID?: string | undefined; PROVIDER_BASE_URL?: string | undefined }): boolean =>
  projectId !== undefined || baseUrl !== undefined;

/** The environment schema with the checks that span more than one variable. */
const configSchema = envSchema
  .refine(chainIsReachable, {
    message: 'BLOCKFROST_PREPROD_PROJECT_ID is required unless PROVIDER_BASE_URL names a Blockfrost compatible endpoint that needs no project id',
    path: ['BLOCKFROST_PREPROD_PROJECT_ID'],
  })
  .refine(sizesAreDistinct, {
    message: 'FEE_UTXO_LOVELACE and COLLATERAL_UTXO_LOVELACE must differ by more than 10 percent, or a UTxO of either size could not be told from the other',
    path: ['COLLATERAL_UTXO_LOVELACE'],
  });

/** The service configuration, derived once from the environment at startup. */
export interface Config {
  network: Network;
  /** The project id the endpoint is called with, or none when `blockfrostBaseUrl` names an endpoint that supplies its own, such as a proxy. */
  blockfrostProjectId: string | undefined;
  /** The Blockfrost compatible endpoint the service reads and submits through, or none for the hosted preprod one. */
  blockfrostBaseUrl: string | undefined;
  sponsorMnemonic: string[];
  accountScriptHash: string;
  /** The logic script hashes the service serves accounts under; a control datum naming any other is refused. */
  knownLogicHashes: string[];
  adminApiKey: string;
  port: number;
  databasePath: string;
  /** The blueprint of the contract build `accountScriptHash` names, which the service reads the account stake validator from to tell a custody account's stake credential from any other script. */
  blueprintPath: string;
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
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(issues);
  }
  const data = result.data;
  const network: Network = 'preprod';
  return {
    network,
    blockfrostProjectId: data.BLOCKFROST_PREPROD_PROJECT_ID,
    blockfrostBaseUrl: data.PROVIDER_BASE_URL,
    sponsorMnemonic: data.SPONSOR_MNEMONIC,
    accountScriptHash: data.ACCOUNT_SCRIPT_HASH,
    knownLogicHashes: data.KNOWN_LOGIC_HASHES,
    adminApiKey: data.ADMIN_API_KEY,
    port: data.PORT,
    databasePath: data.DATABASE_PATH,
    blueprintPath: data.BLUEPRINT_PATH,
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
