import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { UTxO } from '@biglup/cometa';
import { Cometa } from '../src/cometa.js';
import type { CollateralBody, LeaseBody } from '../src/api.js';
import type { RuleName } from '../src/policy/rules.js';
import {
  CONTROL_LOVELACE,
  DEVICE_KEY,
  accountAddress,
  accountScript,
  accountScriptHash,
  controlUtxo,
  foreignScript,
  foreignScriptHash,
  fundUtxo,
  initialState,
  stakeScriptHash,
  stateNftAssetId,
  strangerAddress,
  unitRedeemer,
} from './support/account.js';
import { buildAccountPaidOperation, buildCreation, buildOwnerOperation, clientBuilder, sponsorUtxo, underDeclaringEvaluator } from './support/client.js';
import { type TestService, createTestService, txHash } from './support/service.js';
import { withTotalCollateral, withValidityUpperBound } from './support/transaction.js';

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
const lease = async (key: string = apiKey): Promise<LeaseBody> => {
  const response = await request(service.app).post('/v1/leases').set(bearer(key));
  expect(response.status).toBe(201);
  return response.body as LeaseBody;
};

/** Asks for the witness of a transaction on a lease. */
const witness = (leaseId: string, transaction: unknown, key: string = apiKey): request.Test =>
  request(service.app).post(`/v1/leases/${leaseId}/witness`).set(bearer(key)).send({ transaction });

/** Reads the shared collateral through the API. */
const collateral = async (): Promise<CollateralBody> => {
  const response = await request(service.app).get('/v1/collateral').set(bearer());
  expect(response.status).toBe(200);
  return response.body as CollateralBody;
};

/** Asks for the collateral witness of a transaction. */
const collateralWitness = (transaction: unknown): request.Test => request(service.app).post('/v1/collateral/witness').set(bearer()).send({ transaction });

/** The number of witnesses issued so far. */
const witnessCount = (): number => (service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count;

/** The last audit row written under `action`: the key it names, its outcome and its parsed detail. */
const lastAudit = (action: string): { apiKeyId: number | null; outcome: string; detail: Record<string, unknown> } => {
  const row = service.db.prepare('SELECT api_key_id, outcome, detail FROM audit WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as {
    api_key_id: number | null;
    outcome: string;
    detail: string;
  };
  return { apiKeyId: row.api_key_id, outcome: row.outcome, detail: JSON.parse(row.detail) as Record<string, unknown> };
};

/** The free and leased fee UTxO counts as the health endpoint reports them. */
const feeCounts = async (): Promise<{ free: number; leased: number }> => (await request(service.app).get('/health')).body.pool.fee;

/** Expects a refusal naming exactly `rule`, recorded on the audit trail under the key. */
const expectViolation = (response: request.Response, rule: RuleName, detail: RegExp): void => {
  expect(response.status).toBe(422);
  expect(response.body).toEqual({ error: 'invalid_transaction', rule, detail: expect.stringMatching(detail) });
  const audit = service.db.prepare("SELECT api_key_id, outcome FROM audit WHERE action = 'witness' ORDER BY id DESC LIMIT 1").get() as {
    api_key_id: number;
    outcome: string;
  };
  expect(audit.outcome).toBe(rule);
  expect(audit.api_key_id).toBe(1);
};

/** Takes `count` leases and builds a creation on each, one after another, since the builder's evaluator bridge serves one build at a time. */
const buildCreations = async (key: string, count: number): Promise<{ taken: LeaseBody; transaction: string }[]> => {
  const built = [];
  for (let i = 0; i < count; i += 1) {
    const taken = await lease(key);
    built.push({ taken, transaction: await buildCreation(service, taken) });
  }
  return built;
};

/** The inline datum of a control output carrying the initial state. */
const stateDatum = { type: Cometa.DatumType.InlineData, inlineDatum: initialState } as const;

/** A script credential. */
const scriptCredential = (hash: string): { hash: string; type: typeof Cometa.CredentialType.ScriptHash } => ({ hash, type: Cometa.CredentialType.ScriptHash });

/**
 * An account creation whose stake credential is the foreign script, as an
 * account the service has never seen the stake script of looks: the
 * registration is the only script run besides the mint, the token is
 * named after the credential and minted under `policy`.
 */
const buildForeignStakeCreation = async (taken: LeaseBody, policy: string): Promise<string> => {
  const assetId = `${policy}${foreignScriptHash}`;
  const address = Cometa.BaseAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(accountScriptHash), scriptCredential(foreignScriptHash))
    .toAddress()
    .toString();
  const builder = clientBuilder(service, taken);
  builder.registerStakeAddress({ rewardAddress: Cometa.RewardAddress.fromCredentials(Cometa.NetworkId.Testnet, scriptCredential(foreignScriptHash)), redeemer: unitRedeemer });
  builder.mintToken({ assetIdHex: assetId, amount: 1n, redeemer: unitRedeemer });
  builder.lockValue({ scriptAddress: address, value: { coins: CONTROL_LOVELACE, assets: { [assetId]: 1n } }, datum: stateDatum });
  builder.addSigner(DEVICE_KEY).addScript(accountScript).addScript(foreignScript);
  return builder.build();
};

