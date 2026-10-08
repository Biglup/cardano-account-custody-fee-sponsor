import type { Address, ExUnits, NetworkMagic, Provider, ProtocolParameters, Redeemer, RewardAddress, TxIn, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import { paymentCredentialOf } from '../../src/policy/parse.js';
import { transactionParts } from './transaction.js';

/** A one half threshold, used wherever a governance threshold is needed. */
const half = { numerator: 1, denominator: 2 };

/**
 * A Plutus V3 cost model: not the network's own, but long enough and
 * varied enough that the language view built from it is no degenerate
 * encoding, with a negative entry as the network's own model carries.
 */
const PLUTUS_V3_COSTS = [
  100788, 420, 1, 1, 1000, 173, 0, 1, 1000, 59957, 4, 1, 11183, 32, 201305, 8356, 4, 16000, 100, 16000, 100, 16000, 100, 16000, 100, 16000, 100, 16000,
  100, 100, 100, 16000, 100, 94375, 32, 132994, 32, 61462, 4, 72010, 178, 0, 1, 22151, 32, 91189, 769, 4, 2, 85848, 123203, 7305, -900, 1716, 549, 57,
  85848, 0, 1,
];

/** Protocol parameters close to preprod's, enough for fee and script data hash computation. */
export const PROTOCOL_PARAMETERS: ProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155381,
  maxBlockBodySize: 90112,
  maxTxSize: 16384,
  maxBlockHeaderSize: 1100,
  keyDeposit: 2_000_000,
  poolDeposit: 500_000_000,
  maxEpoch: 18,
  nOpt: 500,
  poolPledgeInfluence: { numerator: 3, denominator: 10 },
  treasuryGrowthRate: { numerator: 1, denominator: 5 },
  expansionRate: { numerator: 3, denominator: 1000 },
  decentralisationParam: { numerator: 0, denominator: 1 },
  extraEntropy: null,
  protocolVersion: { major: 10, minor: 0 },
  minPoolCost: 170_000_000,
  adaPerUtxoByte: 4310,
  costModels: [{ language: 'PlutusV3', costs: PLUTUS_V3_COSTS }],
  executionCosts: {
    memory: { numerator: 577, denominator: 10_000 },
    steps: { numerator: 721, denominator: 10_000_000 },
  },
  maxTxExUnits: { memory: 14_000_000, steps: 10_000_000_000 },
  maxBlockExUnits: { memory: 62_000_000, steps: 20_000_000_000 },
  maxValueSize: 5000,
  collateralPercent: 150,
  maxCollateralInputs: 3,
  poolVotingThresholds: {
    motionNoConfidence: half,
    committeeNormal: half,
    committeeNoConfidence: half,
    hardForkInitiation: half,
    securityRelevantParamVotingThreshold: half,
  },
  drepVotingThresholds: {
    motionNoConfidence: half,
    committeeNormal: half,
    committeeNoConfidence: half,
    hardForkInitiation: half,
    updateConstitution: half,
    ppNetworkGroup: half,
    ppEconomicGroup: half,
    ppTechnicalGroup: half,
    ppGovernanceGroup: half,
    treasuryWithdrawal: half,
  },
  minCommitteeSize: 0,
  committeeTermLimit: 146,
  governanceActionValidityPeriod: 6,
  governanceActionDeposit: 100_000_000_000,
  drepDeposit: 500_000_000,
  drepInactivityPeriod: 20,
  refScriptCostPerByte: { numerator: 15, denominator: 1 },
};

/** The execution units the fake provider reports by redeemer purpose: fixed, non trivial numbers of the order a real evaluation returns. */
const EXECUTION_UNITS_BY_PURPOSE: Record<string, ExUnits> = {
  spend: { memory: 1_500_000, steps: 700_000_000 },
  mint: { memory: 1_200_000, steps: 480_000_000 },
  certificate: { memory: 900_000, steps: 350_000_000 },
};

/** The execution units the fake provider reports for a redeemer of a purpose the table does not name. */
const DEFAULT_EXECUTION_UNITS: ExUnits = { memory: 600_000, steps: 250_000_000 };

/** The execution units the fake provider reports for a redeemer, whatever the redeemer declares. */
export const fakeExecutionUnits = (redeemer: Redeemer): ExUnits => EXECUTION_UNITS_BY_PURPOSE[redeemer.purpose] ?? DEFAULT_EXECUTION_UNITS;

/** The bech32 form of an address, used to key the canned UTxOs. */
const addressKey = (address: Address | string): string => (typeof address === 'string' ? address : address.toString());

/** Whether an address pays to a script, so that spending it needs a redeemer. */
const isScriptAddress = (address: string): boolean => paymentCredentialOf(address)?.type === Cometa.CredentialType.ScriptHash;

