import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RewardAddress, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { LeaseBody } from '../../src/api.js';
import { parseTransaction } from '../../src/policy/parse.js';
import type { RuleName } from '../../src/policy/rules.js';
import {
  AGENT_KEY,
  CONTROL_LOVELACE,
  DEVICE_KEY,
  PARKED_LOVELACE,
  STRANGER_KEY,
  accountAddress,
  accountAddressOf,
  accountRewardAddress,
  accountScript,
  accountScriptHash,
  byronAddress,
  controlUtxo,
  createAccountRedeemer,
  deviceRedeemer,
  enterpriseAddress,
  foreignScript,
  foreignScriptAddress,
  foreignScriptHash,
  fundUtxo,
  grantAssetId,
  grantUtxo,
  grantedState,
  initialState,
  logicHash,
  logicRewardAddress,
  operateRedeemer,
  otherLogicHash,
  otherLogicRewardAddress,
  otherLogicScript,
  parkedLogicUtxo,
  parkedOtherLogicUtxo,
  parkedProxyUtxo,
  parkingAddress,
  pointerAddress,
  reserveDatum,
  rewardAddressOf,
  runRedeemer,
  scriptCredential,
  scriptUtxo,
  stakeScript,
  stakeScriptHash,
  stateNftAssetId,
  stateNftAssetIdOf,
  stateWithDevices,
  stateWithoutDevices,
  stateWithoutLogic,
  strangerAddress,
  unappliedStakeScript,
  unappliedStakeScriptHash,
} from '../support/account.js';
import { buildAgentSpendOnLease, buildCreation, buildOwnerOperation, clientBuilder, runLogic, sponsorUtxo, lenientEvaluator, underDeclaringEvaluator } from '../support/client.js';
import { type TestService, createTestService, txHash } from '../support/service.js';
import {
  authCommitteeHotCertificate,
  markInvalid,
  outputWithDatumHash,
  outputWithReferenceScript,
  poolRegistrationCertificate,
  updateDRepCertificate,
  withCollateralReturn,
  withExtraCertificates,
  withExtraOutput,
  withInfoProposal,
  withReferenceInputs,
  withRepeatedWithdrawal,
  withScriptDataHash,
  withTotalCollateral,
  withValidityUpperBound,
  withoutScriptData,
  withoutScriptDataHash,
} from '../support/transaction.js';

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
const fundPool = async (fee = 1, collateral = 1): Promise<void> => {
  for (let i = 0; i < fee; i += 1) {
    service.fund(txHash(100 + i), 0, 100_000_000n);
  }
  for (let i = 0; i < collateral; i += 1) {
    service.fund(txHash(200 + i), 0, 5_000_000n);
  }
  await service.sync.run();
};

/** Takes a lease through the API. */
const lease = async (): Promise<LeaseBody> => {
  const response = await request(service.app).post('/v1/leases').set(bearer());
  expect(response.status).toBe(201);
  return response.body as LeaseBody;
};

/** Asks for the witness of a transaction on a lease. */
const witness = (leaseId: string, transaction: unknown, key: string = apiKey): request.Test =>
  request(service.app).post(`/v1/leases/${leaseId}/witness`).set(bearer(key)).send({ transaction });

/** The last audit row written about a witness request: its outcome and its parsed detail. */
const lastWitnessAudit = (): { outcome: string; detail: Record<string, unknown> } => {
  const row = service.db.prepare("SELECT outcome, detail FROM audit WHERE action = 'witness' ORDER BY id DESC LIMIT 1").get() as {
    outcome: string;
    detail: string;
  };
  return { outcome: row.outcome, detail: JSON.parse(row.detail) as Record<string, unknown> };
};

/** Puts the account's control UTxO on the fake chain. */
const placeControl = (): UTxO => {
  const control = controlUtxo(txHash(300));
  service.provider.addUtxo(control);
  return control;
};

/** Puts the UTxOs the proxy and the logics are parked at on the fake chain, as the setup of a network leaves them. */
const placeParkedScripts = (): void => {
  for (const parked of [parkedProxyUtxo, parkedLogicUtxo, parkedOtherLogicUtxo]) {
    service.provider.addUtxo(parked);
  }
};

/** The hash of the one verification key in a witness set. */
const keyHashOf = (vkey: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(vkey), 28));

/** The sponsor's reward address, which only its stake key may draw from. */
const sponsorRewardAddress = (): RewardAddress =>
  Cometa.RewardAddress.fromCredentials(Cometa.NetworkId.Testnet, { hash: service.serviceWallet.stakeKeyHash, type: Cometa.CredentialType.KeyHash });

/** An address paying to the account script but staked to the foreign script, which no account ever has. */
const disguisedAccountAddress = Cometa.BaseAddress.fromCredentials(
  Cometa.NetworkId.Testnet,
  { hash: accountScriptHash, type: Cometa.CredentialType.ScriptHash },
  { hash: foreignScriptHash, type: Cometa.CredentialType.ScriptHash },
)
  .toAddress()
  .toString();

/** Checks that a witness set carries exactly the sponsor's payment key signature over the transaction body and applies to the transaction. */
const expectSponsorWitness = (witnessSet: string, transaction: string, resolved: UTxO[]): void => {
  const decoded = Cometa.readVkeyWitnessSetFromWitnessSetCbor(witnessSet);
  expect(decoded).toHaveLength(1);
  const [only] = decoded;
  expect(keyHashOf(only?.vkey ?? '')).toBe(service.serviceWallet.paymentKeyHash);
  const bodyHash = parseTransaction(transaction).transaction?.hash ?? '';
  const publicKey = Cometa.Ed25519PublicKey.fromHex(only?.vkey ?? '');
  expect(publicKey.verify(Cometa.Ed25519Signature.fromHex(only?.signature ?? ''), Cometa.hexToUint8Array(bodyHash))).toBe(true);
  const signed = Cometa.applyVkeyWitnessSet(transaction, decoded);
  expect(Cometa.inspectTx(signed).witness_set.vkey_witnesses).toHaveLength(1);
  expect(Cometa.getUniqueSigners(transaction, resolved)).toEqual(expect.arrayContaining([service.serviceWallet.paymentKeyHash, DEVICE_KEY]));
};

