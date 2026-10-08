import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { CollateralBody, LeaseBody } from '../../src/api.js';
import { parseTransaction } from '../../src/policy/parse.js';
import type { RuleName } from '../../src/policy/rules.js';
import {
  AGENT_KEY,
  DEVICE_KEY,
  accountAddress,
  accountRewardAddress,
  burnGrantsRedeemer,
  controlUtxo,
  deviceRedeemer,
  enterpriseAddress,
  foreignScript,
  fundUtxo,
  grantAssetId,
  grantUtxo,
  grantedState,
  logicHash,
  operateRedeemer,
  otherLogicHash,
  otherStakeScriptHash,
  parkedLogicUtxo,
  parkedOtherLogicUtxo,
  parkedProxyUtxo,
  reserveUtxo,
  rewardAddressOf,
  scriptUtxo,
  stakeScript,
  stakeScriptHash,
  stateNftAssetId,
  stateUnderLogic,
  stateWithoutLogic,
  strangerAddress,
  sweepGrantRedeemer,
} from '../support/account.js';
import {
  AGENT_SPEND_LOVELACE,
  buildAccountPaidOperation,
  buildAgentSpend,
  buildCreation,
  buildReservePaidOperation,
  buildUpgrade,
  collateralClientBuilder,
  sponsorUtxo,
  underDeclaringEvaluator,
} from '../support/client.js';
import { type TestService, createTestService, txHash } from '../support/service.js';
import { markInvalid, outputWithDatumHash, withCollateralReturn, withTotalCollateral } from '../support/transaction.js';

let service: TestService;
let apiKey: string;

beforeEach(async () => {
  service = await createTestService();
  apiKey = service.issueKey().apiKey;
});

afterEach(() => {
  service.close();
});

const bearer = (key: string = apiKey): Record<string, string> => ({ Authorization: `Bearer ${key}` });

/** Funds `fee` fee UTxOs and `collateral` collateral UTxOs and syncs the pool. */
const fundPool = async (fee = 0, collateral = 1): Promise<void> => {
  for (let i = 0; i < fee; i += 1) {
    service.fund(txHash(100 + i), 0, 100_000_000n);
  }
  for (let i = 0; i < collateral; i += 1) {
    service.fund(txHash(200 + i), 0, 5_000_000n);
  }
  await service.sync.run();
};

/** Reads the shared collateral through the API. */
const collateral = async (key: string = apiKey): Promise<CollateralBody> => {
  const response = await request(service.app).get('/v1/collateral').set(bearer(key));
  expect(response.status).toBe(200);
  return response.body as CollateralBody;
};

/** Asks for the collateral witness of a transaction. */
const witness = (transaction: unknown, key: string = apiKey): request.Test =>
  request(service.app).post('/v1/collateral/witness').set(bearer(key)).send({ transaction });

/** Puts the account's control UTxO and a fund UTxO on the fake chain. */
const placeAccount = (): { control: UTxO; fund: UTxO } => {
  const control = controlUtxo(txHash(300));
  const fund = fundUtxo(txHash(301), 20_000_000n);
  service.provider.addUtxo(control);
  service.provider.addUtxo(fund);
  return { control, fund };
};

