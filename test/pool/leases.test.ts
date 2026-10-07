import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LeaseConsumedError,
  LeaseExpiredError,
  NoUtxoAvailableError,
  OutOfFundsError,
  QuotaExceededError,
  UnknownLeaseError,
} from '../../src/http/errors.js';
import { REPLENISH_FEE_MARGIN } from '../../src/pool/sizes.js';
import { type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
});

afterEach(() => {
  service.close();
});

/** Funds `fee` fee UTxOs and `collateral` collateral UTxOs and syncs the pool. */
const fundPool = async (fee: number, collateral: number): Promise<void> => {
  for (let i = 0; i < fee; i += 1) {
    service.fund(txHash(100 + i), 0, 100_000_000n);
  }
  for (let i = 0; i < collateral; i += 1) {
    service.fund(txHash(200 + i), 0, 5_000_000n);
  }
  await service.sync.run();
};

const utxoStatus = (hash: string): string =>
  (service.db.prepare('SELECT status FROM pool_utxos WHERE tx_hash = ?').get(hash) as { status: string }).status;

const leaseStatus = (id: string): string =>
  (service.db.prepare('SELECT status FROM leases WHERE id = ?').get(id) as { status: string }).status;

describe('lease creation', () => {
  it('leases the oldest free fee UTxO until the TTL and leaves the shared collateral UTxO free', async () => {
    service.fund(txHash(2), 0, 100_000_000n);
    await service.sync.run();
    service.db.prepare("UPDATE pool_utxos SET discovered_at = '2023-12-31T00:00:00.000Z'").run();
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;

    const lease = await service.leases.create(key);

    expect(lease.fee.txHash).toBe(txHash(2));
    expect(lease.fee.lovelace).toBe(100_000_000);
    expect(lease).not.toHaveProperty('collateral');
    expect(lease.status).toBe('open');
    expect(lease.expiresAt).toBe('2024-01-01T00:10:00.000Z');
    expect(utxoStatus(txHash(2))).toBe('leased');
    expect(utxoStatus(txHash(1))).toBe('free');
    expect(service.collateral.current()?.txHash).toBe(txHash(3));
    expect(utxoStatus(txHash(3))).toBe('free');
  });

  it('never leases the shared collateral UTxO as the fee UTxO, even when no other fee UTxO is free', async () => {
    service.fund(txHash(200), 0, 5_000_000n);
    await service.sync.run();
    expect(service.collateral.current()?.txHash).toBe(txHash(200));
    const key = service.issueKey().record;

    const starved = await service.leases.create(key).catch((err: unknown) => err);
    expect(starved).toBeInstanceOf(OutOfFundsError);
    expect((starved as OutOfFundsError).detail).toMatch(/^The pool has no fee UTxO and the reserve holds 0 lovelace/);

    service.fund(txHash(300), 0, 1_000_000_000n);
    const splittable = await service.leases.create(key).catch((err: unknown) => err);
    expect(splittable).toBeInstanceOf(NoUtxoAvailableError);
    expect((splittable as NoUtxoAvailableError).detail).toMatch(/^The pool has no fee UTxO yet/);
    expect(utxoStatus(txHash(200))).toBe('free');
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM leases').get()).toEqual({ count: 0 });
  });

  it('refuses a lease while the pool holds no collateral UTxO to share, resyncing with the chain first', async () => {
    service.fund(txHash(100), 0, 100_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;

    const starved = await service.leases.create(key).catch((err: unknown) => err);
    expect(starved).toBeInstanceOf(OutOfFundsError);
    expect((starved as OutOfFundsError).toResponseBody()).toEqual({
      error: 'out_of_funds',
      detail: `The pool has no collateral UTxO and the reserve holds 0 lovelace; a split needs at least ${5_000_000n + REPLENISH_FEE_MARGIN}`,
    });
    expect(utxoStatus(txHash(100))).toBe('free');

    service.fund(txHash(300), 0, 1_000_000_000n);
    const splittable = await service.leases.create(key).catch((err: unknown) => err);
    expect(splittable).toBeInstanceOf(NoUtxoAvailableError);
    expect((splittable as NoUtxoAvailableError).detail).toBe('The pool has no collateral UTxO yet; the reserve holds 1000000000 lovelace and can be split by replenishing');

    service.fund(txHash(200), 0, 5_000_000n);
    const lease = await service.leases.create(key);
    expect(lease.fee.txHash).toBe(txHash(100));
  });

  it('retries once when the insert loses a race on the fee UTxO', async () => {
    await fundPool(2, 1);
    const key = service.issueKey().record;
    service.db
      .prepare(
        `INSERT INTO leases (id, api_key_id, fee_utxo, expires_at, status, created_at)
         VALUES ('other-process', ?, ?, '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
      )
      .run(key.id, `${txHash(100)}#0`);

    const lease = await service.leases.create(key);

    expect(lease.fee.txHash).toBe(txHash(101));
    expect(utxoStatus(txHash(100))).toBe('leased');
  });

  it('refuses a key past its open lease quota with the quota name', async () => {
    await fundPool(3, 1);
    const key = service.issueKey('small', { openLeases: 2 }).record;
    await service.leases.create(key);
    await service.leases.create(key);

    const failure = await service.leases.create(key).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(QuotaExceededError);
    expect((failure as QuotaExceededError).toResponseBody()).toEqual({
      error: 'quota_exceeded',
      detail: 'open_leases: at most 2 open leases per key',
    });
    const audit = service.db.prepare("SELECT api_key_id, outcome, detail FROM audit WHERE action = 'lease' ORDER BY id DESC LIMIT 1").get() as {
      api_key_id: number;
      outcome: string;
      detail: string;
    };
    expect(audit).toEqual({ api_key_id: key.id, outcome: 'quota_exceeded', detail: expect.any(String) });
    expect(JSON.parse(audit.detail)).toEqual({ quota: 'open_leases', reason: 'open_leases: at most 2 open leases per key' });
  });

  it('answers no_utxo_available with the leased count and the soonest expiry when every fee UTxO is leased', async () => {
    await fundPool(2, 1);
    const key = service.issueKey('wide', { openLeases: 10 }).record;
    await service.leases.create(key);
    service.clock.now = new Date('2024-01-01T00:02:00.000Z');
    await service.leases.create(key);

    const failure = await service.leases.create(key).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(NoUtxoAvailableError);
    expect((failure as NoUtxoAvailableError).toResponseBody()).toEqual({
      error: 'no_utxo_available',
      detail: 'All 2 fee UTxOs are leased; the soonest lease expires at 2024-01-01T00:10:00.000Z',
    });
  });

  it('resyncs with the chain before giving up when no fee UTxO is free', async () => {
    service.fund(txHash(200), 0, 5_000_000n);
    await service.sync.run();
    service.fund(txHash(100), 0, 100_000_000n);

    const lease = await service.leases.create(service.issueKey().record);

    expect(lease.fee.txHash).toBe(txHash(100));
  });

  it('answers out_of_funds when the pool has no fee UTxO and the reserve cannot fund a split', async () => {
    service.fund(txHash(200), 0, 5_000_000n);
    service.fund(txHash(300), 0, 50_000_000n);
    await service.sync.run();

    const failure = await service.leases.create(service.issueKey().record).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OutOfFundsError);
    expect((failure as OutOfFundsError).toResponseBody()).toEqual({
      error: 'out_of_funds',
      detail: `The pool has no fee UTxO and the reserve holds 50000000 lovelace; a split needs at least ${100_000_000n + REPLENISH_FEE_MARGIN}`,
    });
  });

  it('answers no_utxo_available when the pool has no fee UTxO but the reserve could be split', async () => {
    service.fund(txHash(200), 0, 5_000_000n);
    service.fund(txHash(300), 0, 1_000_000_000n);
    await service.sync.run();

    const failure = await service.leases.create(service.issueKey().record).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(NoUtxoAvailableError);
    expect((failure as NoUtxoAvailableError).detail).toContain('1000000000 lovelace');
  });
});

describe('lease expiry and release', () => {
  it('expires leases lazily once the clock passes their expiry, freeing their UTxOs', async () => {
    await fundPool(1, 1);
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    expect(utxoStatus(txHash(100))).toBe('leased');

    service.clock.now = new Date('2024-01-01T00:09:59.999Z');
    expect(service.leases.expireStale()).toBe(0);

    service.clock.now = new Date('2024-01-01T00:10:00.000Z');
    expect(service.leases.expireStale()).toBe(1);
    expect(leaseStatus(lease.id)).toBe('expired');
    expect(utxoStatus(txHash(100))).toBe('free');
    expect(utxoStatus(txHash(200))).toBe('free');

    const next = await service.leases.create(key);
    expect(next.fee.txHash).toBe(txHash(100));
  });

  it('releases an open lease so its UTxOs can be leased again at once', async () => {
    await fundPool(1, 1);
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);

    const released = service.leases.release(key, lease.id);

    expect(released.status).toBe('released');
    expect(leaseStatus(lease.id)).toBe('released');
    expect(utxoStatus(txHash(100))).toBe('free');
    expect(service.leases.release(key, lease.id).status).toBe('released');
    const next = await service.leases.create(key);
    expect(next.fee.txHash).toBe(txHash(100));
  });

  it('leaves the shared collateral UTxO free whatever is leased, released or consumed', async () => {
    await fundPool(2, 1);
    const key = service.issueKey().record;
    const first = await service.leases.create(key);
    const second = await service.leases.create(key);
    expect(utxoStatus(txHash(200))).toBe('free');

    service.leases.release(key, first.id);
    service.leases.consume(key, second, { txHash: txHash(9), sponsoredLovelace: 0, witnessSet: 'a10080', invalidHereafter: 1 });

    expect(utxoStatus(txHash(200))).toBe('free');
    expect(utxoStatus(txHash(101))).toBe('consumed');
    expect(service.collateral.current()?.txHash).toBe(txHash(200));
  });

  it('refuses to release a lease another key holds as unknown', async () => {
    await fundPool(1, 1);
    const owner = service.issueKey('owner').record;
    const other = service.issueKey('other').record;
    const lease = await service.leases.create(owner);

    expect(() => service.leases.release(other, lease.id)).toThrow(UnknownLeaseError);
    expect(() => service.leases.release(owner, 'missing')).toThrow(UnknownLeaseError);
    expect(leaseStatus(lease.id)).toBe('open');
  });

  it('reports an expired or consumed lease on release', async () => {
    await fundPool(2, 1);
    const key = service.issueKey().record;
    const expired = await service.leases.create(key);
    const consumed = await service.leases.create(key);
    service.db.prepare("UPDATE leases SET status = 'consumed' WHERE id = ?").run(consumed.id);
    service.clock.now = new Date('2024-01-01T00:10:00.000Z');

    expect(() => service.leases.release(key, expired.id)).toThrow(LeaseExpiredError);
    expect(() => service.leases.release(key, consumed.id)).toThrow(LeaseConsumedError);
  });
});