describe('a client trying to drain the sponsor', () => {
  it('cannot pay the leased fee UTxO out to itself', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const taken = await lease();
    const transaction = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.sendLovelace({ address: strangerAddress, amount: 97_000_000n }),
    });

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /drawn down by 97\d+ lovelace but the fee accounts for \d+/);
    expect(witnessCount()).toBe(0);
  });

  it('cannot spend the shared collateral UTxO as a regular input, in either mode', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    service.provider.addUtxo(control);
    service.provider.addUtxo(fund);
    const taken = await lease();
    const onLease = await buildOwnerOperation(service, taken, control, {
      customise: (builder) => builder.addInput({ utxo: sponsorUtxo(taken.collateral) }).sendLovelace({ address: strangerAddress, amount: 5_000_000n }),
    });
    expectViolation(
      await witness(taken.leaseId, onLease),
      'uses_leased_fee_input',
      new RegExp(`Input ${taken.collateral.txHash}#${taken.collateral.index} belongs to the sponsor but is not the leased fee UTxO`),
    );

    const shared = await collateral();
    expect(shared.txHash).toBe(taken.collateral.txHash);
    const onCollateral = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: sponsorUtxo(shared) }).sendLovelace({ address: strangerAddress, amount: 5_000_000n }),
    });
    expectViolation(await collateralWitness(onCollateral), 'no_sponsor_inputs', new RegExp(`Input ${shared.txHash}#${shared.index} belongs to the sponsor, which contributes collateral only`));
    expect(witnessCount()).toBe(0);
    expect(service.db.prepare('SELECT status FROM pool_utxos WHERE tx_hash = ?').get(shared.txHash)).toEqual({ status: 'free' });
  });

  it('cannot draw sponsor value through the collateral route, which contributes collateral and nothing else', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    service.provider.addUtxo(control);
    service.provider.addUtxo(fund);
    const shared = await collateral();
    const fee: UTxO = { input: { txId: txHash(100), index: 0 }, output: { address: shared.sponsorAddress, value: { coins: 100_000_000n } } };

    const spendingFee = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.addInput({ utxo: fee }).sendLovelace({ address: strangerAddress, amount: 97_000_000n }),
    });
    expectViolation(await collateralWitness(spendingFee), 'no_sponsor_inputs', new RegExp(`Input ${txHash(100)}#0 belongs to the sponsor, which contributes collateral only`));

    const paidBack = await buildAccountPaidOperation(service, shared, control, fund, {
      customise: (builder) => builder.sendLovelace({ address: shared.sponsorAddress, amount: 3_000_000n }),
    });
    expectViolation(await collateralWitness(paidBack), 'sponsor_outflow_zero', /An output pays 3000000 lovelace to the sponsor, which contributes collateral only/);
    expect(witnessCount()).toBe(0);
  });

  it('cannot put the shared collateral at risk with a budget below what the scripts need, or with a transaction declared failing', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    service.provider.addUtxo(control);
    service.provider.addUtxo(fund);
    const shared = await collateral();

    const underDeclared = await buildAccountPaidOperation(service, shared, control, fund, { evaluator: underDeclaringEvaluator });
    expectViolation(await collateralWitness(underDeclared), 'evaluates', /declares 1 memory and 1 steps but needs/);

    const failing = withTotalCollateral(await buildAccountPaidOperation(service, shared, control, fund), 5_000_001n);
    expectViolation(await collateralWitness(failing), 'uses_shared_collateral', /Total collateral 5000001 exceeds the 5000000 lovelace/);
    expect(witnessCount()).toBe(0);
  });

  it('cannot mint under a policy that merely resembles the account policy', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const taken = await lease();
    const lookalike = `${foreignScriptHash}${stakeScriptHash}`;
    const builder = clientBuilder(service, taken);
    builder.addInput({ utxo: control, redeemer: unitRedeemer });
    builder.mintToken({ assetIdHex: lookalike, amount: 1n, redeemer: unitRedeemer });
    builder.lockValue({ scriptAddress: accountAddress, value: { coins: CONTROL_LOVELACE, assets: { [stateNftAssetId]: 1n, [lookalike]: 1n } }, datum: stateDatum });
    builder.addSigner(DEVICE_KEY).addScript(accountScript).addScript(foreignScript);

    expectViolation(await witness(taken.leaseId, await builder.build()), 'no_foreign_scripts', new RegExp(`mints under policy ${foreignScriptHash}`));
  });

  it('cannot set a fee above the cap', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { customise: (builder) => builder.setMinimumFee(2_000_001n) });

    expectViolation(await witness(taken.leaseId, transaction), 'sponsor_outflow_bounded', /The fee 2000001 exceeds the 2000000 lovelace limit/);
  });

  it('cannot make the sponsor a required signer', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken, { customise: (builder) => builder.addSigner(service.serviceWallet.paymentKeyHash) });

    expectViolation(await witness(taken.leaseId, transaction), 'signers', /sponsor payment key is among the required signers/);
  });

  it('is sponsored for an account whose stake script the service has never seen, when the state NFT is minted under the account policy', async () => {
    await fundPool(2, 1);
    const taken = await lease();

    const genuine = await witness(taken.leaseId, await buildForeignStakeCreation(taken, accountScriptHash));
    expect(genuine.status).toBe(200);
    const audit = service.db.prepare("SELECT detail FROM audit WHERE action = 'witness' AND outcome = 'issued'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ kind: 'creation' });

    const other = await lease();
    expectViolation(
      await witness(other.leaseId, await buildForeignStakeCreation(other, foreignScriptHash)),
      'account_transaction',
      /No input is an account control UTxO and nothing is minted under the account policy/,
    );
  });
});

