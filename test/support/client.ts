import type { TransactionBuilder, TxEvaluator, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { LeaseBody, LeasedUtxoBody } from '../../src/http/leases.js';
import {
  accountAddress,
  accountRewardAddress,
  accountScript,
  initialState,
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

/** How a client builds on a lease: optionally with an evaluator of its own instead of the fake chain's. */
export interface ClientOptions {
  evaluator?: TxEvaluator;
  customise?: Customise;
}

/** How a client shapes an account creation beyond the fixtures' defaults: the control output's lovelace and address. */
export interface CreationOptions extends ClientOptions {
  controlLovelace?: bigint;
  controlAddress?: string;
}

/** The UTxO a leased UTxO of the API response resolves to. */
export const leasedUtxo = (utxo: LeasedUtxoBody): UTxO => ({
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

/**
 * A builder set up the way a client of the service sets one up: the
 * leased fee UTxO is the only spendable UTxO, the leased collateral UTxO
 * the only collateral, and both change outputs go to the sponsor.
 */
export const clientBuilder = (service: TestService, lease: LeaseBody, options: ClientOptions = {}): TransactionBuilder =>
  Cometa.TransactionBuilder.create({ params: PROTOCOL_PARAMETERS, slotConfig: Cometa.CARDANO_PREPROD_SLOT_CONFIG })
    .setTxEvaluator(options.evaluator ?? { getName: () => 'Fake chain', evaluate: (tx) => service.provider.evaluateTransaction(tx) })
    .setUtxos([leasedUtxo(lease.fee)])
    .setCollateralUtxos([leasedUtxo(lease.collateral)])
    .setChangeAddress(lease.sponsorAddress)
    .setCollateralChangeAddress(lease.sponsorAddress);

/** The inline datum of a control output carrying the initial state. */
const stateDatum = { type: Cometa.DatumType.InlineData, inlineDatum: initialState } as const;

/**
 * Builds an account creation on the lease, as the contract's builder
 * does with a sponsor: the stake credential is registered with its
 * deposit, the state NFT is minted into a control output at the account
 * address, the owner device signs, and the sponsor pays for all of it.
 */
export const buildCreation = async (service: TestService, lease: LeaseBody, options: CreationOptions = {}): Promise<string> => {
  const builder = clientBuilder(service, lease, options);
  builder.registerStakeAddress({ rewardAddress: accountRewardAddress, redeemer: unitRedeemer });
  builder.mintToken({ assetIdHex: stateNftAssetId, amount: 1n, redeemer: unitRedeemer });
  builder.lockValue({
    scriptAddress: options.controlAddress ?? accountAddress,
    value: { coins: options.controlLovelace ?? CONTROL_LOVELACE, assets: { [stateNftAssetId]: 1n } },
    datum: stateDatum,
  });
  builder.addSigner(DEVICE_KEY).addScript(accountScript).addScript(stakeScript);
  options.customise?.(builder);
  return builder.build();
};

/**
 * Builds an owner operation on the lease: the control UTxO is spent with
 * the device redeemer and recreated unchanged, the device signs, and the
 * sponsor pays the fee.
 */
export const buildOwnerOperation = async (
  service: TestService,
  lease: LeaseBody,
  control: UTxO,
  options: ClientOptions = {},
): Promise<string> => {
  const builder = clientBuilder(service, lease, options);
  builder.addInput({ utxo: control, redeemer: unitRedeemer });
  builder.lockValue({ scriptAddress: accountAddress, value: control.output.value, datum: stateDatum });
  builder.addSigner(DEVICE_KEY).addScript(accountScript);
  options.customise?.(builder);
  return builder.build();
};
