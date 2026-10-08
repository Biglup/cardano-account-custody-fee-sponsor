import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { CollateralBody, LeaseBody } from '../../src/api.js';
import { parseTransaction } from '../../src/policy/parse.js';
import { scriptIntegrityHash, witnessScriptData } from '../../src/policy/script-data.js';
import {
  burnGrantsRedeemer,
  controlUtxo,
  fundRedeemer,
  fundUtxo,
  grantAssetId,
  grantUtxo,
  grantedState,
  otherLogicHash,
  parkedLogicUtxo,
  parkedOtherLogicUtxo,
  parkedProxyUtxo,
  reserveDatum,
  accountAddress,
  sweepGrantRedeemer,
} from '../support/account.js';
import {
  buildAccountPaidOperation,
  buildAgentSpend,
  buildCreation,
  buildOwnerOperation,
  buildUpgrade,
} from '../support/client.js';
import { PROTOCOL_PARAMETERS } from '../support/fake.js';
import { type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;
let lease: LeaseBody;
let shared: CollateralBody;

beforeEach(async () => {
  service = await createTestService();
  service.fund(txHash(100), 0, 100_000_000n);
  service.fund(txHash(200), 0, 5_000_000n);
  await service.sync.run();
  const { apiKey } = service.issueKey();
  const bearer = { Authorization: `Bearer ${apiKey}` };
  lease = (await request(service.app).post('/v1/leases').set(bearer)).body as LeaseBody;
  shared = (await request(service.app).get('/v1/collateral').set(bearer)).body as CollateralBody;
});

afterEach(() => {
  service.close();
});

/** The Plutus languages the vectors below are written for. */
const V1 = Cometa.PlutusLanguageVersion.V1;
const V2 = Cometa.PlutusLanguageVersion.V2;

/** The number of entries a Plutus V1 and a Plutus V2 cost model hold. */
const V1_COST_MODEL_LENGTH = 166;
const V2_COST_MODEL_LENGTH = 175;

/** The view of an all zero Plutus V1 cost model: an indefinite length list bagged as a byte string. */
const ZERO_V1_VIEW = `58a89f${'00'.repeat(V1_COST_MODEL_LENGTH)}ff`;

/** The view of an all zero Plutus V2 cost model: a definite length list. */
const ZERO_V2_VIEW = `98af${'00'.repeat(V2_COST_MODEL_LENGTH)}`;

/** A redeemer map standing in for whatever a witness set carries, since the hash is taken over its bytes and never read. */
const REDEEMERS = 'a1820000821a000f42401a05f5e100';

/** The blake2b-256 digest of a hex encoded preimage. */
const digestOf = (preimage: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(preimage), 32));

/** The script data hash the policy computes from a transaction's witness set, under the cost models the chain reports. */
const computed = (transaction: string): string | undefined =>
  scriptIntegrityHash(witnessScriptData(transaction), [Cometa.PlutusLanguageVersion.V3], PROTOCOL_PARAMETERS);

/** The script data hash the transaction's own body commits to. */
const committed = (transaction: string): string | undefined => parseTransaction(transaction).transaction?.scriptDataHash;

/** The number of redeemers the transaction carries. */
const redeemerCount = (transaction: string): number => parseTransaction(transaction).transaction?.redeemers.length ?? 0;

/** Expects the hash computed from the witness set to be the one the body commits to. */
const expectAgreement = (transaction: string): void => {
  expect(committed(transaction)).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  expect(computed(transaction)).toBe(committed(transaction));
};

/** Puts the UTxOs the proxy and the logics are parked at on the fake chain, as the setup of a network leaves them. */
const placeParkedScripts = (): void => {
  for (const parked of [parkedProxyUtxo, parkedLogicUtxo, parkedOtherLogicUtxo]) {
    service.provider.addUtxo(parked);
  }
};

/** Puts the account's control UTxO and a fund UTxO on the fake chain. */
const placeAccount = (): { control: UTxO; fund: UTxO } => {
  const control = controlUtxo(txHash(300));
  const fund = fundUtxo(txHash(301), 20_000_000n);
  service.provider.addUtxo(control);
  service.provider.addUtxo(fund);
  return { control, fund };
};

/** Puts an account that issued the fixture grant on the fake chain: its control UTxO, the grant UTxO and a fund UTxO. */
const placeGrantedAccount = (): { control: UTxO; grant: UTxO; fund: UTxO } => {
  const control = controlUtxo(txHash(300), undefined, grantedState);
  const grant = grantUtxo(txHash(302));
  const fund = fundUtxo(txHash(301), 20_000_000n);
  service.provider.addUtxo(control);
  service.provider.addUtxo(grant);
  service.provider.addUtxo(fund);
  return { control, grant, fund };
};

