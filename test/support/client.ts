import type { CoinSelector, TransactionBuilder, TxEvaluator, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { CollateralBody, LeaseBody, SponsorUtxoBody } from '../../src/api.js';
import {
  accountAddress,
  accountRewardAddress,
  accountScript,
  initialStateOf,
  stakeScript,
  stateNftAssetId,
  unitRedeemer,
  DEVICE_KEY,
  CONTROL_LOVELACE,
} from './account.js';
import { PROTOCOL_PARAMETERS, fakeExecutionUnits } from './fake.js';
import type { TestService } from './service.js';

/** A step a test applies to a builder before it builds, to bend an otherwise valid transaction. */
export type Customise = (builder: TransactionBuilder) => void;

/** How a client builds on a lease: optionally with an evaluator of its own instead of the fake chain's, and a validity bound of its own. */
export interface ClientOptions {
  evaluator?: TxEvaluator;
  /** When the transaction stops being valid; the lease expiry unless said otherwise, and never set when null. */
  validUntil?: Date | null;
  customise?: Customise;
}

/** How a client shapes an account creation beyond the fixtures' defaults: the control output's lovelace and address, and the owner device. */
export interface CreationOptions extends ClientOptions {
  controlLovelace?: bigint;
  controlAddress?: string;
  /** The key that owns the account and signs its creation; the fixture device unless said otherwise. */
  device?: string;
}

/**
 * How a client builds in collateral mode beyond the fixtures' defaults:
 * the device that signs, and the address its change returns to, the
 * account address unless said otherwise.
 */
export interface CollateralOptions extends ClientOptions {
  device?: string;
  changeAddress?: string;
}

/** How far before the end of the collateral validity window a client in collateral mode sets its validity upper bound. */
export const COLLATERAL_BOUND_MARGIN_MS = 60_000;

/** The UTxO a sponsor UTxO of the API response resolves to. */
export const sponsorUtxo = (utxo: SponsorUtxoBody): UTxO => ({
  input: { txId: utxo.txHash, index: utxo.index },
  output: { address: utxo.address, value: { coins: BigInt(utxo.lovelace) } },
});

/** An evaluator that trusts every redeemer with the fake budget and checks nothing, as a careless client might use. */
export const lenientEvaluator: TxEvaluator = {
  getName: () => 'Lenient evaluator',
  evaluate: (tx) => Promise.resolve(Cometa.readRedeemersFromTx(tx).map((redeemer) => ({ ...redeemer, executionUnits: fakeExecutionUnits(redeemer) }))),
};

/** An evaluator that gives every redeemer a token budget, as a client bent on a phase two failure would declare. */
export const underDeclaringEvaluator: TxEvaluator = {
  getName: () => 'Under declaring evaluator',
  evaluate: (tx) => Promise.resolve(Cometa.readRedeemersFromTx(tx).map((redeemer) => ({ ...redeemer, executionUnits: { memory: 1, steps: 1 } }))),
};

/** A coin selector that spends nothing beyond the inputs added explicitly, as a client paying from the account's own UTxOs builds. */
const explicitInputsOnly: CoinSelector = {
  getName: () => 'Explicit inputs only',
  select: ({ preSelectedUtxo, availableUtxo }) => Promise.resolve({ selection: preSelectedUtxo ?? [], remaining: availableUtxo }),
};

/** A builder over the fake chain's parameters and evaluator, or the evaluator a test supplies. */
const baseBuilder = (service: TestService, options: ClientOptions): TransactionBuilder =>
  Cometa.TransactionBuilder.create({ params: PROTOCOL_PARAMETERS, slotConfig: Cometa.CARDANO_PREPROD_SLOT_CONFIG }).setTxEvaluator(
    options.evaluator ?? { getName: () => 'Fake chain', evaluate: (tx) => service.provider.evaluateTransaction(tx) },
  );

/** The builder with the validity upper bound a client sets: `fallback` unless the options say otherwise, and none when they say null. */
const withValidity = (builder: TransactionBuilder, options: ClientOptions, fallback: Date): TransactionBuilder => {
  const validUntil = options.validUntil === undefined ? fallback : options.validUntil;
  return validUntil === null ? builder : builder.expiresAfter(validUntil);
};

/**
 * A builder set up the way a client of the service sets one up on a
 * lease: the leased fee UTxO is the only spendable UTxO, the shared
 * collateral UTxO the only collateral, both change outputs go to the
 * sponsor, and the transaction expires with the lease.
 */
export const clientBuilder = (service: TestService, lease: LeaseBody, options: ClientOptions = {}): TransactionBuilder => {
  const builder = baseBuilder(service, options)
    .setUtxos([sponsorUtxo(lease.fee)])
    .setCollateralUtxos([sponsorUtxo(lease.collateral)])
    .setChangeAddress(lease.sponsorAddress)
    .setCollateralChangeAddress(lease.sponsorAddress);
  return withValidity(builder, options, new Date(lease.expiresAt));
};

/**
 * A builder set up the way a client in collateral mode sets one up: no
 * sponsor UTxO to spend, the shared collateral UTxO as the only
 * collateral with its return to the sponsor, the change to the account,
 * and the transaction expiring within the collateral validity window.
 */
export const collateralClientBuilder = (service: TestService, collateral: CollateralBody, options: CollateralOptions = {}): TransactionBuilder => {
  const builder = baseBuilder(service, options)
    .setUtxos([])
    .setCoinSelector(explicitInputsOnly)
    .setCollateralUtxos([sponsorUtxo(collateral)])
    .setChangeAddress(options.changeAddress ?? accountAddress)
    .setCollateralChangeAddress(collateral.sponsorAddress);
  return withValidity(builder, options, new Date(service.clock.now.getTime() + collateral.validitySeconds * 1000 - COLLATERAL_BOUND_MARGIN_MS));
};

/** The inline datum of a control output carrying the initial state of an account owned by `device`. */
const stateDatum = (device: string): { type: typeof Cometa.DatumType.InlineData; inlineDatum: ReturnType<typeof initialStateOf> } => ({
  type: Cometa.DatumType.InlineData,
  inlineDatum: initialStateOf(device),
});

/**
 * Shapes a builder into an account creation, as the contract's builder
 * does on a sponsor's builder: the stake credential is registered with
 * its deposit, the state NFT is minted into a control output at the
 * account address with the initial state inline, the owner device signs,
 * and whatever the builder spends pays for all of it.
 */
export const shapeCreation = (builder: TransactionBuilder, options: CreationOptions = {}): TransactionBuilder => {
  const device = options.device ?? DEVICE_KEY;
  builder.registerStakeAddress({ rewardAddress: accountRewardAddress, redeemer: unitRedeemer });
  builder.mintToken({ assetIdHex: stateNftAssetId, amount: 1n, redeemer: unitRedeemer });
  builder.lockValue({
    scriptAddress: options.controlAddress ?? accountAddress,
    value: { coins: options.controlLovelace ?? CONTROL_LOVELACE, assets: { [stateNftAssetId]: 1n } },
    datum: stateDatum(device),
  });
  builder.addSigner(device).addScript(accountScript).addScript(stakeScript);
  options.customise?.(builder);
  return builder;
};

/** Builds an account creation on the lease, with the sponsor paying for all of it. */
export const buildCreation = (service: TestService, lease: LeaseBody, options: CreationOptions = {}): Promise<string> =>
  shapeCreation(clientBuilder(service, lease, options), options).build();

/**
 * Shapes a builder into an owner operation: the control UTxO is spent
 * with the device redeemer and recreated unchanged, the device signs,
 * and whatever the builder spends pays the fee.
 */
export const shapeOwnerOperation = (builder: TransactionBuilder, control: UTxO, device: string = DEVICE_KEY): TransactionBuilder => {
  builder.addInput({ utxo: control, redeemer: unitRedeemer });
  builder.lockValue({ scriptAddress: accountAddress, value: control.output.value, datum: stateDatum(device) });
  return builder.addSigner(device).addScript(accountScript);
};

/** Builds an owner operation on the lease, with the sponsor paying the fee. */
export const buildOwnerOperation = async (
  service: TestService,
  lease: LeaseBody,
  control: UTxO,
  options: ClientOptions = {},
): Promise<string> => {
  const builder = shapeOwnerOperation(clientBuilder(service, lease, options), control);
  options.customise?.(builder);
  return builder.build();
};

/**
 * Builds an owner operation paid from the account: a fund UTxO of the
 * account is spent alongside the control UTxO, the fee and the change
 * come out of it, and the sponsor contributes the shared collateral only.
 */
export const buildAccountPaidOperation = async (
  service: TestService,
  collateral: CollateralBody,
  control: UTxO,
  fund: UTxO,
  options: CollateralOptions = {},
): Promise<string> => {
  const builder = shapeOwnerOperation(collateralClientBuilder(service, collateral, options), control, options.device);
  builder.addInput({ utxo: fund, redeemer: unitRedeemer });
  options.customise?.(builder);
  return builder.build();
};