/** Puts the UTxOs the proxy and the logic are parked at on the fake chain, as the setup of a network leaves them. */
const placeParkedScripts = (): void => {
  for (const parked of [parkedProxyUtxo, parkedLogicUtxo, parkedOtherLogicUtxo]) {
    service.provider.addUtxo(parked);
  }
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

/** The number of witnesses issued so far. */
const witnessCount = (): number => (service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count;

/** The audit rows written about witness requests, oldest first: their outcome and their parsed detail. */
const witnessAudit = (): { outcome: string; detail: Record<string, unknown> }[] =>
  (service.db.prepare("SELECT outcome, detail FROM audit WHERE action = 'witness' ORDER BY id").all() as { outcome: string; detail: string }[]).map(
    (row) => ({ outcome: row.outcome, detail: JSON.parse(row.detail) as Record<string, unknown> }),
  );

/** The hash of the one verification key in a witness set. */
const keyHashOf = (vkey: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(vkey), 28));

/** Expects a witness set carrying exactly the sponsor payment key's signature, and the transaction to need the sponsor and `signer` alone. */
const expectSponsorWitness = (witnessSet: string, transaction: string, resolved: UTxO[], signer: string): void => {
  const decoded = Cometa.readVkeyWitnessSetFromWitnessSetCbor(witnessSet);
  expect(decoded).toHaveLength(1);
  expect(keyHashOf(decoded[0]?.vkey ?? '')).toBe(service.serviceWallet.paymentKeyHash);
  expect(Cometa.getUniqueSigners(transaction, resolved).sort()).toEqual([signer, service.serviceWallet.paymentKeyHash].sort());
};

/** Expects a refusal naming exactly `rule`, recorded on the audit trail under the collateral mode. */
const expectViolation = (response: request.Response, rule: RuleName, detail: RegExp): void => {
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ error: 'invalid_transaction', rule, detail: expect.stringMatching(detail) });
  expect(witnessAudit().at(-1)).toEqual({ outcome: rule, detail: { mode: 'collateral', txHash: expect.any(String), rule, reason: expect.stringMatching(detail) } });
};

describe('GET /v1/collateral', () => {
  it('names the shared collateral UTxO, the sponsor address and the validity window', async () => {
    await fundPool(0, 2);

    const response = await request(service.app).get('/v1/collateral').set(bearer());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      txHash: txHash(200),
      index: 0,
      address: service.serviceWallet.address,
      lovelace: 5_000_000,
      sponsorAddress: service.serviceWallet.address,
      validitySeconds: 600,
    });
    service.fund(txHash(100), 0, 100_000_000n);
    const lease = (await request(service.app).post('/v1/leases').set(bearer())).body as LeaseBody;
    expect(lease.collateral).toEqual({ txHash: txHash(200), index: 0, address: service.serviceWallet.address, lovelace: 5_000_000 });
  });

  it('requires a client key', async () => {
    await fundPool();

    const response = await request(service.app).get('/v1/collateral');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('answers 503 out_of_funds when the pool holds no collateral UTxO and the reserve cannot fund one, after resyncing with the chain', async () => {
    const starved = await request(service.app).get('/v1/collateral').set(bearer());
    expect(starved.status).toBe(503);
    expect(starved.body).toEqual({ error: 'out_of_funds', detail: expect.stringMatching(/^The pool has no collateral UTxO and the reserve holds 0 lovelace/) });

    service.fund(txHash(200), 0, 5_000_000n);
    const found = await request(service.app).get('/v1/collateral').set(bearer());
    expect(found.status).toBe(200);
    expect(found.body.txHash).toBe(txHash(200));
  });
});