describe('script data hash', () => {
  it('agrees with the body of an account creation that embeds the scripts it runs', async () => {
    const transaction = await buildCreation(service, lease);

    expect(redeemerCount(transaction)).toBeGreaterThan(1);
    expectAgreement(transaction);
  });

  it('agrees with the body of an account creation that references the scripts it runs', async () => {
    placeParkedScripts();
    const transaction = await buildCreation(service, lease, { referenced: true });

    expectAgreement(transaction);
  });

  it('agrees with the body of an owner operation', async () => {
    const { control } = placeAccount();
    const transaction = await buildOwnerOperation(service, lease, control);

    expectAgreement(transaction);
  });

  it('agrees with the body of an agent spend', async () => {
    const { control, grant, fund } = placeGrantedAccount();
    const transaction = await buildAgentSpend(service, shared, { control, grant, fund });

    expectAgreement(transaction);
  });

  it('agrees with the body of a sweep of a dead grant UTxO', async () => {
    const { control, grant, fund } = placeGrantedAccount();
    const transaction = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) =>
        builder.addInput({ utxo: grant, redeemer: sweepGrantRedeemer }).mintToken({ assetIdHex: grantAssetId, amount: -1n, redeemer: burnGrantsRedeemer }),
    });

    expect(redeemerCount(transaction)).toBeGreaterThan(3);
    expectAgreement(transaction);
  });

  it('agrees with the body of an upgrade to another logic', async () => {
    placeParkedScripts();
    const { control, fund } = placeAccount();
    const transaction = await buildUpgrade(service, shared, control, fund, otherLogicHash, { referenced: true });

    expectAgreement(transaction);
  });

  it('agrees with the body of a transaction whose witness set carries a datum', async () => {
    const { control, fund } = placeAccount();
    const datum = Cometa.plutusDataToCbor(reserveDatum);
    const hashed: UTxO = {
      input: { txId: txHash(303), index: 0 },
      output: {
        address: accountAddress,
        value: { coins: 10_000_000n },
        datumHash: Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(datum), 32)),
      },
    };
    service.provider.addUtxo(hashed);
    const transaction = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: hashed, redeemer: fundRedeemer, datum: reserveDatum }),
    });

    expect(witnessScriptData(transaction).datums).toEqual(expect.any(String));
    expectAgreement(transaction);
  });

  it('bags the Plutus V1 view twice and leaves the later languages plain, in the canonical key order', () => {
    const parameters = {
      ...PROTOCOL_PARAMETERS,
      costModels: [
        { language: 'PlutusV1', costs: new Array(V1_COST_MODEL_LENGTH).fill(0) },
        { language: 'PlutusV2', costs: new Array(V2_COST_MODEL_LENGTH).fill(0) },
      ],
    };
    const views = `a201${ZERO_V2_VIEW}4100${ZERO_V1_VIEW}`;

    const hash = scriptIntegrityHash({ redeemers: REDEEMERS, datums: undefined }, [V2, V1], parameters);

    expect(hash).toBe(digestOf(`${REDEEMERS}${views}`));
  });

  it('stands an empty redeemer map in for a witness set that carries datums and no redeemers', () => {
    const datums = 'd9010281182a';

    const hash = scriptIntegrityHash({ redeemers: undefined, datums }, [], PROTOCOL_PARAMETERS);

    expect(hash).toBe(digestOf(`a0${datums}a0`));
  });

  it('calls for no hash at all when the witness set carries neither redeemers nor datums', () => {
    expect(scriptIntegrityHash({ redeemers: undefined, datums: undefined }, [], PROTOCOL_PARAMETERS)).toBeUndefined();
  });

  it('names the language as people write it when the parameters price no cost model for it', () => {
    const unpriced = { ...PROTOCOL_PARAMETERS, costModels: [{ language: 'PlutusV1', costs: new Array(V1_COST_MODEL_LENGTH).fill(0) }] };

    expect(() => scriptIntegrityHash({ redeemers: REDEEMERS, datums: undefined }, [Cometa.PlutusLanguageVersion.V3], unpriced)).toThrow(
      'The protocol parameters hold no cost model for Plutus V3',
    );
    expect(() => scriptIntegrityHash({ redeemers: REDEEMERS, datums: undefined }, [V2], unpriced)).toThrow('The protocol parameters hold no cost model for Plutus V2');
  });

  it('builds the language view from the cost models the chain reports, not from a fixed one', async () => {
    const transaction = await buildCreation(service, lease);
    const others = { ...PROTOCOL_PARAMETERS, costModels: [{ language: 'PlutusV3', costs: [1, 2, 3] }] };

    const underOthers = scriptIntegrityHash(witnessScriptData(transaction), [Cometa.PlutusLanguageVersion.V3], others);

    expect(underOthers).not.toBe(committed(transaction));
    expect(computed(transaction)).toBe(committed(transaction));
  });
});
