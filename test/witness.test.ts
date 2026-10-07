import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Wallet } from '@biglup/cometa';
import type { LeaseBody } from '../src/api.js';
import { InvalidTransactionError, LeaseConsumedError, LeaseExpiredError, QuotaExceededError } from '../src/http/errors.js';
import { toLeaseBody } from '../src/http/leases.js';
import type { ApiKey } from '../src/keys.js';
import { parseTransaction } from '../src/policy/parse.js';
import type { Lease, LeaseService } from '../src/pool/leases.js';
import type { WitnessStore } from '../src/pool/witnesses.js';
import { type WitnessService, createWitnessService } from '../src/witness.js';
import { controlUtxo } from './support/account.js';
import { buildCreation, buildOwnerOperation } from './support/client.js';
import { type TestService, createTestService, txHash } from './support/service.js';

let service: TestService;
let apiKey: ApiKey;
let lease: Lease;
let leaseBody: LeaseBody;

beforeEach(async () => {
  service = await createTestService();
  service.fund(txHash(100), 0, 100_000_000n);
  service.fund(txHash(200), 0, 5_000_000n);
  await service.sync.run();
  apiKey = service.issueKey().record;
  lease = await service.leases.create(apiKey);
  leaseBody = bodyOf(lease);
});

/** The lease body of a lease, as the API would answer it, naming the shared collateral. */
const bodyOf = (taken: Lease): LeaseBody => {
  const shared = service.collateral.current();
  if (shared === undefined) {
    throw new Error('The pool shares no collateral');
  }
  return toLeaseBody(taken, shared, { sponsorAddress: service.serviceWallet.address, maxSponsoredLovelace: service.config.maxSponsoredLovelace });
};

afterEach(() => {
  service.close();
});

/** A witness no sponsor key produced. */
const STRANGER_WITNESS = { vkey: '00'.repeat(32), signature: '00'.repeat(64) };

/** A wallet that signs as the sponsor does and adds a stranger's witness, as a wallet asked for more keys than the payer's returns. */
const overSigningWallet = (wallet: Wallet): Wallet =>
  new Proxy(wallet, {
    get: (target, property, receiver) =>
      property === 'signTransaction'
        ? async (txCbor: string, partialSign: boolean) => [...(await target.signTransaction(txCbor, partialSign)), STRANGER_WITNESS]
        : (Reflect.get(target, property, receiver) as unknown),
  });

/** A lease service that reports a lease open after it closed, as a request that read the lease before another closed it sees. */
const staleLeases = (leases: LeaseService): LeaseService => ({
  ...leases,
  find: (key, leaseId) => ({ ...leases.find(key, leaseId), status: 'open' }),
});

/** A witness store whose quota check ahead of the policy never fires, as a request that passed it before other requests consumed the quota sees. */
const unguardedWitnesses = (witnesses: WitnessStore): WitnessStore => ({ ...witnesses, quotaShortfall: () => undefined });

/** A witness service on the test service's components, with some of them replaced. */
const witnessWith = (overrides: { wallet?: Wallet; leases?: LeaseService; witnesses?: WitnessStore }): WitnessService =>
  createWitnessService({
    db: service.db,
    provider: service.provider,
    serviceWallet: { ...service.serviceWallet, wallet: overrides.wallet ?? service.serviceWallet.wallet },
    leases: overrides.leases ?? service.leases,
    witnesses: overrides.witnesses ?? service.witnesses,
    collateral: service.collateral,
    settings: service.config,
    now: () => service.clock.now,
  });

const witnessCount = (): number => (service.db.prepare('SELECT COUNT(*) AS count FROM witnesses').get() as { count: number }).count;

