import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { Provider } from '@biglup/cometa';
import { config as loadEnvFile } from 'dotenv';
import type { Logger } from 'pino';
import { Cometa } from '../cometa.js';
import { type Config, loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { applyMigrations } from '../db/migrations.js';
import { OutOfFundsError } from '../http/errors.js';
import { type ServiceWallet, loadServiceWallet } from '../wallet.js';
import { designatedCollateral } from './collateral.js';
import { REPLENISH_FEE_MARGIN, minimumSplitLovelace } from './sizes.js';
import { type PoolSync, createPoolSync } from './sync.js';

/** How long a split waits for the chain to confirm it, in milliseconds. */
const CONFIRMATION_TIMEOUT_MS = 180_000;

/** What a split is asked for; every field defaults to the configuration and the pool's current shortfall. */
export interface ReplenishRequest {
  feeUtxoLovelace?: number | undefined;
  feeUtxoCount?: number | undefined;
  collateralLovelace?: number | undefined;
  collateralCount?: number | undefined;
}

/** What a split did, or why it did nothing. */
export interface ReplenishResult {
  txId: string | undefined;
  feeOutputs: number;
  collateralOutputs: number;
  reserveLovelace: bigint;
}

/** The outputs a split was asked for and will create once the request is capped by the reserve. */
export interface SplitPlan {
  feeUtxoLovelace: bigint;
  feeWanted: number;
  feeOutputs: number;
  collateralLovelace: bigint;
  collateralWanted: number;
  collateralOutputs: number;
}

/** The pool targets and sizes a split defaults to. */
export type ReplenishSettings = Pick<Config, 'feeUtxoLovelace' | 'collateralUtxoLovelace' | 'feeUtxoCount' | 'collateralUtxoCount'>;

/** Everything a split needs injected. */
export interface ReplenishDependencies {
  db: Database.Database;
  provider: Provider;
  serviceWallet: ServiceWallet;
  sync: PoolSync;
  settings: ReplenishSettings;
  logger?: Logger;
}

/** Runs a split with the given request. */
export type ReplenishFn = (request?: ReplenishRequest) => Promise<ReplenishResult>;

/** How many pool UTxOs of `kind` are free or leased, which is what the targets count against. */
const liveCount = (db: Database.Database, kind: 'fee' | 'collateral'): number =>
  (db.prepare("SELECT COUNT(*) AS count FROM pool_utxos WHERE kind = ? AND status IN ('free', 'leased')").get(kind) as { count: number }).count;

/** How many outputs of `size` the lovelace left after the margin can fund, at most `wanted`. */
const affordable = (available: bigint, size: bigint, wanted: number): number => {
  const spendable = available - REPLENISH_FEE_MARGIN;
  if (spendable <= 0n || wanted <= 0) {
    return 0;
  }
  return Number(spendable / size < BigInt(wanted) ? spendable / size : BigInt(wanted));
};

/**
 * Decides what a split creates. Explicit counts are taken as given; a
 * missing count tops the pool up to its configured target. Fee outputs
 * come first, then collateral outputs from whatever lovelace is left, and
 * both are capped by the reserve less the fee margin.
 */
export const planSplit = (db: Database.Database, settings: ReplenishSettings, reserveLovelace: bigint, request: ReplenishRequest = {}): SplitPlan => {
  const feeUtxoLovelace = BigInt(request.feeUtxoLovelace ?? settings.feeUtxoLovelace);
  const collateralLovelace = BigInt(request.collateralLovelace ?? settings.collateralUtxoLovelace);
  const feeWanted = request.feeUtxoCount ?? Math.max(0, settings.feeUtxoCount - liveCount(db, 'fee'));
  const collateralWanted = request.collateralCount ?? Math.max(0, settings.collateralUtxoCount - liveCount(db, 'collateral'));
  const feeOutputs = affordable(reserveLovelace, feeUtxoLovelace, feeWanted);
  const collateralOutputs = affordable(reserveLovelace - feeUtxoLovelace * BigInt(feeOutputs), collateralLovelace, collateralWanted);
  return { feeUtxoLovelace, feeWanted, feeOutputs, collateralLovelace, collateralWanted, collateralOutputs };
};

/**
 * Builds the self transaction of a split: every input comes from the
 * reserve, so pool UTxOs, leased or free, are never touched, and the
 * shared collateral UTxO is left out of the inputs the builder may draw
 * on whatever the reserve says, since a transaction witnessed against it
 * may land at any moment. Each planned output pays the sponsor address
 * its exact size, with the change returning to the same address. The
 * transaction is returned unsigned.
 */
export const buildSplitTransaction = async (db: Database.Database, serviceWallet: ServiceWallet, sync: PoolSync, plan: SplitPlan): Promise<string> => {
  const shared = designatedCollateral(db)?.utxo;
  const spendable = sync.reserve().utxos.filter((utxo) => !(utxo.input.txId === shared?.txHash && utxo.input.index === shared.index));
  const builder = await serviceWallet.wallet.createTransactionBuilder();
  builder.setUtxos(spendable).setChangeAddress(serviceWallet.address);
  for (let i = 0; i < plan.feeOutputs; i += 1) {
    builder.sendLovelace({ address: serviceWallet.address, amount: plan.feeUtxoLovelace });
  }
  for (let i = 0; i < plan.collateralOutputs; i += 1) {
    builder.sendLovelace({ address: serviceWallet.address, amount: plan.collateralLovelace });
  }
  return builder.build();
};

/**
 * Creates the split runner. A run resyncs the pool so the reserve is
 * current, plans the outputs, builds, signs and submits the transaction,
 * waits for the chain to confirm it, and resyncs again so the new UTxOs
 * become leasable. A request the reserve cannot fund at all is refused as
 * out of funds; a request for nothing, because the pool is already at its
 * targets, submits nothing.
 */
export const createReplenish = ({ db, provider, serviceWallet, sync, settings, logger }: ReplenishDependencies): ReplenishFn => {
  return async (request = {}) => {
    const { reserve } = await sync.run();
    const plan = planSplit(db, settings, reserve.lovelace, request);
    if (plan.feeWanted + plan.collateralWanted === 0) {
      return { txId: undefined, feeOutputs: 0, collateralOutputs: 0, reserveLovelace: reserve.lovelace };
    }
    if (plan.feeOutputs + plan.collateralOutputs === 0) {
      throw new OutOfFundsError(
        `The reserve holds ${reserve.lovelace} lovelace; a split needs at least ${minimumSplitLovelace(settings.feeUtxoLovelace)} to create one fee UTxO`,
      );
    }

    const unsigned = await buildSplitTransaction(db, serviceWallet, sync, plan);
    const witnesses = await serviceWallet.wallet.signTransaction(unsigned, false);
    const signed = Cometa.applyVkeyWitnessSet(unsigned, witnesses);
    const txId = await provider.submitTransaction(signed);
    logger?.info({ txId, feeOutputs: plan.feeOutputs, collateralOutputs: plan.collateralOutputs }, 'Split submitted');
    const confirmed = await provider.confirmTransaction(txId, CONFIRMATION_TIMEOUT_MS);
    if (!confirmed) {
      throw new Error(`Split ${txId} was not confirmed in time`);
    }
    const after = await sync.run();
    return { txId, feeOutputs: plan.feeOutputs, collateralOutputs: plan.collateralOutputs, reserveLovelace: after.reserve.lovelace };
  };
};

/**
 * The command line entry point: splits the sponsor wallet up to the
 * configured pool targets and prints the transaction id and the counts.
 * Secrets are read through the configuration loader only and are never
 * printed.
 */
const main = async (): Promise<void> => {
  loadEnvFile({ quiet: true });
  const config = loadConfig();
  delete process.env.SPONSOR_MNEMONIC;
  delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  delete process.env.ADMIN_API_KEY;

  await Cometa.ready();
  const provider = new Cometa.BlockfrostProvider({ network: Cometa.NetworkMagic.Preprod, projectId: config.blockfrostProjectId });
  const serviceWallet = await loadServiceWallet(config, provider);
  const db = openDatabase(config.databasePath);
  applyMigrations(db);
  const sync = createPoolSync({ db, provider, sponsorAddress: serviceWallet.address, sizes: config, slots: config.slots });
  const replenish = createReplenish({ db, provider, serviceWallet, sync, settings: config });

  const result = await replenish();
  if (result.txId === undefined) {
    console.log('The pool is already at its targets; nothing to split');
  } else {
    console.log(`Split ${result.txId} created ${result.feeOutputs} fee and ${result.collateralOutputs} collateral UTxOs`);
  }
  console.log(`Reserve: ${result.reserveLovelace} lovelace`);
  db.close();
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Replenish failed: ${message}`);
    process.exit(1);
  });
}