/**
 * A provider serving canned UTxOs per address and fixed execution units
 * per redeemer purpose, reported whatever the transaction declares, as a
 * real evaluator does. Evaluation models what a node checks before it
 * can run any script: every input must be known, and every input locked
 * by a script must come with a spend redeemer. It does not run the scripts themselves;
 * the policy tests that need a failing evaluation call
 * `setEvaluationFailure` to make the next call to `evaluateTransaction`
 * reject the way a real node would for a transaction that fails phase two,
 * and those that need a failing lookup call `setResolutionFailure`.
 * Evaluation yields to the event loop, for as long as `setEvaluationDelay`
 * says, as the round trip to a real evaluator does, so that tests can
 * have requests in flight at the same time interleave the way they would
 * in production.
 */
export class FakeProvider implements Provider {
  private readonly utxosByAddress = new Map<string, UTxO[]>();
  private evaluationFailure: string | undefined;
  private resolutionFailure: string | undefined;
  private evaluationDelayMs = 0;

  /** Makes a UTxO visible at its own address. */
  addUtxo(utxo: UTxO): void {
    const list = this.utxosByAddress.get(utxo.output.address) ?? [];
    list.push(utxo);
    this.utxosByAddress.set(utxo.output.address, list);
  }

  /** Removes a UTxO, as spending it would. */
  removeUtxo(txIn: TxIn): void {
    for (const [address, list] of this.utxosByAddress) {
      this.utxosByAddress.set(
        address,
        list.filter((utxo) => !(utxo.input.txId === txIn.txId && utxo.input.index === txIn.index)),
      );
    }
  }

  /** Makes the next evaluation reject with `message`, or clears a prior failure when called with no argument. */
  setEvaluationFailure(message?: string): void {
    this.evaluationFailure = message;
  }

  /** Makes every evaluation take `ms` milliseconds, as a round trip to a real evaluator would. */
  setEvaluationDelay(ms: number): void {
    this.evaluationDelayMs = ms;
  }

  /** Makes every lookup of unspent outputs reject with `message`, as a provider refusing a batch with an input it does not know, or clears it. */
  setResolutionFailure(message?: string): void {
    this.resolutionFailure = message;
  }

  getName(): string {
    return 'Fake provider';
  }

  getNetworkMagic(): NetworkMagic {
    return Cometa.NetworkMagic.Preprod;
  }

  getRewardsBalance(_rewardAccount: RewardAddress | string): Promise<bigint> {
    return Promise.resolve(0n);
  }

  getParameters(): Promise<ProtocolParameters> {
    return Promise.resolve(PROTOCOL_PARAMETERS);
  }

  getUnspentOutputs(address: Address | string): Promise<UTxO[]> {
    return Promise.resolve([...(this.utxosByAddress.get(addressKey(address)) ?? [])]);
  }

  async getUnspentOutputsWithAsset(address: Address | string, assetId: string): Promise<UTxO[]> {
    const utxos = await this.getUnspentOutputs(address);
    return utxos.filter((utxo) => (utxo.output.value.assets?.[assetId] ?? 0n) > 0n);
  }

  getUnspentOutputByNft(assetId: string): Promise<UTxO> {
    const match = [...this.utxosByAddress.values()].flat().find((utxo) => (utxo.output.value.assets?.[assetId] ?? 0n) === 1n);
    return match ? Promise.resolve(match) : Promise.reject(new Error(`No UTxO holds ${assetId}`));
  }

  resolveUnspentOutputs(txIns: TxIn[]): Promise<UTxO[]> {
    if (this.resolutionFailure !== undefined) {
      return Promise.reject(new Error(this.resolutionFailure));
    }
    const all = [...this.utxosByAddress.values()].flat();
    return Promise.resolve(
      txIns.flatMap((txIn) => all.filter((utxo) => utxo.input.txId === txIn.txId && utxo.input.index === txIn.index)),
    );
  }

  resolveDatum(): Promise<string> {
    return Promise.reject(new Error('The fake provider holds no datums by hash'));
  }

  confirmTransaction(): Promise<boolean> {
    return Promise.resolve(true);
  }

  submitTransaction(_tx: string): Promise<string> {
    return Promise.reject(new Error('The fake provider does not submit transactions'));
  }

  async evaluateTransaction(tx: string, additionalUtxos: UTxO[] = []): Promise<Redeemer[]> {
    await new Promise((resolve) => setTimeout(resolve, this.evaluationDelayMs));
    if (this.evaluationFailure !== undefined) {
      throw new Error(this.evaluationFailure);
    }
    const redeemers = Cometa.readRedeemersFromTx(tx);
    const inputs = transactionParts(tx).inputs;
    const known = [...(await this.resolveUnspentOutputs(inputs)), ...additionalUtxos];
    inputs.forEach((input, index) => {
      const utxo = known.find((candidate) => candidate.input.txId === input.txId && candidate.input.index === input.index);
      if (!utxo) {
        throw new Error(`Input ${input.txId}#${input.index} is unknown`);
      }
      const hasRedeemer = redeemers.some((redeemer) => redeemer.purpose === Cometa.RedeemerPurpose.spend && redeemer.index === index);
      if (isScriptAddress(utxo.output.address) && !hasRedeemer) {
        throw new Error(`Input ${input.txId}#${input.index} is locked by a script but has no redeemer`);
      }
    });
    return redeemers.map((redeemer) => ({ ...redeemer, executionUnits: fakeExecutionUnits(redeemer) }));
  }
}