describe('POST /v1/leases/:id/witness', () => {
  it('witnesses a valid account creation with the sponsor payment key only', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);

    const response = await witness(taken.leaseId, transaction);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ leaseId: taken.leaseId, witnessSet: expect.stringMatching(/^[0-9a-f]+$/) });
    expectSponsorWitness(response.body.witnessSet, transaction, [sponsorUtxo(taken.fee), sponsorUtxo(taken.collateral)]);

    const parsed = parseTransaction(transaction).transaction;
    const row = service.db.prepare('SELECT * FROM witnesses WHERE lease_id = ?').get(taken.leaseId) as Record<string, unknown>;
    expect(row).toMatchObject({ tx_hash: parsed?.hash, witness_set: response.body.witnessSet });
    expect(BigInt(row.sponsored_lovelace as number)).toBe((parsed?.fee ?? 0n) + 2_000_000n + 2_000_000n);
    const audit = service.db.prepare("SELECT outcome, detail FROM audit WHERE action = 'witness'").all() as { outcome: string; detail: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ leaseId: taken.leaseId, txHash: parsed?.hash, kind: 'creation' });
  });

  it('witnesses a creation that takes the proxy and the logic from the UTxOs they are parked at rather than embedding them', async () => {
    await fundPool();
    placeParkedScripts();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { referenced: true });

    const response = await witness(taken.leaseId, transaction);

    expect(response.status).toBe(200);
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.scripts.map((script) => script.hash)).toEqual([stakeScriptHash]);
    expect(parsed?.referenceInputs.map((input) => input.index).sort()).toEqual([parkedProxyUtxo.input.index, parkedLogicUtxo.input.index]);
    expect(parsed?.withdrawals.map((withdrawal) => withdrawal.credential?.hash)).toEqual([logicHash]);
    expect(lastWitnessAudit()).toMatchObject({ outcome: 'issued', detail: { kind: 'creation' } });
  });

  it('answers the same witness set again for the same transaction on a consumed lease', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    const first = await witness(taken.leaseId, transaction);

    const again = await witness(taken.leaseId, transaction);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const outcomes = (service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness' ORDER BY id").all() as { outcome: string }[]).map(
      (row) => row.outcome,
    );
    expect(outcomes).toEqual(['issued', 'reissued']);
  });

  it('answers both of two concurrent requests for the same transaction with the one witness set', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);

    const [first, second] = await Promise.all([witness(taken.leaseId, transaction), witness(taken.leaseId, transaction)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = service.db.prepare('SELECT COUNT(*) AS count FROM witnesses WHERE lease_id = ?').get(taken.leaseId) as { count: number };
    expect(rows.count).toBe(1);
    const outcomes = (service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness'").all() as { outcome: string }[]).map((row) => row.outcome);
    expect(outcomes.sort()).toEqual(['issued', 'reissued']);
  });

  it('answers 409 lease_consumed for a different transaction on a consumed lease', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    await witness(taken.leaseId, await buildCreation(service, taken));

    const response = await witness(taken.leaseId, await buildOwnerOperation(service, taken, control));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'lease_consumed', detail: `Lease ${taken.leaseId} already issued a witness` });
    expect(lastWitnessAudit()).toEqual({
      outcome: 'lease_consumed',
      detail: { leaseId: taken.leaseId, txHash: expect.stringMatching(/^[0-9a-f]{64}$/), reason: `Lease ${taken.leaseId} already issued a witness` },
    });
  });

  it('answers 404 unknown_lease for a lease another key holds, or that does not exist', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    const other = service.issueKey('other').apiKey;

    const foreign = await witness(taken.leaseId, transaction, other);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('unknown_lease');

    const missing = await witness('missing', transaction);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('unknown_lease');
    expect(lastWitnessAudit()).toEqual({ outcome: 'unknown_lease', detail: { leaseId: 'missing', txHash: null, reason: 'No lease missing exists' } });
  });

  it('answers 410 lease_expired once the lease has run out, and for a released lease', async () => {
    await fundPool(2, 1);
    const expired = await lease();
    const transaction = await buildCreation(service, expired);
    service.clock.now = new Date('2024-01-01T00:10:00.000Z');

    const response = await witness(expired.leaseId, transaction);
    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: 'lease_expired', detail: `Lease ${expired.leaseId} has expired` });
    expect(lastWitnessAudit()).toEqual({
      outcome: 'lease_expired',
      detail: { leaseId: expired.leaseId, txHash: null, reason: `Lease ${expired.leaseId} has expired` },
    });

    const released = await lease();
    await request(service.app).delete(`/v1/leases/${released.leaseId}`).set(bearer());
    const afterRelease = await witness(released.leaseId, await buildCreation(service, released));
    expect(afterRelease.status).toBe(410);
    expect(afterRelease.body).toEqual({ error: 'lease_expired', detail: `Lease ${released.leaseId} was released` });
    expect(lastWitnessAudit()).toEqual({
      outcome: 'lease_released',
      detail: { leaseId: released.leaseId, txHash: null, reason: `Lease ${released.leaseId} was released` },
    });
  });

  it('answers 400 invalid_request when the body carries no transaction', async () => {
    await fundPool();
    const taken = await lease();

    const response = await request(service.app).post(`/v1/leases/${taken.leaseId}/witness`).set(bearer()).send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });

  it('answers 429 quota_exceeded naming the quota once the key obtained its hourly witnesses, counting a reissue once', async () => {
    await fundPool(3, 1);
    const key = service.issueKey('hourly', { witnessesPerHour: 1 }).apiKey;
    const first = (await request(service.app).post('/v1/leases').set(bearer(key))).body as LeaseBody;
    const transaction = await buildCreation(service, first);
    expect((await witness(first.leaseId, transaction, key)).status).toBe(200);
    expect((await witness(first.leaseId, transaction, key)).status).toBe(200);
    const second = (await request(service.app).post('/v1/leases').set(bearer(key))).body as LeaseBody;

    const response = await witness(second.leaseId, await buildCreation(service, second), key);

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: 'quota_exceeded', detail: 'witnesses_per_hour: at most 1 witnesses per hour per key' });
    const rows = service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number };
    expect(rows.count).toBe(1);
    const status = service.db.prepare('SELECT status FROM leases WHERE id = ?').get(second.leaseId) as { status: string };
    expect(status.status).toBe('open');
    const audit = service.db.prepare("SELECT outcome, detail FROM audit WHERE action = 'witness' ORDER BY id DESC LIMIT 1").get() as { outcome: string; detail: string };
    expect(audit.outcome).toBe('quota_exceeded');
    expect(JSON.parse(audit.detail)).toMatchObject({ leaseId: second.leaseId, quota: 'witnesses_per_hour' });

    service.clock.now = new Date('2024-01-01T01:00:01.000Z');
    const later = (await request(service.app).post('/v1/leases').set(bearer(key))).body as LeaseBody;
    expect((await witness(later.leaseId, await buildCreation(service, later), key)).status).toBe(200);
  });

  it('never leases a witnessed fee UTxO again and does not count it as free', async () => {
    await fundPool(2, 1);
    const taken = await lease();
    expect(taken.fee.txHash).toBe(txHash(100));
    await witness(taken.leaseId, await buildCreation(service, taken));

    const health = await request(service.app).get('/health');
    expect(health.body.pool).toEqual({ fee: { free: 1, leased: 0 }, collateral: { shared: true, spare: 0, consumed: 0 } });
    const next = await lease();
    expect(next.fee.txHash).toBe(txHash(101));
    const third = await request(service.app).post('/v1/leases').set(bearer());
    expect(third.status).toBe(409);

    await service.sync.run();
    const status = service.db.prepare('SELECT status FROM pool_utxos WHERE tx_hash = ?').get(txHash(100)) as { status: string };
    expect(status.status).toBe('consumed');
    const leaseStatus = service.db.prepare('SELECT status FROM leases WHERE id = ?').get(taken.leaseId) as { status: string };
    expect(leaseStatus.status).toBe('consumed');
  });
});