describe('a client replaying or reusing a lease', () => {
  it('cannot have a second transaction witnessed on a consumed lease', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const taken = await lease();
    const first = await witness(taken.leaseId, await buildCreation(service, taken));
    expect(first.status).toBe(200);

    const second = await witness(taken.leaseId, await buildOwnerOperation(service, taken, control));

    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'lease_consumed', detail: `Lease ${taken.leaseId} already issued a witness` });
    expect(witnessCount()).toBe(1);
    expect(lastAudit('witness')).toMatchObject({ apiKeyId: 1, outcome: 'lease_consumed', detail: { leaseId: taken.leaseId } });
  });

  it('receives the same witness set on a replay, which counts once against the hourly quota', async () => {
    await fundPool(3, 1);
    const key = service.issueKey('replayer', { witnessesPerHour: 2 }).apiKey;
    const first = await lease(key);
    const transaction = await buildCreation(service, first);
    const issued = await witness(first.leaseId, transaction, key);
    expect(issued.status).toBe(200);

    const replayed = await witness(first.leaseId, transaction, key);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(issued.body);
    expect(witnessCount()).toBe(1);

    const second = await lease(key);
    expect((await witness(second.leaseId, await buildCreation(service, second), key)).status).toBe(200);
    const third = await lease(key);
    const refused = await witness(third.leaseId, await buildCreation(service, third), key);
    expect(refused.status).toBe(429);
    expect(refused.body.detail).toBe('witnesses_per_hour: at most 2 witnesses per hour per key');
  });

  it('cannot build on an expired lease', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);
    service.clock.now = new Date('2024-01-01T00:10:00.000Z');

    const response = await witness(taken.leaseId, transaction);

    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: 'lease_expired', detail: `Lease ${taken.leaseId} has expired` });
    expect(await feeCounts()).toEqual({ free: 1, leased: 0 });
    expect(lastAudit('witness')).toEqual({ apiKeyId: 1, outcome: 'lease_expired', detail: { leaseId: taken.leaseId, txHash: null, reason: `Lease ${taken.leaseId} has expired` } });
  });
});