describe('POST /v1/collateral/witness', () => {
  it('witnesses an owner operation paid from the account with the sponsor payment key only', async () => {
    await fundPool();
    const { control, fund } = placeAccount();
    const shared = await collateral();
    const transaction = await buildAccountPaidOperation(service, shared, control, fund);
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.inputs).toEqual(expect.arrayContaining([control.input, fund.input]));
    expect(parsed?.inputs).toHaveLength(2);
    expect(parsed?.outputs.every((output) => output.address === accountAddress)).toBe(true);

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ txHash: parsed?.hash, witnessSet: expect.stringMatching(/^[0-9a-f]+$/) });
    const decoded = Cometa.readVkeyWitnessSetFromWitnessSetCbor(response.body.witnessSet);
    expect(decoded).toHaveLength(1);
    const [only] = decoded;
    expect(keyHashOf(only?.vkey ?? '')).toBe(service.serviceWallet.paymentKeyHash);
    const publicKey = Cometa.Ed25519PublicKey.fromHex(only?.vkey ?? '');
    expect(publicKey.verify(Cometa.Ed25519Signature.fromHex(only?.signature ?? ''), Cometa.hexToUint8Array(parsed?.hash ?? ''))).toBe(true);
    expect(Cometa.getUniqueSigners(transaction, [control, fund, sponsorUtxo(shared)]).sort()).toEqual([DEVICE_KEY, service.serviceWallet.paymentKeyHash].sort());

    const row = service.db.prepare('SELECT * FROM witnesses WHERE tx_hash = ?').get(parsed?.hash) as Record<string, unknown>;
    expect(row).toMatchObject({ lease_id: null, sponsored_lovelace: 0, witness_set: response.body.witnessSet, api_key_id: 1 });
    expect(witnessAudit()).toEqual([
      { outcome: 'issued', detail: { mode: 'collateral', txHash: parsed?.hash, kind: 'operation', sponsoredLovelace: 0, fee: parsed?.fee.toString() } },
    ]);
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM leases').get()).toEqual({ count: 0 });
    expect((await request(service.app).get('/health')).body.pool.collateral).toEqual({ shared: true, spare: 0, consumed: 0 });
  });

  it('witnesses an agent spend that spends the grant UTxO and a fund UTxO and references the control UTxO', async () => {
    await fundPool();
    const { control, grant, fund } = placeGrantedAccount();
    const shared = await collateral();
    const transaction = await buildAgentSpend(service, shared, { control, grant, fund });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.inputs).toEqual(expect.arrayContaining([grant.input, fund.input]));
    expect(parsed?.inputs).toHaveLength(2);
    expect(parsed?.referenceInputs).toEqual([control.input]);
    expect(parsed?.outputs.find((output) => output.assets[grantAssetId] === 1n)?.address).toBe(accountAddress);
    expect(parsed?.outputs.find((output) => output.address === strangerAddress)?.lovelace).toBe(AGENT_SPEND_LOVELACE);

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ txHash: parsed?.hash, witnessSet: expect.stringMatching(/^[0-9a-f]+$/) });
    expectSponsorWitness(response.body.witnessSet, transaction, [grant, fund, sponsorUtxo(shared)], AGENT_KEY);
    expect(witnessAudit()).toEqual([
      { outcome: 'issued', detail: { mode: 'collateral', txHash: parsed?.hash, kind: 'operation', sponsoredLovelace: 0, fee: parsed?.fee.toString() } },
    ]);
  });

  it('witnesses an owner operation that takes the proxy and the logic from the UTxOs they are parked at', async () => {
    await fundPool();
    placeParkedScripts();
    const { control, fund } = placeAccount();
    const shared = await collateral();
    const transaction = await buildAccountPaidOperation(service, shared, control, fund, { referenced: true });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.scripts).toEqual([]);
    expect(parsed?.referenceInputs.map((input) => input.index).sort()).toEqual([parkedProxyUtxo.input.index, parkedLogicUtxo.input.index]);
    expect(parsed?.withdrawals.map((withdrawal) => withdrawal.credential?.hash)).toEqual([logicHash]);

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expectSponsorWitness(response.body.witnessSet, transaction, [control, fund, sponsorUtxo(shared)], DEVICE_KEY);
    expect(witnessAudit().at(-1)).toMatchObject({ outcome: 'issued', detail: { kind: 'operation', sponsoredLovelace: 0 } });
  });

  it('witnesses an owner operation paid from a reserve, recreated with the fee taken out', async () => {
    await fundPool();
    const { control } = placeAccount();
    const reserve = reserveUtxo(txHash(303), 20_000_000n);
    service.provider.addUtxo(reserve);
    const shared = await collateral();
    const transaction = await buildReservePaidOperation(service, shared, control, reserve);
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.inputs).toEqual(expect.arrayContaining([control.input, reserve.input]));
    expect(parsed?.inputs).toHaveLength(2);
    expect(parsed?.outputs.every((output) => output.address === accountAddress)).toBe(true);
    const recreated = parsed?.outputs.find((output) => output.hasDatum && Object.keys(output.assets).length === 0);
    expect(recreated?.lovelace).toBe(reserve.output.value.coins - (parsed?.fee ?? 0n));

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expectSponsorWitness(response.body.witnessSet, transaction, [control, reserve, sponsorUtxo(shared)], DEVICE_KEY);
    expect(witnessAudit().at(-1)).toMatchObject({ outcome: 'issued', detail: { kind: 'operation', sponsoredLovelace: 0 } });
  });

  it('witnesses a sweep that spends the control UTxO and a dead grant UTxO and burns the grant token', async () => {
    await fundPool();
    const { control, grant, fund } = placeGrantedAccount();
    const shared = await collateral();
    const transaction = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: grant, redeemer: sweepGrantRedeemer }).mintToken({ assetIdHex: grantAssetId, amount: -1n, redeemer: burnGrantsRedeemer }),
    });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.mint).toEqual({ [grantAssetId]: -1n });

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expectSponsorWitness(response.body.witnessSet, transaction, [control, grant, fund, sponsorUtxo(shared)], DEVICE_KEY);
  });

  it('answers the same witness set again for the same transaction, counting once, and to both of two concurrent requests', async () => {
    await fundPool();
    const { control, fund } = placeAccount();
    const transaction = await buildAccountPaidOperation(service, await collateral(), control, fund);

    const first = await witness(transaction);
    const again = await witness(transaction);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(witnessCount()).toBe(1);
    expect(witnessAudit().map((row) => row.outcome)).toEqual(['issued', 'reissued']);

    const other = fundUtxo(txHash(302), 20_000_000n);
    service.provider.addUtxo(other);
    const second = await buildAccountPaidOperation(service, await collateral(), control, other);
    service.provider.setEvaluationDelay(20);
    const [left, right] = await Promise.all([witness(second), witness(second)]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect(right.body).toEqual(left.body);
    expect(witnessCount()).toBe(2);
    expect(witnessAudit().map((row) => row.outcome).sort()).toEqual(['issued', 'issued', 'reissued', 'reissued']);
  });

  it('serves many concurrent transactions over the one shared collateral UTxO', async () => {
    await fundPool();
    const { control } = placeAccount();
    const shared = await collateral();
    const transactions = [];
    for (let i = 0; i < 8; i += 1) {
      const fund = fundUtxo(txHash(400 + i), 20_000_000n);
      service.provider.addUtxo(fund);
      transactions.push(await buildAccountPaidOperation(service, shared, control, fund));
    }
    service.provider.setEvaluationDelay(20);

    const responses = await Promise.all(transactions.map((transaction) => witness(transaction)));

    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 8 }, () => 200));
    expect(new Set(responses.map((response) => response.body.txHash)).size).toBe(8);
    expect(witnessCount()).toBe(8);
    expect(service.db.prepare("SELECT status FROM pool_utxos WHERE tx_hash = ?").get(txHash(200))).toEqual({ status: 'free' });
  });

  it('counts the hourly witness quota across both modes and sponsors nothing against the daily one', async () => {
    await fundPool(1, 1);
    const { control, fund } = placeAccount();
    const key = service.issueKey('hourly', { witnessesPerHour: 1, sponsoredLovelacePerDay: 1 }).apiKey;
    const first = await witness(await buildAccountPaidOperation(service, await collateral(key), control, fund), key);
    expect(first.status).toBe(200);

    const other = fundUtxo(txHash(302), 20_000_000n);
    service.provider.addUtxo(other);
    const refused = await witness(await buildAccountPaidOperation(service, await collateral(key), control, other), key);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'quota_exceeded', detail: 'witnesses_per_hour: at most 1 witnesses per hour per key' });
    expect(witnessAudit().at(-1)).toEqual({
      outcome: 'quota_exceeded',
      detail: { mode: 'collateral', txHash: expect.any(String), quota: 'witnesses_per_hour', reason: 'witnesses_per_hour: at most 1 witnesses per hour per key' },
    });

    const lease = (await request(service.app).post('/v1/leases').set(bearer(key))).body as LeaseBody;
    const onLease = await request(service.app).post(`/v1/leases/${lease.leaseId}/witness`).set(bearer(key)).send({ transaction: await buildCreation(service, lease) });
    expect(onLease.status).toBe(429);
    expect(witnessCount()).toBe(1);
  });

  it('answers 400 invalid_request when the body carries no transaction, and 503 out_of_funds when no collateral is shared', async () => {
    await fundPool();
    const missing = await request(service.app).post('/v1/collateral/witness').set(bearer()).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_request');

    const { control, fund } = placeAccount();
    const transaction = await buildAccountPaidOperation(service, await collateral(), control, fund);
    service.provider.removeUtxo({ txId: txHash(200), index: 0 });
    await service.sync.run();

    const response = await witness(transaction);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'out_of_funds', detail: expect.stringMatching(/^The pool has no collateral UTxO/) });
    expect(witnessAudit().at(-1)).toEqual({ outcome: 'out_of_funds', detail: { mode: 'collateral', txHash: expect.any(String), reason: expect.stringMatching(/no collateral UTxO/) } });
  });
});

