import type { CoinSelector, PlutusData, PlutusScript, TransactionBuilder, TxEvaluator, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { CollateralBody, LeaseBody, SponsorUtxoBody } from '../../src/api.js';
import {
  AGENT_KEY,
  CONTROL_LOVELACE,
  DEVICE_KEY,
  type Grant,
  accountAddress,
  accountRewardAddress,
  accountScript,
  createAccountRedeemer,
  deviceRedeemer,
  encodeAccountState,
  encodeGrant,
  fixtureGrant,
  fundRedeemer,
  grantAfterSpend,
  initialStateUnder,
  logicHash,
  logicScript,
  otherLogicHash,
  otherLogicScript,
  parkedLogicUtxo,
  parkedOtherLogicUtxo,
  parkedProxyUtxo,
  operateRedeemer,
  reserveDatum,
  rewardAddressOf,
  runRedeemer,
  spendWithGrantRedeemer,
  stakeScript,
  stateNftAssetId,
  strangerAddress,
  upgradedState,
} from './account.js';
import { PROTOCOL_PARAMETERS, fakeExecutionUnits } from './fake.js';
import type { TestService } from './service.js';
import { transactionParts } from './transaction.js';

/** A step a test applies to a builder before it builds, to bend an otherwise valid transaction. */
export type Customise = (builder: TransactionBuilder) => void;

/** How a client builds on a lease: optionally with an evaluator of its own instead of the fake chain's, and a validity bound of its own. */
export interface ClientOptions {
  evaluator?: TxEvaluator;
  /** When the transaction stops being valid; the lease expiry unless said otherwise, and never set when null. */
  validUntil?: Date | null;
  /**
   * Takes the proxy and the logic from the UTxOs they are parked at
   * instead of embedding them, as a client on a network that records
   * reference scripts builds; the test must put those UTxOs on the chain.
   */
  referenced?: boolean;
  /**
   * The logic the transaction runs through its zero withdrawal, and that
   * a creation's control output names; the one the fixtures run unless
   * said otherwise.
   */
  logic?: string;
  /**
   * The lovelace the logic withdrawal draws, zero unless said otherwise,
   * for a transaction built to be refused for drawing anything.
   */
  logicAmount?: bigint;
  customise?: Customise;
}

/** How a client shapes an account creation beyond the fixtures' defaults: the control output's lovelace and address, and the owner device. */
export interface CreationOptions extends ClientOptions {
  controlLovelace?: bigint;
  controlAddress?: string;
  /** The key that owns the account and signs its creation; the fixture device unless said otherwise. */
  device?: string;
  /** The datum the control output carries in place of the initial state, for a creation writing a state of another shape. */
  state?: PlutusData;
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

/**
 * How a client shapes an agent spend beyond the fixtures' defaults: the
 * lovelace paid away and to whom, the grant the grant UTxO carries, and
 * the key that signs as the grantee.
 */
export interface AgentSpendOptions extends ClientOptions {
  lovelace?: bigint;
  recipient?: string;
  grant?: Grant;
  grantee?: string;
}

/** The UTxOs an agent spend builds on: the control UTxO it references, when it references one, the grant UTxO it spends and the fund UTxO that pays. */
export interface AgentSpendUtxos {
  control?: UTxO;
  grant: UTxO;
  fund: UTxO;
}

/** How far before the end of the collateral validity window a client in collateral mode sets its validity upper bound. */
export const COLLATERAL_BOUND_MARGIN_MS = 60_000;

/** The lovelace an agent spend pays away unless a test says otherwise. */
export const AGENT_SPEND_LOVELACE = 3_000_000n;

/** The lovelace a reserve output keeps at least, above the minimum UTxO value of a datum carrying output. */
const RESERVE_FLOOR = 2_000_000n;

/** The most times a reserve paid operation is built while its fee settles. */
const MAX_BALANCING_ROUNDS = 4;

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

/** A Plutus data value as an inline datum. */
const inlineDatum = (data: PlutusData): { type: typeof Cometa.DatumType.InlineData; inlineDatum: PlutusData } => ({ type: Cometa.DatumType.InlineData, inlineDatum: data });

/** The logic script of a hash the fixtures hold one for. */
const logicScriptOf = (logic: string): PlutusScript => {
  if (logic === logicHash) {
    return logicScript;
  }
  if (logic === otherLogicHash) {
    return otherLogicScript;
  }
  throw new Error(`The fixtures hold no logic script hashing to ${logic}`);
};

/** The parked UTxO the fixtures hold for a logic, when they park one for it. */
const parkedLogicUtxoOf = (logic: string): UTxO | undefined =>
  logic === logicHash ? parkedLogicUtxo : logic === otherLogicHash ? parkedOtherLogicUtxo : undefined;

/** Attaches the account proxy to the transaction, or references the UTxO it is parked at when the options ask for that. */
const attachProxy = (builder: TransactionBuilder, options: ClientOptions): TransactionBuilder =>
  options.referenced === true ? builder.addReferenceInput(parkedProxyUtxo) : builder.addScript(accountScript);

/**
 * Runs a logic over the transaction, as the proxy requires of every
 * account transaction but a plain deposit: a withdrawal of zero from the
 * logic's reward account under the Run redeemer, or of whatever
 * `logicAmount` says, with the logic script
 * attached or referenced from the UTxO it is parked at. The logic the
 * fixture accounts run is the one withdrawn from unless another is named.
 */
export const runLogic = (
  builder: TransactionBuilder,
  options: ClientOptions = {},
  logic: string = options.logic ?? logicHash,
): TransactionBuilder => {
  const parked = options.referenced === true ? parkedLogicUtxoOf(logic) : undefined;
  const attached = parked === undefined ? builder.addScript(logicScriptOf(logic)) : builder.addReferenceInput(parked);
  return attached.withdrawRewards({ rewardAddress: rewardAddressOf(logic), amount: options.logicAmount ?? 0n, redeemer: runRedeemer });
};

/**
 * Shapes a builder into an account creation, as the contract's builder
 * does on a sponsor's builder: the stake credential is registered with
 * its deposit, the state NFT is minted into a control output at the
 * account address with the initial state inline, naming the logic the
 * account starts under, that logic withdraws zero so that it validates
 * the arriving state, the owner device signs, and whatever the builder
 * spends pays for all of it.
 */
export const shapeCreation = (builder: TransactionBuilder, options: CreationOptions = {}): TransactionBuilder => {
  const device = options.device ?? DEVICE_KEY;
  const logic = options.logic ?? logicHash;
  builder.registerStakeAddress({ rewardAddress: accountRewardAddress, redeemer: operateRedeemer });
  builder.mintToken({ assetIdHex: stateNftAssetId, amount: 1n, redeemer: createAccountRedeemer });
  builder.lockValue({
    scriptAddress: options.controlAddress ?? accountAddress,
    value: { coins: options.controlLovelace ?? CONTROL_LOVELACE, assets: { [stateNftAssetId]: 1n } },
    datum: inlineDatum(options.state ?? encodeAccountState(initialStateUnder(logic, device))),
  });
  runLogic(builder, options, logic);
  attachProxy(builder.addSigner(device), options).addScript(stakeScript);
  options.customise?.(builder);
  return builder;
};

/** Builds an account creation on the lease, with the sponsor paying for all of it. */
export const buildCreation = (service: TestService, lease: LeaseBody, options: CreationOptions = {}): Promise<string> =>
  shapeCreation(clientBuilder(service, lease, options), options).build();

/**
 * Shapes a builder into an owner operation: the control UTxO is spent
 * with the device redeemer and recreated with its own state, unless
 * another state is written back, the logic the spent datum names runs
 * through its zero withdrawal, the device signs, and whatever the builder
 * spends pays the fee.
 */
export const shapeOwnerOperation = (
  builder: TransactionBuilder,
  control: UTxO,
  device: string = DEVICE_KEY,
  options: ClientOptions = {},
  newState?: PlutusData,
): TransactionBuilder => {
  builder.addInput({ utxo: control, redeemer: deviceRedeemer });
  builder.lockValue({
    scriptAddress: accountAddress,
    value: control.output.value,
    datum: inlineDatum(newState ?? control.output.datum ?? encodeAccountState(initialStateUnder(logicHash, device))),
  });
  runLogic(builder, options);
  return attachProxy(builder.addSigner(device), options);
};

/** Builds an owner operation on the lease, with the sponsor paying the fee, which the fee route refuses. */
export const buildOwnerOperation = async (
  service: TestService,
  lease: LeaseBody,
  control: UTxO,
  options: ClientOptions = {},
): Promise<string> => {
  const builder = shapeOwnerOperation(clientBuilder(service, lease, options), control, DEVICE_KEY, options);
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
  const builder = shapeOwnerOperation(collateralClientBuilder(service, collateral, options), control, options.device, options);
  builder.addInput({ utxo: fund, redeemer: fundRedeemer });
  options.customise?.(builder);
  return builder.build();
};

/**
 * Builds an upgrade paid from the account: the control UTxO is spent and
 * written back naming `newLogic` with the grant generation bumped, and
 * both logics withdraw, the one the account leaves because the proxy
 * requires the logic the spent datum names and the one it arrives at
 * because the leaving logic requires it.
 */
export const buildUpgrade = async (
  service: TestService,
  collateral: CollateralBody,
  control: UTxO,
  fund: UTxO,
  newLogic: string,
  options: CollateralOptions = {},
): Promise<string> => {
  const builder = shapeOwnerOperation(collateralClientBuilder(service, collateral, options), control, options.device, options, upgradedState(newLogic));
  builder.addInput({ utxo: fund, redeemer: fundRedeemer });
  runLogic(builder, options, newLogic);
  options.customise?.(builder);
  return builder.build();
};

/**
 * Builds an owner operation paid from a reserve, as the contract's
 * builder does without a sponsor: the reserve is spent alongside the
 * control UTxO and recreated under its datum with exactly the fee taken
 * out, so that no fund UTxO an agent may be spending is touched and
 * nothing but the reserve changes. The fee is only known once the
 * transaction is built, so the transaction is built again with the fee
 * fixed until it settles, as the contract's builder does.
 */
export const buildReservePaidOperation = async (
  service: TestService,
  collateral: CollateralBody,
  control: UTxO,
  reserve: UTxO,
  options: CollateralOptions = {},
): Promise<string> => {
  let reserveCoins = RESERVE_FLOOR;
  let assumedFee: bigint | undefined;
  for (let round = 0; round < MAX_BALANCING_ROUNDS; round += 1) {
    const builder = shapeOwnerOperation(collateralClientBuilder(service, collateral, options), control, options.device, options);
    if (assumedFee !== undefined) {
      builder.setMinimumFee(assumedFee);
    }
    builder.addInput({ utxo: reserve, redeemer: fundRedeemer });
    builder.lockValue({ scriptAddress: accountAddress, value: { coins: reserveCoins }, datum: inlineDatum(reserve.output.datum ?? reserveDatum) });
    options.customise?.(builder);
    const tx = await builder.build();
    const fee = transactionParts(tx).fee;
    if (fee === assumedFee) {
      return tx;
    }
    assumedFee = fee;
    reserveCoins = reserve.output.value.coins - fee;
  }
  throw new Error('The reserve paid operation did not settle on a fee');
};

/**
 * Shapes a builder into an agent spend: the grant UTxO is spent with the
 * grant redeemer and recreated with the same value and the grant's
 * remaining cap reduced by the payout and the fee bound, a fund UTxO is
 * spent with the fund redeemer and pays the payout, the control UTxO is
 * referenced and never spent, the logic it names runs through its zero
 * withdrawal, and the grantee signs; whatever the builder spends pays
 * the fee.
 */
const shapeAgentSpend = (builder: TransactionBuilder, { control, grant, fund }: AgentSpendUtxos, options: AgentSpendOptions): TransactionBuilder => {
  const lovelace = options.lovelace ?? AGENT_SPEND_LOVELACE;
  const spent = options.grant ?? fixtureGrant;
  if (control !== undefined) {
    builder.addReferenceInput(control);
  }
  builder.addInput({ utxo: grant, redeemer: spendWithGrantRedeemer });
  builder.addInput({ utxo: fund, redeemer: fundRedeemer });
  builder.lockValue({ scriptAddress: accountAddress, value: grant.output.value, datum: inlineDatum(encodeGrant(grantAfterSpend(spent, lovelace))) });
  builder.sendLovelace({ address: options.recipient ?? strangerAddress, amount: lovelace });
  runLogic(builder, options);
  attachProxy(builder.addSigner(options.grantee ?? AGENT_KEY), options);
  options.customise?.(builder);
  return builder;
};

/**
 * Builds an agent spend paid from the account, as the contract's builder
 * does with a collateral wallet: the fund UTxO pays the fee and the
 * payout with the change back to the account, and the sponsor
 * contributes the shared collateral only.
 */
export const buildAgentSpend = (service: TestService, collateral: CollateralBody, utxos: AgentSpendUtxos, options: AgentSpendOptions = {}): Promise<string> =>
  shapeAgentSpend(collateralClientBuilder(service, collateral, options), utxos, options).build();

/** Builds an agent spend on the lease, with the leased fee UTxO spent and the sponsor paying the fee, which the fee route refuses. */
export const buildAgentSpendOnLease = (service: TestService, lease: LeaseBody, utxos: AgentSpendUtxos, options: AgentSpendOptions = {}): Promise<string> =>
  shapeAgentSpend(clientBuilder(service, lease, options).addInput({ utxo: sponsorUtxo(lease.fee) }), utxos, options).build();