const lastOutcome = (): string =>
  (service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness' ORDER BY id DESC LIMIT 1").get() as { outcome: string }).outcome;

/** The key with its daily sponsored lovelace quota set to `lovelace`. */
const withDailyQuota = (lovelace: bigint): ApiKey => ({ ...apiKey, quotas: { ...apiKey.quotas, sponsoredLovelacePerDay: Number(lovelace) } });

describe('witness service', () => {
  it('refuses with the daily quota once what the key sponsored today plus this transaction would pass it, and signs just under it', async () => {
    service.fund(txHash(101), 0, 100_000_000n);
    await service.sync.run();
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    await service.witness.issue(apiKey, lease.id, await buildCreation(service, leaseBody));
    const today = BigInt((service.db.prepare('SELECT sponsored_lovelace FROM witnesses').get() as { sponsored_lovelace: number }).sponsored_lovelace);
    const next = await service.leases.create(apiKey);
    const nextBody = bodyOf(next);
    const transaction = await buildOwnerOperation(service, nextBody, control);
    const sponsored = parseTransaction(transaction).transaction?.fee ?? 0n;

    const failure = await service.witness.issue(withDailyQuota(today + sponsored - 1n), next.id, transaction).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(QuotaExceededError);
    expect((failure as QuotaExceededError).toResponseBody()).toEqual({
      error: 'quota_exceeded',
      detail: `sponsored_lovelace_per_day: at most ${today + sponsored - 1n} sponsored lovelace per day per key`,
    });
    expect(witnessCount()).toBe(1);
    expect(lastOutcome()).toBe('quota_exceeded');
    expect(service.leases.find(apiKey, next.id).status).toBe('open');

    const issued = await service.witness.issue(withDailyQuota(today + sponsored), next.id, transaction);

    expect(issued.leaseId).toBe(next.id);
    expect(witnessCount()).toBe(2);
  });

  it('holds both quotas in the step that consumes the lease when the check ahead of the policy let the request through', async () => {
    service.fund(txHash(101), 0, 100_000_000n);
    service.fund(txHash(102), 0, 100_000_000n);
    await service.sync.run();
    const witness = witnessWith({ witnesses: unguardedWitnesses(service.witnesses) });
    const hourly: ApiKey = { ...apiKey, quotas: { ...apiKey.quotas, witnessesPerHour: 1 } };
    await witness.issue(hourly, lease.id, await buildCreation(service, leaseBody));
    const second = await service.leases.create(apiKey);
    const secondBody = bodyOf(second);

    const overHourly = await witness.issue(hourly, second.id, await buildCreation(service, secondBody)).catch((err: unknown) => err);

    expect(overHourly).toBeInstanceOf(QuotaExceededError);
    expect((overHourly as QuotaExceededError).toResponseBody()).toEqual({
      error: 'quota_exceeded',
      detail: 'witnesses_per_hour: at most 1 witnesses per hour per key',
    });
    expect(witnessCount()).toBe(1);
    expect(lastOutcome()).toBe('quota_exceeded');
    expect(service.leases.find(apiKey, second.id).status).toBe('open');

    const today = BigInt((service.db.prepare('SELECT sponsored_lovelace FROM witnesses').get() as { sponsored_lovelace: number }).sponsored_lovelace);
    const overDaily = await witness.issue(withDailyQuota(today), second.id, await buildCreation(service, secondBody)).catch((err: unknown) => err);

    expect(overDaily).toBeInstanceOf(QuotaExceededError);
    expect((overDaily as QuotaExceededError).quota).toBe('sponsored_lovelace_per_day');
    expect(witnessCount()).toBe(1);
  });

  it('refuses a witness set holding anything but the sponsor payment key signature and returns nothing', async () => {
    const transaction = await buildCreation(service, leaseBody);
    const witness = witnessWith({ wallet: overSigningWallet(service.serviceWallet.wallet) });

    const failure = await witness.issue(apiKey, lease.id, transaction).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(InvalidTransactionError);
    expect((failure as InvalidTransactionError).toResponseBody()).toEqual({
      error: 'invalid_transaction',
      rule: 'signers',
      detail: 'Signing produced 2 witnesses where only the sponsor payment key may sign',
    });
    expect(witnessCount()).toBe(0);
    expect(lastOutcome()).toBe('signers');
    expect(service.leases.find(apiKey, lease.id).status).toBe('open');
  });

  it('answers the recorded witness set when the same transaction consumed the lease after it was found open', async () => {
    const transaction = await buildCreation(service, leaseBody);
    const first = await service.witness.issue(apiKey, lease.id, transaction);
    const stale = witnessWith({ leases: staleLeases(service.leases) });

    const again = await stale.issue(apiKey, lease.id, transaction);

    expect(again).toEqual(first);
    expect(witnessCount()).toBe(1);
    expect(lastOutcome()).toBe('reissued');
  });

  it('refuses with lease_consumed when another transaction consumed the lease after it was found open', async () => {
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    await service.witness.issue(apiKey, lease.id, await buildCreation(service, leaseBody));
    const stale = witnessWith({ leases: staleLeases(service.leases) });

    const failure = await stale.issue(apiKey, lease.id, await buildOwnerOperation(service, leaseBody, control)).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(LeaseConsumedError);
    expect(witnessCount()).toBe(1);
  });

  it('answers lease_expired saying the lease was released when it was released after it was found open', async () => {
    const transaction = await buildCreation(service, leaseBody);
    service.leases.release(apiKey, lease.id);
    const stale = witnessWith({ leases: staleLeases(service.leases) });

    const failure = await stale.issue(apiKey, lease.id, transaction).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(LeaseExpiredError);
    expect((failure as LeaseExpiredError).toResponseBody()).toEqual({ error: 'lease_expired', detail: `Lease ${lease.id} was released` });
    expect(witnessCount()).toBe(0);
  });
});