describe('collateral mode policy', () => {
  it('no_sponsor_inputs: refuses a sponsor input, the shared collateral UTxO spent as a regular input included', async () => {
    await fundPool(1, 1);
    const { control, fund } = placeAccount();
    const shared = await collateral();
    const fee: UTxO = { input: { txId: txHash(100), index: 0 }, output: { address: shared.sponsorAddress, value: { coins: 100_000_000n } } };

    const spendingFee = await buildAccountPaidOperation(service, shared, control, fund, { customise: (builder) => builder.addInput({ utxo: fee }) });
    expectViolation(await witness(spendingFee), 'no_sponsor_inputs', new RegExp(`Input ${txHash(100)}#0 belongs to the sponsor, which contributes collateral only`));

    const spendingCollateral = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: sponsorUtxo(shared) }).sendLovelace({ address: strangerAddress, amount: 5_000_000n }),
    });
    expectViolation(await witness(spendingCollateral), 'no_sponsor_inputs', new RegExp(`Input ${txHash(200)}#0 belongs to the sponsor, which contributes collateral only`));

    const bare: UTxO = { input: { txId: txHash(501), index: 0 }, output: { address: enterpriseAddress(service.serviceWallet.paymentKeyHash), value: { coins: 50_000_000n } } };
    service.provider.addUtxo(bare);
    const spendingBare = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: bare }).sendLovelace({ address: strangerAddress, amount: 50_000_000n }),
    });
    expectViolation(await witness(spendingBare), 'no_sponsor_inputs', new RegExp(`Input ${txHash(501)}#0 belongs to the sponsor`));
    expect(witnessCount()).toBe(0);
  });

  it('uses_shared_collateral: refuses collateral other than the shared UTxO, a missing or foreign return, an over declared total and a failing flag', async () => {
    await fundPool(0, 2);
    const { control, fund } = placeAccount();
    const shared = await collateral();
    const spare: UTxO = { input: { txId: txHash(201), index: 0 }, output: { address: shared.sponsorAddress, value: { coins: 5_000_000n } } };

    const wrong = await buildAccountPaidOperation(service, shared, control, fund, { customise: (builder) => builder.setCollateralUtxos([spare]) });
    expectViolation(await witness(wrong), 'uses_shared_collateral', new RegExp(`collateral inputs must be exactly the shared collateral UTxO ${txHash(200)}#0`));

    const foreignReturn = await buildAccountPaidOperation(service, shared, control, fund, { customise: (builder) => builder.setCollateralChangeAddress(strangerAddress) });
    expectViolation(await witness(foreignReturn), 'uses_shared_collateral', /collateral return must pay the sponsor address/);

    const plain = await buildAccountPaidOperation(service, shared, control, fund);
    const withDatum = withCollateralReturn(plain, outputWithDatumHash(shared.sponsorAddress, 4_000_000n, '00'.repeat(32)));
    expectViolation(await witness(withDatum), 'uses_shared_collateral', /collateral return carries a datum/);

    expectViolation(await witness(withTotalCollateral(plain, 6_000_000n)), 'uses_shared_collateral', /Total collateral 6000000 exceeds the 5000000 lovelace the shared collateral UTxO holds/);
    expectViolation(await witness(markInvalid(plain)), 'uses_shared_collateral', /flagged as failing phase two/);
    expect(witnessCount()).toBe(0);
  });

  it('bounded_validity: refuses a bound beyond now plus the collateral validity window, and none at all', async () => {
    await fundPool();
    const { control, fund } = placeAccount();
    const shared = await collateral();

    const late = await buildAccountPaidOperation(service, shared, control, fund, { validUntil: new Date('2024-01-01T00:10:01.000Z') });
    expectViolation(
      await witness(late),
      'bounded_validity',
      /The validity upper bound at slot 48384601 is later than slot 48384600 \(2024-01-01T00:10:00.000Z\), now plus 600 seconds/,
    );

    const unbounded = await buildAccountPaidOperation(service, shared, control, fund, { validUntil: null });
    expectViolation(await witness(unbounded), 'bounded_validity', /carries no validity upper bound/);

    const latest = await buildAccountPaidOperation(service, shared, control, fund, { validUntil: new Date('2024-01-01T00:10:00.000Z') });
    const response = await witness(latest);
    expect(response.status).toBe(200);
    expect(service.db.prepare('SELECT invalid_hereafter FROM witnesses').get()).toEqual({ invalid_hereafter: 48_384_600 });
  });

  it('account_transaction: refuses a script transaction that neither spends a control UTxO nor creates an account', async () => {
    await fundPool();
    const shared = await collateral();
    const stakeScriptAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: stakeScriptHash, type: Cometa.CredentialType.ScriptHash })
      .toAddress()
      .toString();
    const locked = scriptUtxo(txHash(400), stakeScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const builder = collateralClientBuilder(service, shared, { changeAddress: strangerAddress });
    builder.addInput({ utxo: locked, redeemer: deviceRedeemer });
    builder.sendLovelace({ address: strangerAddress, amount: 5_000_000n });
    builder.addSigner(DEVICE_KEY).addScript(stakeScript);

    expectViolation(await witness(await builder.build()), 'account_transaction', /No input is an account control or grant UTxO and nothing is minted/);
  });

  it('account_transaction: refuses an agent spend whose control UTxO is neither spent nor referenced', async () => {
    await fundPool();
    const { grant, fund } = placeGrantedAccount();
    const shared = await collateral();

    const transaction = await buildAgentSpend(service, shared, { grant, fund });

    expectViolation(
      await witness(transaction),
      'account_transaction',
      new RegExp(`Input ${txHash(302)}#0 is a grant UTxO of account ${stakeScriptHash}, whose control UTxO is neither spent nor referenced`),
    );
    expect(witnessCount()).toBe(0);
  });

  it('no_foreign_scripts: takes the stake script of the account whose control UTxO is referenced, and no other', async () => {
    await fundPool();
    const { control, grant, fund } = placeGrantedAccount();
    const shared = await collateral();

    const own = await buildAgentSpend(service, shared, { control, grant, fund }, {
      customise: (builder) => builder.withdrawRewards({ rewardAddress: accountRewardAddress, amount: 0n, redeemer: operateRedeemer }).addScript(stakeScript),
    });
    expect((await witness(own)).status).toBe(200);

    const other = await buildAgentSpend(service, shared, { control, grant, fund }, {
      customise: (builder) => builder.withdrawRewards({ rewardAddress: rewardAddressOf(otherStakeScriptHash), amount: 0n, redeemer: operateRedeemer }).addScript(stakeScript),
    });
    expectViolation(
      await witness(other),
      'no_foreign_scripts',
      new RegExp(`A withdrawal draws from script ${otherStakeScriptHash}, which is neither the account script, its stake script nor a logic its control UTxOs name`),
    );
    expect(witnessCount()).toBe(1);
  });

  it('known_logic: refuses an operation whose control UTxO names a logic the service does not know, spent or referenced', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300), undefined, stateUnderLogic(otherLogicHash));
    const grant = grantUtxo(txHash(302));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    for (const utxo of [control, grant, fund]) {
      service.provider.addUtxo(utxo);
    }
    const shared = await collateral();
    const unknown = new RegExp(
      `The control UTxO ${txHash(300)}#0 of account ${stakeScriptHash} names logic ${otherLogicHash}, which is not one of the logic scripts the service knows`,
    );

    const spent = await buildAccountPaidOperation(service, shared, control, fund, { logic: otherLogicHash });
    expectViolation(await witness(spent), 'known_logic', unknown);

    const referenced = await buildAgentSpend(service, shared, { control, grant, fund }, { logic: otherLogicHash });
    expectViolation(await witness(referenced), 'known_logic', unknown);
    expect(witnessCount()).toBe(0);
  });

  it('known_logic: refuses an operation whose control UTxO names no logic at all in the first field of its datum', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300), undefined, stateWithoutLogic);
    const fund = fundUtxo(txHash(301), 20_000_000n);
    service.provider.addUtxo(control);
    service.provider.addUtxo(fund);
    const shared = await collateral();

    const transaction = await buildAccountPaidOperation(service, shared, control, fund);

    expectViolation(
      await witness(transaction),
      'known_logic',
      new RegExp(`The control UTxO ${txHash(300)}#0 of account ${stakeScriptHash} names no logic script hash in the first field of its datum`),
    );
    expect(witnessCount()).toBe(0);
  });

  it('known_logic: refuses an upgrade to a logic the service does not know, naming the control output it arrives at', async () => {
    await fundPool();
    placeParkedScripts();
    const { control, fund } = placeAccount();
    const shared = await collateral();

    const transaction = await buildUpgrade(service, shared, control, fund, otherLogicHash, { referenced: true });

    expectViolation(
      await witness(transaction),
      'known_logic',
      new RegExp(`The control output of account ${stakeScriptHash} names logic ${otherLogicHash}, which is not one of the logic scripts the service knows`),
    );
    expect(witnessCount()).toBe(0);
  });

  it('sponsor_outflow_zero: refuses an output to the sponsor, at its address or at its payment key alone', async () => {
    await fundPool();
    const { control, fund } = placeAccount();
    const shared = await collateral();

    const paid = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.sendLovelace({ address: shared.sponsorAddress, amount: 2_000_000n }),
    });
    expectViolation(await witness(paid), 'sponsor_outflow_zero', /An output pays 2000000 lovelace to the sponsor, which contributes collateral only/);

    const asChange = await buildAccountPaidOperation(service, shared, control, fund, { changeAddress: shared.sponsorAddress });
    expectViolation(await witness(asChange), 'sponsor_outflow_zero', /An output pays \d+ lovelace to the sponsor/);

    const bare = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.sendLovelace({ address: enterpriseAddress(service.serviceWallet.paymentKeyHash), amount: 2_000_000n }),
    });
    expectViolation(await witness(bare), 'sponsor_outflow_zero', /An output pays 2000000 lovelace to the sponsor/);
    expect(witnessCount()).toBe(0);
  });

  it('no_foreign_scripts and evaluates: refuses a foreign script input and a budget declared below what evaluation finds', async () => {
    await fundPool();
    const { control, fund } = placeAccount();
    const shared = await collateral();

    const locked = scriptUtxo(txHash(400), Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: Cometa.computeScriptHash(foreignScript), type: Cometa.CredentialType.ScriptHash }).toAddress().toString(), 10_000_000n);
    service.provider.addUtxo(locked);
    const foreign = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: locked, redeemer: deviceRedeemer }).addScript(foreignScript).sendLovelace({ address: strangerAddress, amount: 10_000_000n }),
    });
    expectViolation(await witness(foreign), 'no_foreign_scripts', new RegExp(`Input ${txHash(400)}#0 is locked by script`));

    const underDeclared = await buildAccountPaidOperation(service, shared, control, fund, { evaluator: underDeclaringEvaluator });
    expectViolation(await witness(underDeclared), 'evaluates', /The spend redeemer at index \d+ declares 1 memory and 1 steps but needs 1500000 and 700000000/);
    expect(witnessCount()).toBe(0);
  });

  it('refuses a transaction a fee lease already witnessed, since it spends a sponsor input', async () => {
    await fundPool(1, 1);
    const lease = (await request(service.app).post('/v1/leases').set(bearer())).body as LeaseBody;
    const transaction = await buildCreation(service, lease);
    expect((await request(service.app).post(`/v1/leases/${lease.leaseId}/witness`).set(bearer()).send({ transaction })).status).toBe(200);

    expectViolation(await witness(transaction), 'no_sponsor_inputs', new RegExp(`Input ${txHash(100)}#0 belongs to the sponsor`));
    expect(witnessCount()).toBe(1);
  });
});