describe('a client griefing the pool', () => {
  it('cannot hoard leases beyond its quota, and the leases it holds return to the pool when they expire', async () => {
    await fundPool(5, 1);
    const { apiKey: key, record } = service.issueKey('hoarder', { openLeases: 2 });
    await lease(key);
    await lease(key);

    const refused = await request(service.app).post('/v1/leases').set(bearer(key));

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'quota_exceeded', detail: 'open_leases: at most 2 open leases per key' });
    expect(await feeCounts()).toEqual({ free: 3, leased: 2 });
    expect(lastAudit('lease')).toEqual({
      apiKeyId: record.id,
      outcome: 'quota_exceeded',
      detail: { quota: 'open_leases', reason: 'open_leases: at most 2 open leases per key' },
    });

    service.clock.now = new Date('2024-01-01T00:10:00.000Z');
    expect((await request(service.app).post('/v1/leases').set(bearer(key))).status).toBe(201);
    expect(await feeCounts()).toEqual({ free: 4, leased: 1 });
  });

  it('cannot freeze the fee pool by obtaining witnesses it never submits', async () => {
    await fundPool();
    const taken = await lease();
    expect((await witness(taken.leaseId, await buildCreation(service, taken))).status).toBe(200);
    await service.sync.run();
    expect(await feeCounts()).toEqual({ free: 0, leased: 0 });

    service.clock.now = new Date('2024-01-01T00:12:01.000Z');
    await service.sync.run();

    expect(await feeCounts()).toEqual({ free: 1, leased: 0 });
  });

  it('cannot keep a collateral witness alive past the validity window', async () => {
    await fundPool();
    const control = controlUtxo(txHash(300));
    const fund = fundUtxo(txHash(301), 20_000_000n);
    service.provider.addUtxo(control);
    service.provider.addUtxo(fund);
    const shared = await collateral();
    const transaction = await buildAccountPaidOperation(service, shared, control, fund);

    for (const slot of [48_384_601n, 10_000_000_000_000n, 2n ** 64n - 1n]) {
      expectViolation(await collateralWitness(withValidityUpperBound(transaction, slot)), 'bounded_validity', /is later than slot 48384600 \(2024-01-01T00:10:00.000Z\), now plus 600 seconds/);
    }

    expect(witnessCount()).toBe(0);
    expect((await collateralWitness(transaction)).status).toBe(200);
    const stored = service.db.prepare('SELECT invalid_hereafter, lease_id FROM witnesses').get() as { invalid_hereafter: number; lease_id: null };
    expect(stored).toEqual({ invalid_hereafter: 48_384_540, lease_id: null });
  });

  it('cannot freeze a fee UTxO for good with a validity upper bound no time can express', async () => {
    await fundPool();
    const taken = await lease();
    const transaction = await buildCreation(service, taken);

    for (const slot of [10_000_000_000_000n, 2n ** 64n - 1n]) {
      expectViolation(await witness(taken.leaseId, withValidityUpperBound(transaction, slot)), 'bounded_validity', /is later than slot 48384720/);
    }

    expect(witnessCount()).toBe(0);
    expect(await feeCounts()).toEqual({ free: 0, leased: 1 });
    expect((await witness(taken.leaseId, transaction)).status).toBe(200);
    const stored = service.db.prepare('SELECT invalid_hereafter FROM witnesses').get() as { invalid_hereafter: number };
    expect(stored.invalid_hereafter).toBe(48_384_600);
  });

  it('cannot overshoot the hourly witness quota with requests in flight at the same time', async () => {
    await fundPool(4, 1);
    const key = service.issueKey('burst', { witnessesPerHour: 1 }).apiKey;
    const built = await buildCreations(key, 4);
    service.provider.setEvaluationDelay(50);

    const responses = await Promise.all(built.map(({ taken, transaction }) => witness(taken.leaseId, transaction, key)));

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 429, 429, 429]);
    for (const response of responses.filter((candidate) => candidate.status === 429)) {
      expect(response.body).toEqual({ error: 'quota_exceeded', detail: 'witnesses_per_hour: at most 1 witnesses per hour per key' });
    }
    expect(witnessCount()).toBe(1);
  });

  it('cannot overshoot the daily sponsored lovelace quota with requests in flight at the same time', async () => {
    await fundPool(3, 1);
    const probe = await lease();
    const sample = await buildCreation(service, probe);
    expect((await witness(probe.leaseId, sample)).status).toBe(200);
    const sponsored = (service.db.prepare('SELECT sponsored_lovelace FROM witnesses').get() as { sponsored_lovelace: number }).sponsored_lovelace;
    const key = service.issueKey('burst', { sponsoredLovelacePerDay: sponsored }).apiKey;
    const built = await buildCreations(key, 2);
    service.provider.setEvaluationDelay(50);

    const responses = await Promise.all(built.map(({ taken, transaction }) => witness(taken.leaseId, transaction, key)));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(responses.find((response) => response.status === 429)?.body.detail).toBe(
      `sponsored_lovelace_per_day: at most ${sponsored} sponsored lovelace per day per key`,
    );
    expect(witnessCount()).toBe(2);
  });
});

describe('a caller without a key or with a broken request', () => {
  it('is refused with a forged key and with a disabled key alike', async () => {
    await fundPool();
    const { apiKey: disabled, record } = service.issueKey('disabled');
    service.db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', record.id);

    const forged = await request(service.app).post('/v1/leases').set(bearer('forged-key'));
    const revoked = await request(service.app).post('/v1/leases').set(bearer(disabled));

    expect(forged.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(forged.body).toEqual(revoked.body);
    expect(await feeCounts()).toEqual({ free: 1, leased: 0 });
  });

  it('is refused for malformed JSON without echoing it', async () => {
    await fundPool();
    const taken = await lease();

    const response = await request(service.app)
      .post(`/v1/leases/${taken.leaseId}/witness`)
      .set(bearer())
      .set('Content-Type', 'application/json')
      .send('{"transaction": "0x');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('is refused for a body over the size limit before anything reads it', async () => {
    await fundPool();
    const taken = await lease();

    const response = await witness(taken.leaseId, '00'.repeat(40 * 1024));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'payload_too_large' });
    const audit = service.db.prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'witness'").get() as { count: number };
    expect(audit.count).toBe(0);
  });
});