describe('transaction policy', () => {
  /** Expects a refusal naming exactly `rule`. */
  const expectViolation = (response: request.Response, rule: RuleName, detail?: RegExp): void => {
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: 'invalid_transaction', rule, detail: detail ? expect.stringMatching(detail) : expect.any(String) });
    const audit = service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness' ORDER BY id DESC LIMIT 1").get() as { outcome: string };
    expect(audit.outcome).toBe(rule);
  };

  it('well_formed: refuses bytes that are not a transaction, and a transaction over 16 KiB', async () => {
    await fundPool();
    const taken = await lease();

    expectViolation(await witness(taken.leaseId, 'not hex'), 'well_formed', /not a hex encoded/);
    expectViolation(await witness(taken.leaseId, 'deadbeef'), 'well_formed', /does not decode as a Conway transaction/);
    expectViolation(await witness(taken.leaseId, '00'.repeat(16_385)), 'well_formed', /16385 bytes, over the 16384 byte limit/);
  });

  it('well_formed: refuses proposal procedures and a treasury donation, which no account transaction carries', async () => {
    await fundPool();
    const taken = await lease();
    const plain = await buildCreation(service, taken);

    expectViolation(await witness(taken.leaseId, withInfoProposal(plain, STRANGER_KEY)), 'well_formed', /carries proposal procedures; account transactions carry neither/);

    const donating = await buildCreation(service, taken, { customise: (builder) => builder.setDonation(1_000_000n) });
    expectViolation(await witness(taken.leaseId, donating), 'well_formed', /carries a treasury donation; account transactions carry neither/);
  });

  it('uses_leased_fee_input: refuses a second sponsor UTxO among the inputs', async () => {
    await fundPool(2, 1);
    const control = placeControl();
    const taken = await lease();
    const otherFee: UTxO = { input: { txId: txHash(101), index: 0 }, output: { address: taken.sponsorAddress, value: { coins: 100_000_000n } } };
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: sponsorUtxo(taken.fee) }).addInput({ utxo: otherFee }),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'uses_leased_fee_input', new RegExp(`Input ${txHash(101)}#0 belongs to the sponsor`));
  });

  it('uses_leased_fee_input: refuses a sponsor UTxO the pool does not know, at the sponsor address, at the payment key alone or at a pointer address', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const reserve = service.fund(txHash(500), 0, 30_000_000n);
    expect(service.db.prepare('SELECT 1 FROM pool_utxos WHERE tx_hash = ?').get(txHash(500))).toBeUndefined();
    const bare: UTxO = {
      input: { txId: txHash(501), index: 0 },
      output: { address: enterpriseAddress(service.serviceWallet.paymentKeyHash), value: { coins: 50_000_000n } },
    };
    service.provider.addUtxo(bare);
    const pointed: UTxO = {
      input: { txId: txHash(502), index: 0 },
      output: { address: pointerAddress(service.serviceWallet.paymentKeyHash), value: { coins: 50_000_000n } },
    };
    service.provider.addUtxo(pointed);

    const fromReserve = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: reserve }).sendLovelace({ address: strangerAddress, amount: 30_000_000n }),
    });
    expectViolation(await witness(taken.leaseId, fromReserve), 'uses_leased_fee_input', new RegExp(`Input ${txHash(500)}#0 belongs to the sponsor`));

    const fromBare = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: bare }).sendLovelace({ address: strangerAddress, amount: 50_000_000n }),
    });
    expectViolation(await witness(taken.leaseId, fromBare), 'uses_leased_fee_input', new RegExp(`Input ${txHash(501)}#0 belongs to the sponsor`));

    const fromPointed = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: pointed }).sendLovelace({ address: strangerAddress, amount: 50_000_000n }),
    });
    expectViolation(await witness(taken.leaseId, fromPointed), 'uses_leased_fee_input', new RegExp(`Input ${txHash(502)}#0 belongs to the sponsor`));
  });

  it('uses_leased_fee_input: refuses an input at an address whose payment credential cannot be read', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const byron: UTxO = { input: { txId: txHash(503), index: 0 }, output: { address: byronAddress, value: { coins: 50_000_000n } } };
    service.provider.addUtxo(byron);
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: byron }).sendLovelace({ address: strangerAddress, amount: 50_000_000n }),
    });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'uses_leased_fee_input',
      new RegExp(`Input ${txHash(503)}#0 is at an address whose payment credential the policy cannot read`),
    );
  });

  it('uses_leased_fee_input: refuses a transaction that does not spend the leased fee UTxO', async () => {
    await fundPool(2, 1);
    const control = placeControl();
    const taken = await lease();
    const otherFee: UTxO = { input: { txId: txHash(101), index: 0 }, output: { address: taken.sponsorAddress, value: { coins: 100_000_000n } } };
    const transaction = await buildOwnerOperation(service, taken, control, { customise: (builder) => builder.setUtxos([otherFee]) });

    expectViolation(await witness(taken.leaseId, transaction), 'uses_leased_fee_input', /is not among the inputs/);
  });

  it('uses_shared_collateral: refuses collateral other than the shared UTxO, a spare collateral UTxO included', async () => {
    await fundPool(1, 2);
    const control = placeControl();
    const taken = await lease();
    expect(taken.collateral.txHash).toBe(txHash(200));
    const spare: UTxO = { input: { txId: txHash(201), index: 0 }, output: { address: taken.sponsorAddress, value: { coins: 5_000_000n } } };
    const transaction = await buildOwnerOperation(service, taken, control, { customise: (builder) => builder.setCollateralUtxos([spare]) });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'uses_shared_collateral',
      new RegExp(`collateral inputs must be exactly the shared collateral UTxO ${txHash(200)}#0`),
    );
  });

  it('uses_shared_collateral: refuses a transaction without a collateral return to the sponsor', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.setCollateralChangeAddress(strangerAddress),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'uses_shared_collateral', /collateral return must pay the sponsor address/);
  });

  it('uses_shared_collateral: refuses total collateral above what the shared collateral UTxO holds', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = withTotalCollateral(await buildOwnerOperation(service, taken, control), 6_000_000n);

    expectViolation(await witness(taken.leaseId, transaction), 'uses_shared_collateral', /Total collateral 6000000 exceeds the 5000000 lovelace/);
  });

  it('uses_shared_collateral: refuses a collateral return carrying a datum or a reference script', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const plain = await buildOwnerOperation(service, taken, control);

    const withDatum = withCollateralReturn(plain, outputWithDatumHash(taken.sponsorAddress, 4_000_000n, '00'.repeat(32)));
    expectViolation(await witness(taken.leaseId, withDatum), 'uses_shared_collateral', /collateral return carries a datum/);

    const withScript = withCollateralReturn(plain, outputWithReferenceScript(taken.sponsorAddress, 4_000_000n, foreignScript));
    expectViolation(await witness(taken.leaseId, withScript), 'uses_shared_collateral', /collateral return carries a reference script/);
  });

  it('uses_shared_collateral: refuses a transaction flagged as failing phase two', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = markInvalid(await buildCreation(service, taken));
    expect(Cometa.inspectTx(transaction).is_valid).toBe(false);

    expectViolation(await witness(taken.leaseId, transaction), 'uses_shared_collateral', /flagged as failing phase two/);
  });

  it('bounded_validity: refuses a transaction without a validity upper bound, or one past the lease expiry plus the margin', async () => {
    await fundPool();
    const taken = await lease();

    const unbounded = await buildCreation(service, taken, { validUntil: null });
    expectViolation(await witness(taken.leaseId, unbounded), 'bounded_validity', /carries no validity upper bound/);

    const late = await buildCreation(service, taken, { validUntil: new Date('2024-01-01T00:12:01.000Z') });
    expectViolation(
      await witness(taken.leaseId, late),
      'bounded_validity',
      /The validity upper bound at slot 48384721 is later than slot 48384720 \(2024-01-01T00:12:00.000Z\), the lease expiry plus 120 seconds/,
    );
  });

  it('bounded_validity: refuses a bound past the range a time can express, and the largest a body can carry', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);

    const beyondTime = withValidityUpperBound(transaction, 10_000_000_000_000n);
    expectViolation(await witness(taken.leaseId, beyondTime), 'bounded_validity', /at slot 10000000000000 is later than slot 48384720/);

    const largest = withValidityUpperBound(transaction, 2n ** 64n - 1n);
    expectViolation(await witness(taken.leaseId, largest), 'bounded_validity', /at slot 18446744073709551615 is later than slot 48384720/);
    expect((service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count).toBe(0);
  });

  it('bounded_validity: refuses a bound at or before the current slot', async () => {
    await fundPool();
    const taken = await lease();

    const current = await buildCreation(service, taken, { validUntil: service.clock.now });
    expectViolation(
      await witness(taken.leaseId, current),
      'bounded_validity',
      /The validity upper bound at slot 48384000 \(2024-01-01T00:00:00.000Z\) is not later than the current slot 48384000/,
    );

    const past = await buildCreation(service, taken, { validUntil: new Date('2023-12-31T23:59:59.000Z') });
    expectViolation(await witness(taken.leaseId, past), 'bounded_validity', /at slot 48383999 \(2023-12-31T23:59:59.000Z\) is not later than the current slot 48384000/);

    const next = await buildCreation(service, taken, { validUntil: new Date('2024-01-01T00:00:01.000Z') });
    expect((await witness(taken.leaseId, next)).status).toBe(200);
  });

  it('bounded_validity: accepts a bound within the margin and records its slot with the witness', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { validUntil: new Date('2024-01-01T00:12:00.000Z') });

    const response = await witness(taken.leaseId, transaction);

    expect(response.status).toBe(200);
    const row = service.db.prepare('SELECT invalid_hereafter FROM witnesses WHERE lease_id = ?').get(taken.leaseId) as { invalid_hereafter: number };
    expect(row.invalid_hereafter).toBe(48_384_720);
  });

  it('frees a witnessed fee UTxO once its validity bound has passed by the restore margin and the chain still lists it', async () => {
    await fundPool();
    const taken = await lease();
    await witness(taken.leaseId, await buildCreation(service, taken));
    await service.sync.run();
    expect((await request(service.app).get('/health')).body.pool.fee).toEqual({ free: 0, leased: 0 });

    service.clock.now = new Date('2024-01-01T00:12:00.000Z');
    await service.sync.run();
    expect((await request(service.app).get('/health')).body.pool.fee).toEqual({ free: 0, leased: 0 });

    service.clock.now = new Date('2024-01-01T00:12:01.000Z');
    await service.sync.run();

    expect((await request(service.app).get('/health')).body.pool.fee).toEqual({ free: 1, leased: 0 });
    const next = await lease();
    expect(next.fee.txHash).toBe(taken.fee.txHash);
  });

  it('account_transaction: refuses a script transaction that neither spends a control UTxO nor creates an account', async () => {
    await fundPool();
    const stakeScriptAddress = Cometa.EnterpriseAddress.fromCredentials(Cometa.NetworkId.Testnet, {
      hash: stakeScriptHash,
      type: Cometa.CredentialType.ScriptHash,
    })
      .toAddress()
      .toString();
    const locked = scriptUtxo(txHash(400), stakeScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const taken = await lease();
    const builder = clientBuilder(service, taken);
    builder.addInput({ utxo: locked, redeemer: deviceRedeemer });
    builder.sendLovelace({ address: strangerAddress, amount: 10_000_000n });
    builder.addSigner(DEVICE_KEY).addScript(stakeScript);
    const transaction = await builder.build();

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /No input is an account control or grant UTxO and nothing is minted/);
  });

  it('account_transaction: refuses a mint under the account policy without a stake registration', async () => {
    await fundPool();
    const taken = await lease();
    const builder = clientBuilder(service, taken);
    builder.mintToken({ assetIdHex: stateNftAssetId, amount: 1n, redeemer: createAccountRedeemer });
    builder.lockValue({
      scriptAddress: accountAddress,
      value: { coins: 2_000_000n, assets: { [stateNftAssetId]: 1n } },
      datum: { type: Cometa.DatumType.InlineData, inlineDatum: initialState },
    });
    builder.addSigner(DEVICE_KEY).addScript(accountScript);
    const transaction = await builder.build();

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /registers exactly one script stake credential/);
  });

  it('account_transaction: refuses a creation whose minted token is named like a grant token rather than a state NFT', async () => {
    await fundPool();
    const taken = await lease();
    const builder = clientBuilder(service, taken);
    builder.registerStakeAddress({ rewardAddress: accountRewardAddress, redeemer: operateRedeemer });
    builder.mintToken({ assetIdHex: grantAssetId, amount: 1n, redeemer: createAccountRedeemer });
    builder.lockValue({ scriptAddress: accountAddress, value: { coins: CONTROL_LOVELACE, assets: { [grantAssetId]: 1n } }, datum: { type: Cometa.DatumType.InlineData, inlineDatum: initialState } });
    builder.addSigner(DEVICE_KEY).addScript(accountScript).addScript(stakeScript);

    expectViolation(await witness(taken.leaseId, await builder.build()), 'account_transaction', /mints a state NFT named with the 28 bytes of its stake script hash/);
  });

  it('account_transaction: refuses a creation whose control output is staked to a credential other than the registered one, or to a key of its hash', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { controlAddress: disguisedAccountAddress });

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /staked to the registered stake credential/);

    const keyStaked = Cometa.BaseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(accountScriptHash), { hash: stakeScriptHash, type: Cometa.CredentialType.KeyHash })
      .toAddress()
      .toString();
    expectViolation(await witness(taken.leaseId, await buildCreation(service, taken, { controlAddress: keyStaked })), 'account_transaction', /staked to the registered stake credential/);
  });

  it('account_transaction: witnesses a creation whose stake credential is the stake script of the first device its control output lists, or of the last', async () => {
    await fundPool(2, 1);
    const first = await lease();

    const ownerFirst = await witness(first.leaseId, await buildCreation(service, first, { state: stateWithDevices([DEVICE_KEY, AGENT_KEY]) }));
    expect(ownerFirst.status).toBe(200);
    expect(lastWitnessAudit()).toMatchObject({ outcome: 'issued', detail: { leaseId: first.leaseId, kind: 'creation' } });

    const last = await lease();
    const ownerLast = await witness(last.leaseId, await buildCreation(service, last, { state: stateWithDevices([AGENT_KEY, STRANGER_KEY, DEVICE_KEY]) }));
    expect(ownerLast.status).toBe(200);
    expect(lastWitnessAudit()).toMatchObject({ outcome: 'issued', detail: { leaseId: last.leaseId, kind: 'creation' } });
  });

  it('account_transaction: refuses a creation whose stake credential is the stake script of no device the control output lists, the unapplied validator included', async () => {
    await fundPool();
    const taken = await lease();
    const notListed = new RegExp(`The stake credential ${stakeScriptHash} is not this contract's stake script for any device the control output lists`);

    expectViolation(await witness(taken.leaseId, await buildCreation(service, taken, { state: stateWithDevices([AGENT_KEY]) })), 'account_transaction', notListed);

    const builder = clientBuilder(service, taken);
    builder.registerStakeAddress({ rewardAddress: rewardAddressOf(unappliedStakeScriptHash), redeemer: operateRedeemer });
    builder.mintToken({ assetIdHex: stateNftAssetIdOf(unappliedStakeScriptHash), amount: 1n, redeemer: createAccountRedeemer });
    builder.lockValue({
      scriptAddress: accountAddressOf(unappliedStakeScriptHash),
      value: { coins: CONTROL_LOVELACE, assets: { [stateNftAssetIdOf(unappliedStakeScriptHash)]: 1n } },
      datum: { type: Cometa.DatumType.InlineData, inlineDatum: initialState },
    });
    runLogic(builder);
    builder.addSigner(DEVICE_KEY).addScript(accountScript).addScript(unappliedStakeScript);
    expectViolation(
      await witness(taken.leaseId, await builder.build()),
      'account_transaction',
      new RegExp(`The stake credential ${unappliedStakeScriptHash} is not this contract's stake script for any device the control output lists`),
    );
    expect((service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count).toBe(0);
  });

  it('account_transaction: refuses a creation whose control output does not list device keys in the second field of its datum', async () => {
    await fundPool();
    const taken = await lease();

    expectViolation(
      await witness(taken.leaseId, await buildCreation(service, taken, { state: stateWithoutDevices })),
      'account_transaction',
      /The control output does not list device keys in the second field of its datum/,
    );
  });

  it('known_logic: refuses a creation whose control output names a logic the service does not know', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { logic: otherLogicHash });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'known_logic',
      new RegExp(`The control output of account ${stakeScriptHash} names logic ${otherLogicHash}, which is not one of the logic scripts the service knows`),
    );
  });

  it('known_logic: refuses a creation whose control output names no logic at all in the first field of its datum', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { state: stateWithoutLogic });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'known_logic',
      new RegExp(`The control output of account ${stakeScriptHash} names no logic script hash in the first field of its datum`),
    );
  });

  it('known_logic: serves a creation under a second logic once the operator names it', async () => {
    service.close();
    service = await createTestService({ KNOWN_LOGIC_HASHES: `${logicHash},${otherLogicHash}` });
    apiKey = service.issueKey().apiKey;
    await fundPool();
    const taken = await lease();

    const response = await witness(taken.leaseId, await buildCreation(service, taken, { logic: otherLogicHash }));

    expect(response.status).toBe(200);
    expect(lastWitnessAudit()).toMatchObject({ outcome: 'issued', detail: { kind: 'creation' } });
  });

  it('no_foreign_scripts: takes the withdrawal of the logic the control output names, and no other, however the other logic is attached', async () => {
    await fundPool(2, 1);
    placeParkedScripts();
    const unnamed = new RegExp(`A withdrawal draws from script ${otherLogicHash}, which is neither the account script, its stake script nor a logic its control UTxOs name`);
    const drawFromOtherLogic = { rewardAddress: otherLogicRewardAddress, amount: 0n, redeemer: runRedeemer };

    const taken = await lease();
    const embedded = await buildCreation(service, taken, {
      referenced: true,
      customise: (builder) => builder.addScript(otherLogicScript).withdrawRewards(drawFromOtherLogic),
    });
    expectViolation(await witness(taken.leaseId, embedded), 'no_foreign_scripts', unnamed);

    const other = await lease();
    const referenced = await buildCreation(service, other, {
      referenced: true,
      customise: (builder) => builder.addReferenceInput(parkedOtherLogicUtxo).withdrawRewards(drawFromOtherLogic),
    });
    expectViolation(await witness(other.leaseId, referenced), 'no_foreign_scripts', unnamed);
  });

  it('sponsor_outflow_bounded: refuses an owner operation and an agent spend, since a leased fee UTxO pays for account creation only', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300), undefined, grantedState);
    const grant = grantUtxo(txHash(302));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    for (const utxo of [control, grant, fund]) {
      service.provider.addUtxo(utxo);
    }
    const taken = await lease();
    const creationOnly = /The leased fee UTxO pays for an account creation only; an operation on an existing account pays its own fee and takes the collateral route/;

    expectViolation(await witness(taken.leaseId, await buildOwnerOperation(service, taken, control)), 'sponsor_outflow_bounded', creationOnly);
    expectViolation(await witness(taken.leaseId, await buildAgentSpendOnLease(service, taken, { control, grant, fund })), 'sponsor_outflow_bounded', creationOnly);
    expect((service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count).toBe(0);

    const creation = await witness(taken.leaseId, await buildCreation(service, taken));
    expect(creation.status).toBe(200);
    expect(lastWitnessAudit()).toMatchObject({ outcome: 'issued', detail: { leaseId: taken.leaseId, kind: 'creation' } });
  });

  it('sponsor_outflow_bounded: refuses a fee above the fee limit', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => builder.setMinimumFee(2_000_001n),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /The fee 2000001 exceeds the 2000000 lovelace limit/);
  });

  it('sponsor_outflow_bounded: refuses a creation whose control output takes the sponsored lovelace over the limit', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { controlLovelace: 5_000_000n });

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /Sponsoring \d+ lovelace exceeds the 6000000 lovelace limit/);
  });

  it('sponsor_outflow_bounded: refuses a creation that also pays a third party from the sponsor', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => builder.sendLovelace({ address: strangerAddress, amount: 1_000_000n }),
    });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'sponsor_outflow_bounded',
      /drawn down by \d+ lovelace but the fee, the registration deposit and the control output account for \d+/,
    );
  });

  it('sponsor_outflow_bounded: refuses change fragmented over two outputs to the sponsor, even when the sponsor is drawn down by what the creation costs alone', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => builder.sendLovelace({ address: taken.sponsorAddress, amount: 2_000_000n }),
    });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.outputs.filter((output) => output.address === taken.sponsorAddress)).toHaveLength(2);

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /pays the sponsor 2 outputs where exactly one change output is expected/);
  });

  it('sponsor_outflow_bounded: refuses an output to the sponsor carrying a datum or a reference script', async () => {
    await fundPool();
    const taken = await lease();

    const withDatum = await buildCreation(service, taken, {
      customise: (builder) =>
        builder.lockValue({
          scriptAddress: taken.sponsorAddress,
          value: { coins: 3_000_000n },
          datum: { type: Cometa.DatumType.InlineData, inlineDatum: reserveDatum },
        }),
    });
    expectViolation(await witness(taken.leaseId, withDatum), 'sponsor_outflow_bounded', /output to the sponsor carries a datum/);

    const withScript = withExtraOutput(await buildCreation(service, taken), outputWithReferenceScript(taken.sponsorAddress, 3_000_000n, foreignScript));
    expectViolation(await witness(taken.leaseId, withScript), 'sponsor_outflow_bounded', /output to the sponsor carries a reference script/);
  });

  it('no_sponsor_value_elsewhere: refuses value to a foreign address that the non sponsor inputs do not cover', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => {
        builder.withdrawRewards({ rewardAddress: sponsorRewardAddress(), amount: 3_000_000n });
        builder.sendLovelace({ address: strangerAddress, amount: 3_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_sponsor_value_elsewhere', /need 3000000 lovelace but the non sponsor inputs supply 0/);
  });

  it('no_foreign_scripts: refuses an input locked by a script other than the account scripts', async () => {
    await fundPool();
    const locked = scriptUtxo(txHash(400), foreignScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => {
        builder.addInput({ utxo: locked, redeemer: deviceRedeemer }).addScript(foreignScript);
        builder.sendLovelace({ address: strangerAddress, amount: 10_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_foreign_scripts', new RegExp(`Input ${txHash(400)}#0 is locked by script`));
  });

  it('no_foreign_scripts: never takes the stake part of an account output for an account stake script', async () => {
    await fundPool();
    const locked = scriptUtxo(txHash(400), foreignScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => {
        builder.addInput({ utxo: locked, redeemer: deviceRedeemer }).addScript(foreignScript);
        builder.sendLovelace({ address: disguisedAccountAddress, amount: 1_500_000n });
        builder.sendLovelace({ address: strangerAddress, amount: 8_500_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_foreign_scripts', new RegExp(`Input ${txHash(400)}#0 is locked by script`));
  });

  it('script_data_hash: refuses a body committing to script data the witness set does not carry, which an evaluator accepts all the same', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    const rewritten = withScriptDataHash(transaction, 'ab'.repeat(32));

    expect(await service.provider.evaluateTransaction(rewritten)).toHaveLength(parseTransaction(transaction).transaction?.redeemers.length ?? 0);

    expectViolation(await witness(taken.leaseId, rewritten), 'script_data_hash', /commits to the script data hash abab.* while the witness set carries script data hashing to /);
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get()).toEqual({ count: 0 });
  });

  it('script_data_hash: refuses a body committing to no script data hash while the witness set carries redeemers', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);

    expectViolation(
      await witness(taken.leaseId, withoutScriptDataHash(transaction)),
      'script_data_hash',
      /carries redeemers or datums while the body commits to no script data hash/,
    );
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get()).toEqual({ count: 0 });
  });

  it('script_data_hash: refuses a body committing to a script data hash while the witness set carries neither redeemers nor datums', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = withoutScriptData(await buildCreation(service, taken));
    expect(parseTransaction(transaction).transaction?.redeemers).toEqual([]);

    expectViolation(
      await witness(taken.leaseId, transaction),
      'script_data_hash',
      /The body commits to the script data hash [0-9a-f]{64} while the witness set carries neither redeemers nor datums/,
    );
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get()).toEqual({ count: 0 });
  });

  it('script_data_hash: refuses a reference input carrying a Plutus V2 reference script, naming the language as people write it', async () => {
    await fundPool();
    const taken = await lease();
    const parkedV2: UTxO = {
      input: { txId: txHash(600), index: 0 },
      output: {
        address: parkingAddress,
        value: { coins: PARKED_LOVELACE },
        scriptReference: { type: Cometa.ScriptType.Plutus, bytes: foreignScript.bytes, version: Cometa.PlutusLanguageVersion.V2 },
      },
    };
    service.provider.addUtxo(parkedV2);
    const transaction = withReferenceInputs(await buildCreation(service, taken), [parkedV2.input]);
    expect(parseTransaction(transaction).transaction?.referenceInputs).toEqual([parkedV2.input]);

    expectViolation(
      await witness(taken.leaseId, transaction),
      'script_data_hash',
      /The transaction carries a script of Plutus V2, and every script an account runs is Plutus V3/,
    );
  });

  it('no_foreign_scripts: refuses a withdrawal map drawing from the same reward account twice', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = withRepeatedWithdrawal(await buildCreation(service, taken));

    expectViolation(
      await witness(taken.leaseId, transaction),
      'no_foreign_scripts',
      new RegExp(`The transaction withdraws from ${logicRewardAddress.toAddress().toString()} twice, which the ledger cannot decode`),
    );
  });

  it('evaluates: refuses a transaction the provider cannot evaluate', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    service.provider.setEvaluationFailure('The mint handler refused the redeemer');

    expectViolation(await witness(taken.leaseId, transaction), 'evaluates', /does not evaluate: The mint handler refused the redeemer/);
  });

  it('evaluates: refuses a transaction whose inputs the provider will not resolve, without a lookup per input', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    service.provider.setResolutionFailure('Transaction not found');

    expectViolation(await witness(taken.leaseId, transaction), 'evaluates', /The inputs could not be resolved: Transaction not found/);
  });

  it('evaluates: refuses a script input spent without a redeemer', async () => {
    await fundPool();
    const fund = fundUtxo(txHash(301), 5_000_000n);
    service.provider.addUtxo(fund);
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      evaluator: lenientEvaluator,
      customise: (builder) => {
        builder.addInput({ utxo: fund });
        builder.sendLovelace({ address: accountAddress, amount: 5_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'evaluates', /is locked by a script but has no redeemer/);
  });

  it('evaluates: refuses a redeemer declaring a budget below what evaluation finds it needs', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { evaluator: underDeclaringEvaluator });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'evaluates',
      /The (certificate|mint) redeemer at index \d+ declares 1 memory and 1 steps but needs \d+ and \d+/,
    );
  });

  it('signers: refuses the sponsor payment key or stake key among the required signers', async () => {
    await fundPool();
    const taken = await lease();

    const payment = await buildCreation(service, taken, {
      customise: (builder) => builder.addSigner(service.serviceWallet.paymentKeyHash),
    });
    expectViolation(await witness(taken.leaseId, payment), 'signers', /sponsor payment key is among the required signers/);

    const stake = await buildCreation(service, taken, {
      customise: (builder) => builder.addSigner(service.serviceWallet.stakeKeyHash),
    });
    expectViolation(await witness(taken.leaseId, stake), 'signers', /sponsor stake key is among the required signers/);
  });

  it('signers: refuses a withdrawal from the sponsor reward account', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => {
        builder.withdrawRewards({ rewardAddress: sponsorRewardAddress(), amount: 3_000_000n });
        builder.sendLovelace({ address: accountAddress, amount: 3_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /withdraws from the sponsor's reward account/);
  });

  it('signers: refuses a deregistration of the sponsor stake credential', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) => {
        builder.deregisterStakeAddress({ rewardAddress: sponsorRewardAddress() });
        builder.sendLovelace({ address: accountAddress, amount: 2_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /The unregistration certificate names the sponsor's own credential/);
  });

  it('signers: refuses a vote by the sponsor stake credential', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, {
      customise: (builder) =>
        builder.vote({
          voter: { type: Cometa.VoterType.DRepKeyHash, credential: { hash: service.serviceWallet.stakeKeyHash, type: Cometa.CredentialType.KeyHash } },
          actionId: { id: txHash(900), actionIndex: 0 },
          votingProcedure: { vote: Cometa.Vote.Yes, anchor: null },
        }),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /The drep_credential voter is the sponsor's own credential/);
  });

  it('signers: refuses DRep, committee and pool certificates naming a sponsor key', async () => {
    await fundPool();
    const taken = await lease();
    const plain = await buildCreation(service, taken);
    const { paymentKeyHash, stakeKeyHash } = service.serviceWallet;

    const drep = withExtraCertificates(plain, [updateDRepCertificate(stakeKeyHash)]);
    expectViolation(await witness(taken.leaseId, drep), 'signers', /The update_drep certificate names the sponsor's own credential/);

    const committee = withExtraCertificates(plain, [authCommitteeHotCertificate(stakeKeyHash, STRANGER_KEY)]);
    expectViolation(await witness(taken.leaseId, committee), 'signers', /The auth_committee_hot certificate names the sponsor's own credential/);

    const pool = /The pool_registration certificate names the sponsor's own credential/;
    const owner = withExtraCertificates(plain, [poolRegistrationCertificate(STRANGER_KEY, STRANGER_KEY, [stakeKeyHash])]);
    expectViolation(await witness(taken.leaseId, owner), 'signers', pool);

    const operator = withExtraCertificates(plain, [poolRegistrationCertificate(paymentKeyHash, STRANGER_KEY, [STRANGER_KEY])]);
    expectViolation(await witness(taken.leaseId, operator), 'signers', pool);

    const rewards = withExtraCertificates(plain, [poolRegistrationCertificate(STRANGER_KEY, stakeKeyHash, [STRANGER_KEY])]);
    expectViolation(await witness(taken.leaseId, rewards), 'signers', pool);
  });

  it('leaves the lease open after a refusal so the client can try again', async () => {
    await fundPool();
    const taken = await lease();
    const refused = await buildCreation(service, taken, {
      customise: (builder) => builder.addSigner(service.serviceWallet.paymentKeyHash),
    });
    expectViolation(await witness(taken.leaseId, refused), 'signers');

    const response = await witness(taken.leaseId, await buildCreation(service, taken));

    expect(response.status).toBe(200);
  });
});