describe('an account upgrading its logic, with both versions known to the service', () => {
  beforeEach(async () => {
    service.close();
    service = await createTestService({ KNOWN_LOGIC_HASHES: `${logicHash},${otherLogicHash}` });
    apiKey = service.issueKey().apiKey;
  });

  it('witnesses an upgrade that withdraws from the logic it leaves and the logic it arrives at', async () => {
    await fundPool();
    placeParkedScripts();
    const { control, fund } = placeAccount();
    const shared = await collateral();
    const transaction = await buildUpgrade(service, shared, control, fund, otherLogicHash, { referenced: true });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.withdrawals.map((withdrawal) => withdrawal.credential?.hash).sort()).toEqual([logicHash, otherLogicHash].sort());
    expect(parsed?.outputs.find((output) => output.assets[stateNftAssetId] === 1n)?.logicHash).toBe(otherLogicHash);

    const response = await witness(transaction);

    expect(response.status).toBe(200);
    expectSponsorWitness(response.body.witnessSet, transaction, [control, fund, sponsorUtxo(shared)], DEVICE_KEY);
    expect(witnessAudit().at(-1)).toMatchObject({ outcome: 'issued', detail: { kind: 'operation', sponsoredLovelace: 0 } });
  });

  it('refuses an upgrade that withdraws from neither of the two logics it names', async () => {
    await fundPool();
    placeParkedScripts();
    const { control, fund } = placeAccount();
    const shared = await collateral();

    const transaction = await buildUpgrade(service, shared, control, fund, otherLogicHash, {
      referenced: true,
      customise: (builder) => builder.withdrawRewards({ rewardAddress: rewardAddressOf(otherStakeScriptHash), amount: 0n, redeemer: operateRedeemer }).addScript(stakeScript),
    });

    expectViolation(
      await witness(transaction),
      'no_foreign_scripts',
      new RegExp(`A withdrawal draws from script ${otherStakeScriptHash}, which is neither the account script, its stake script nor a logic its control UTxOs name`),
    );
    expect(witnessCount()).toBe(0);
  });
});
