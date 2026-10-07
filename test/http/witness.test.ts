import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RewardAddress, UTxO } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { LeaseBody } from '../../src/api.js';
import { parseTransaction } from '../../src/policy/parse.js';
import type { RuleName } from '../../src/policy/rules.js';
import {
  DEVICE_KEY,
  STRANGER_KEY,
  accountAddress,
  accountScript,
  accountScriptHash,
  byronAddress,
  controlUtxo,
  enterpriseAddress,
  foreignScript,
  foreignScriptAddress,
  foreignScriptHash,
  fundUtxo,
  pointerAddress,
  scriptUtxo,
  stakeScript,
  stakeScriptHash,
  stateNftAssetId,
  strangerAddress,
  unitRedeemer,
} from '../support/account.js';
import { buildCreation, buildOwnerOperation, clientBuilder, sponsorUtxo, lenientEvaluator, underDeclaringEvaluator } from '../support/client.js';
import { type TestService, createTestService, txHash } from '../support/service.js';
import {
  authCommitteeHotCertificate,
  markInvalid,
  outputWithDatumHash,
  outputWithReferenceScript,
  poolRegistrationCertificate,
  updateDRepCertificate,
  withCertificates,
  withCollateralReturn,
  withExtraOutput,
  withInfoProposal,
  withTotalCollateral,
  withValidityUpperBound,
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

  it('witnesses a valid owner operation', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control);

    const response = await witness(taken.leaseId, transaction);

    expect(response.status).toBe(200);
    expectSponsorWitness(response.body.witnessSet, transaction, [sponsorUtxo(taken.fee), sponsorUtxo(taken.collateral), control]);
    const row = service.db.prepare('SELECT sponsored_lovelace FROM witnesses WHERE lease_id = ?').get(taken.leaseId) as { sponsored_lovelace: number };
    expect(BigInt(row.sponsored_lovelace)).toBe(parseTransaction(transaction).transaction?.fee);
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
    builder.addInput({ utxo: locked, redeemer: unitRedeemer });
    builder.sendLovelace({ address: strangerAddress, amount: 10_000_000n });
    builder.addSigner(DEVICE_KEY).addScript(stakeScript);
    const transaction = await builder.build();

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /No input is an account control UTxO and nothing is minted/);
  });

  it('account_transaction: refuses a mint under the account policy without a stake registration', async () => {
    await fundPool();
    const taken = await lease();
    const builder = clientBuilder(service, taken);
    builder.mintToken({ assetIdHex: stateNftAssetId, amount: 1n, redeemer: unitRedeemer });
    builder.lockValue({
      scriptAddress: accountAddress,
      value: { coins: 2_000_000n, assets: { [stateNftAssetId]: 1n } },
      datum: { type: Cometa.DatumType.InlineData, inlineDatum: unitRedeemer },
    });
    builder.addSigner(DEVICE_KEY).addScript(accountScript);
    const transaction = await builder.build();

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /registers exactly one script stake credential/);
  });

  it('account_transaction: refuses a creation whose control output is staked to a credential other than the registered one', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { controlAddress: disguisedAccountAddress });

    expectViolation(await witness(taken.leaseId, transaction), 'account_transaction', /staked to the registered stake credential/);
  });

  it('sponsor_outflow_bounded: refuses a payout to a third party drawn from the sponsor input', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.sendLovelace({ address: strangerAddress, amount: 1_000_000n }),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /drawn down by \d+ lovelace but the fee accounts for \d+/);
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

  it('sponsor_outflow_bounded: refuses change fragmented over two outputs to the sponsor, even when the sponsor is drawn down by the fee alone', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.sendLovelace({ address: taken.sponsorAddress, amount: 2_000_000n }),
    });
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.outputs.filter((output) => output.address === taken.sponsorAddress)).toHaveLength(2);

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /pays the sponsor 2 outputs where exactly one change output is expected/);
  });

  it('sponsor_outflow_bounded: refuses an output to the sponsor carrying a datum or a reference script', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();

    const withDatum = await buildOwnerOperation(service, taken, control, {
      customise: (builder) =>
        builder.lockValue({
          scriptAddress: taken.sponsorAddress,
          value: { coins: 3_000_000n },
          datum: { type: Cometa.DatumType.InlineData, inlineDatum: unitRedeemer },
        }),
    });
    expectViolation(await witness(taken.leaseId, withDatum), 'sponsor_outflow_bounded', /output to the sponsor carries a datum/);

    const withScript = withExtraOutput(
      await buildOwnerOperation(service, taken, control),
      outputWithReferenceScript(taken.sponsorAddress, 3_000_000n, foreignScript),
    );
    expectViolation(await witness(taken.leaseId, withScript), 'sponsor_outflow_bounded', /output to the sponsor carries a reference script/);
  });

  it('no_sponsor_value_elsewhere: refuses value to a foreign address that the non sponsor inputs do not cover', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => {
        builder.withdrawRewards({ rewardAddress: sponsorRewardAddress(), amount: 3_000_000n });
        builder.sendLovelace({ address: strangerAddress, amount: 3_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_sponsor_value_elsewhere', /need 3000000 lovelace but the non sponsor inputs supply 2000000/);
  });

  it('no_foreign_scripts: refuses an input locked by a script other than the account scripts', async () => {
    await fundPool();
    const control = placeControl();
    const locked = scriptUtxo(txHash(400), foreignScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => {
        builder.addInput({ utxo: locked, redeemer: unitRedeemer }).addScript(foreignScript);
        builder.sendLovelace({ address: strangerAddress, amount: 10_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_foreign_scripts', new RegExp(`Input ${txHash(400)}#0 is locked by script`));
  });

  it('no_foreign_scripts: never takes the stake part of an account output for an account stake script', async () => {
    await fundPool();
    const control = placeControl();
    const locked = scriptUtxo(txHash(400), foreignScriptAddress, 10_000_000n);
    service.provider.addUtxo(locked);
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => {
        builder.addInput({ utxo: locked, redeemer: unitRedeemer }).addScript(foreignScript);
        builder.sendLovelace({ address: disguisedAccountAddress, amount: 1_500_000n });
        builder.sendLovelace({ address: strangerAddress, amount: 8_500_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'no_foreign_scripts', new RegExp(`Input ${txHash(400)}#0 is locked by script`));
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
    const control = placeControl();
    const fund = fundUtxo(txHash(301), 5_000_000n);
    service.provider.addUtxo(fund);
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
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
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, { evaluator: underDeclaringEvaluator });

    expectViolation(
      await witness(taken.leaseId, transaction),
      'evaluates',
      /The spend redeemer at index \d+ declares 1 memory and 1 steps but needs 1500000 and 700000000/,
    );
  });

  it('signers: refuses the sponsor payment key or stake key among the required signers', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();

    const payment = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addSigner(service.serviceWallet.paymentKeyHash),
    });
    expectViolation(await witness(taken.leaseId, payment), 'signers', /sponsor payment key is among the required signers/);

    const stake = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addSigner(service.serviceWallet.stakeKeyHash),
    });
    expectViolation(await witness(taken.leaseId, stake), 'signers', /sponsor stake key is among the required signers/);
  });

  it('signers: refuses a withdrawal from the sponsor reward account', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => {
        builder.withdrawRewards({ rewardAddress: sponsorRewardAddress(), amount: 3_000_000n });
        builder.sendLovelace({ address: accountAddress, amount: 3_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /withdraws from the sponsor's reward account/);
  });

  it('signers: refuses a deregistration of the sponsor stake credential', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => {
        builder.deregisterStakeAddress({ rewardAddress: sponsorRewardAddress() });
        builder.sendLovelace({ address: accountAddress, amount: 2_000_000n });
      },
    });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /The unregistration certificate names the sponsor's own credential/);
  });

  it('signers: refuses a vote by the sponsor stake credential', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
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
    const control = placeControl();
    const taken = await lease();
    const plain = await buildOwnerOperation(service, taken, control);
    const { paymentKeyHash, stakeKeyHash } = service.serviceWallet;

    const drep = withCertificates(plain, [updateDRepCertificate(stakeKeyHash)]);
    expectViolation(await witness(taken.leaseId, drep), 'signers', /The update_drep certificate names the sponsor's own credential/);

    const committee = withCertificates(plain, [authCommitteeHotCertificate(stakeKeyHash, STRANGER_KEY)]);
    expectViolation(await witness(taken.leaseId, committee), 'signers', /The auth_committee_hot certificate names the sponsor's own credential/);

    const pool = /The pool_registration certificate names the sponsor's own credential/;
    const owner = withCertificates(plain, [poolRegistrationCertificate(STRANGER_KEY, STRANGER_KEY, [stakeKeyHash])]);
    expectViolation(await witness(taken.leaseId, owner), 'signers', pool);

    const operator = withCertificates(plain, [poolRegistrationCertificate(paymentKeyHash, STRANGER_KEY, [STRANGER_KEY])]);
    expectViolation(await witness(taken.leaseId, operator), 'signers', pool);

    const rewards = withCertificates(plain, [poolRegistrationCertificate(STRANGER_KEY, stakeKeyHash, [STRANGER_KEY])]);
    expectViolation(await witness(taken.leaseId, rewards), 'signers', pool);
  });

  it('leaves the lease open after a refusal so the client can try again', async () => {
    await fundPool();
    const control = placeControl();
    const taken = await lease();
    const refused = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addSigner(service.serviceWallet.paymentKeyHash),
    });
    expectViolation(await witness(taken.leaseId, refused), 'signers');

    const response = await witness(taken.leaseId, await buildOwnerOperation(service, taken, control));

    expect(response.status).toBe(200);
  });
});
