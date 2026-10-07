import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LeaseConsumedError,
  LeaseExpiredError,
  NoUtxoAvailableError,
  OutOfFundsError,
  QuotaExceededError,
  UnknownLeaseError,
} from '../../src/http/errors.js';
import { REPLENISH_FEE_MARGIN } from '../../src/pool/replenish.js';
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
  it('leases the oldest free fee UTxO and a collateral UTxO until the TTL', async () => {
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
    expect(lease.collateral.txHash).toBe(txHash(3));
    expect(lease.status).toBe('open');
    expect(lease.expiresAt).toBe('2024-01-01T00:10:00.000Z');
    expect(utxoStatus(txHash(2))).toBe('leased');
    expect(utxoStatus(txHash(3))).toBe('leased');
    expect(utxoStatus(txHash(1))).toBe('free');
  });

  it('spreads leases over collateral UTxOs by their open lease count and stops at the sharing limit', async () => {
    const limited = await createTestService({ COLLATERAL_SHARING: '2' });
    try {
      for (let i = 0; i < 5; i += 1) {
        limited.fund(txHash(100 + i), 0, 100_000_000n);
      }
      limited.fund(txHash(200), 0, 5_000_000n);
      limited.fund(txHash(201), 0, 5_000_000n);
      await limited.sync.run();
      const key = limited.issueKey('wide', { openLeases: 10 }).record;

      const leases = [];
      for (let i = 0; i < 4; i += 1) {
        leases.push(await limited.leases.create(key));
      }
      const byCollateral = new Map<string, number>();
      for (const lease of leases) {
        byCollateral.set(lease.collateral.txHash, (byCollateral.get(lease.collateral.txHash) ?? 0) + 1);
      }
      expect(byCollateral.get(txHash(200))).toBe(2);
      expect(byCollateral.get(txHash(201))).toBe(2);

      await expect(limited.leases.create(key)).rejects.toThrow(NoUtxoAvailableError);
    } finally {
      limited.close();
    }
  });

  it('retries once when the insert loses a race on the fee UTxO', async () => {
    await fundPool(2, 1);
    const key = service.issueKey().record;
    service.db
      .prepare(
        `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
         VALUES ('other-process', ?, ?, ?, '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
      )
      .run(key.id, `${txHash(100)}#0`, `${txHash(200)}#0`);

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

  it('keeps a shared collateral UTxO leased while another lease still holds it', async () => {
    await fundPool(2, 1);
    const key = service.issueKey().record;
    const first = await service.leases.create(key);
    await service.leases.create(key);

    service.leases.release(key, first.id);

    expect(utxoStatus(txHash(200))).toBe('leased');
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
