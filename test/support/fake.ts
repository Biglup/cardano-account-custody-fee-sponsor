import type { Address, NetworkMagic, Provider, ProtocolParameters, Redeemer, RewardAddress, TxIn, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';

/** A one half threshold, used wherever a governance threshold is needed. */
const half = { numerator: 1, denominator: 2 };

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
  costModels: [{ language: 'PlutusV3', costs: [] }],
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

/** The execution units the fake provider reports for every redeemer. */
export const FAKE_EXECUTION_UNITS = { memory: 1_500_000, steps: 700_000_000 };

/** The bech32 form of an address, used to key the canned UTxOs. */
const addressKey = (address: Address | string): string => (typeof address === 'string' ? address : address.toString());

/**
 * A provider serving canned UTxOs per address and fixed execution units.
 * It does not model script failures; the transaction policy tests that
 * need a failing evaluation call `setEvaluationFailure` to make the next
 * call to `evaluateTransaction` reject the way a real node would for a
 * transaction that fails phase two.
 */
export class FakeProvider implements Provider {
  private readonly utxosByAddress = new Map<string, UTxO[]>();
  private evaluationFailure: string | undefined;

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

  evaluateTransaction(tx: string): Promise<Redeemer[]> {
    if (this.evaluationFailure !== undefined) {
      return Promise.reject(new Error(this.evaluationFailure));
    }
    const redeemers = Cometa.readRedeemersFromTx(tx);
    return Promise.resolve(redeemers.map((redeemer) => ({ ...redeemer, executionUnits: FAKE_EXECUTION_UNITS })));
  }
}
