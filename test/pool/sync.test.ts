import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESTORE_MARGIN_SLOTS, classifyUtxo, createPoolSync } from '../../src/pool/sync.js';
import { SLOT_SETTINGS_BY_NETWORK, slotAt } from '../../src/slots.js';
import { type TestService, createTestService, txHash } from '../support/service.js';

const SIZES = { feeUtxoLovelace: 100_000_000, collateralUtxoLovelace: 5_000_000 };

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
});

afterEach(() => {
  service.close();
});

const poolRows = (): { ref: string; kind: string; status: string }[] =>
  service.db
    .prepare("SELECT tx_hash || '#' || tx_index AS ref, kind, status FROM pool_utxos ORDER BY tx_hash, tx_index")
    .all() as { ref: string; kind: string; status: string }[];

const leaseStatus = (id: string): string =>
  (service.db.prepare('SELECT status FROM leases WHERE id = ?').get(id) as { status: string }).status;

/** The audit rows written about leases and the pool, oldest first, with their detail parsed. */
const auditRows = (): { apiKeyId: number | null; action: string; outcome: string; detail: Record<string, unknown> }[] =>
  (service.db.prepare("SELECT api_key_id, action, outcome, detail FROM audit WHERE action IN ('lease', 'pool') ORDER BY id").all() as {
    api_key_id: number | null;
    action: string;
    outcome: string;
    detail: string;
  }[]).map((row) => ({ apiKeyId: row.api_key_id, action: row.action, outcome: row.outcome, detail: JSON.parse(row.detail) as Record<string, unknown> }));

/** The slot of the lease expiry the test clock produces, as a client that builds a transaction to expire with its lease sets it. */
const LEASE_EXPIRY_SLOT = Number(slotAt(SLOT_SETTINGS_BY_NETWORK.preprod, new Date('2024-01-01T00:10:00.000Z')));

/** Records a witness for the lease, as issuing one for a transaction built on it would. */
const issueWitness = (leaseId: string, invalidHereafter = LEASE_EXPIRY_SLOT): void => {
  const { api_key_id: apiKeyId } = service.db.prepare('SELECT api_key_id FROM leases WHERE id = ?').get(leaseId) as { api_key_id: number };
  service.db
    .prepare('INSERT INTO witnesses (tx_hash, api_key_id, lease_id, sponsored_lovelace, witness_set, invalid_hereafter, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(txHash(9), apiKeyId, leaseId, 500_000, 'a10080', invalidHereafter, '2024-01-01T00:01:00.000Z');
};

/** The collateral UTxO the pool shares, as the designation table and the pool agree on it. */
const sharedCollateral = (): string | undefined => {
  const shared = service.collateral.current();
  return shared === undefined ? undefined : `${shared.txHash}#${shared.index}`;
};

describe('classifyUtxo', () => {
  it('classifies by closeness to the configured sizes', () => {
    expect(classifyUtxo(100_000_000n, SIZES)).toBe('fee');
    expect(classifyUtxo(95_000_000n, SIZES)).toBe('fee');
    expect(classifyUtxo(110_000_000n, SIZES)).toBe('fee');
    expect(classifyUtxo(5_000_000n, SIZES)).toBe('collateral');
    expect(classifyUtxo(4_600_000n, SIZES)).toBe('collateral');
    expect(classifyUtxo(5_400_000n, SIZES)).toBe('collateral');
  });

  it('leaves everything else to the reserve', () => {
    expect(classifyUtxo(9_900_000_000n, SIZES)).toBe('reserve');
    expect(classifyUtxo(50_000_000n, SIZES)).toBe('reserve');
    expect(classifyUtxo(2_000_000n, SIZES)).toBe('reserve');
    expect(classifyUtxo(111_000_000n, SIZES)).toBe('reserve');
  });
});

describe('pool sync', () => {
  it('discovers fee and collateral UTxOs as free, shares the collateral one and keeps the rest as reserve', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    service.fund(txHash(2), 0, 9_000_000_000n);
    expect(sharedCollateral()).toBeUndefined();

    const report = await service.sync.run();

    expect(report.discovered).toBe(2);
    expect(poolRows()).toEqual([
      { ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' },
      { ref: `${txHash(1)}#1`, kind: 'collateral', status: 'free' },
    ]);
    expect(sharedCollateral()).toBe(`${txHash(1)}#1`);
    expect(auditRows()).toEqual([]);
    expect(report.reserve.lovelace).toBe(9_000_000_000n);
    expect(report.reserve.utxos).toHaveLength(1);
    expect(service.sync.reserve().syncedAt).toBeDefined();
  });

  it('keeps the collateral UTxO it designated across runs and restarts, whatever older ones appear', async () => {
    service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    service.db.prepare("UPDATE pool_utxos SET discovered_at = '2023-12-31T00:00:00.000Z' WHERE tx_hash = ?").run(txHash(2));

    const restarted = createPoolSync({
      db: service.db,
      provider: service.provider,
      sponsorAddress: service.serviceWallet.address,
      sizes: service.config,
      slots: service.config.slots,
      now: () => service.clock.now,
    });
    await restarted.run();

    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);
    expect(service.db.prepare('SELECT chosen_at FROM shared_collateral').get()).toEqual({ chosen_at: '2024-01-01T00:00:00.000Z' });
  });

  it('never leases a UTxO carrying tokens, whatever its lovelace', async () => {
    service.provider.addUtxo({
      input: { txId: txHash(3), index: 0 },
      output: { address: service.serviceWallet.address, value: { coins: 100_000_000n, assets: { ['a'.repeat(56)]: 1n } } },
    });

    const report = await service.sync.run();

    expect(report.discovered).toBe(0);
    expect(report.reserve.utxos).toHaveLength(1);
  });

  it('is idempotent across runs', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    await service.sync.run();

    const report = await service.sync.run();

    expect(report.discovered).toBe(0);
    expect(poolRows()).toHaveLength(1);
  });

  it('marks a vanished UTxO gone when no witness was issued for it, closing its open lease on the audit trail', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    expect(lease.fee.txHash).toBe(txHash(1));

    service.provider.removeUtxo(fee.input);
    const report = await service.sync.run();

    expect(report.gone).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'gone' });
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#1`, kind: 'collateral', status: 'free' });
    expect(leaseStatus(lease.id)).toBe('expired');
    expect(auditRows().at(-1)).toEqual({
      apiKeyId: key.id,
      action: 'lease',
      outcome: 'expired',
      detail: { leaseId: lease.id, reason: 'utxo_vanished', utxo: `${txHash(1)}#0` },
    });
  });

  it('marks a vanished UTxO consumed when a witness was issued for its lease, closing the lease on the audit trail', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    issueWitness(lease.id);

    service.provider.removeUtxo(fee.input);
    const report = await service.sync.run();

    expect(report.consumed).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });
    expect(leaseStatus(lease.id)).toBe('consumed');
    expect(auditRows().at(-1)).toEqual({
      apiKeyId: key.id,
      action: 'lease',
      outcome: 'consumed',
      detail: { leaseId: lease.id, reason: 'utxo_vanished', utxo: `${txHash(1)}#0` },
    });
  });

  it('writes one audit row per lease it closes, and none for leases a vanished collateral UTxO leaves open', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    const collateral = service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const first = await service.leases.create(key);
    const second = await service.leases.create(key);
    service.leases.release(key, first.id);

    service.provider.removeUtxo(collateral.input);
    await service.sync.run();

    expect(leaseStatus(second.id)).toBe('open');
    expect(auditRows().map((row) => [row.action, row.outcome, row.detail.leaseId ?? row.detail.utxo])).toEqual([
      ['lease', 'created', first.id],
      ['lease', 'created', second.id],
      ['lease', 'released', first.id],
      ['pool', 'collateral_consumed', `${txHash(3)}#0`],
    ]);
  });

  it('marks the shared collateral UTxO consumed when it vanishes, records it, designates the next one and never restores the consumed one', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    const first = service.fund(txHash(3), 0, 5_000_000n);
    const second = service.fund(txHash(4), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);

    service.provider.removeUtxo(first.input);
    const report = await service.sync.run();

    expect(report).toMatchObject({ consumed: 1, gone: 0 });
    expect(poolRows()).toEqual([
      { ref: `${txHash(1)}#0`, kind: 'fee', status: 'leased' },
      { ref: `${txHash(2)}#0`, kind: 'fee', status: 'free' },
      { ref: `${txHash(3)}#0`, kind: 'collateral', status: 'consumed' },
      { ref: `${txHash(4)}#0`, kind: 'collateral', status: 'free' },
    ]);
    expect(sharedCollateral()).toBe(`${txHash(4)}#0`);
    expect(leaseStatus(lease.id)).toBe('open');
    expect(auditRows().at(-1)).toEqual({
      apiKeyId: null,
      action: 'pool',
      outcome: 'collateral_consumed',
      detail: { utxo: `${txHash(3)}#0`, next: `${txHash(4)}#0` },
    });

    service.provider.removeUtxo(second.input);
    await service.sync.run();
    expect(sharedCollateral()).toBeUndefined();
    expect(auditRows().at(-1)).toEqual({ apiKeyId: null, action: 'pool', outcome: 'collateral_consumed', detail: { utxo: `${txHash(4)}#0`, next: null } });
    expect(service.db.prepare('SELECT COUNT(*) AS count FROM shared_collateral').get()).toEqual({ count: 0 });
    await expect(service.leases.create(key)).rejects.toThrow(/The pool has no collateral UTxO/);

    service.provider.addUtxo(first);
    service.fund(txHash(5), 0, 5_000_000n);
    const after = await service.sync.run();
    expect(after.restored).toBe(0);
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'consumed' });
    expect(sharedCollateral()).toBe(`${txHash(5)}#0`);
    expect(auditRows().filter((row) => row.action === 'pool')).toHaveLength(2);
  });

  it('leaves the shared collateral in place when a fee UTxO vanishes', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const first = await service.leases.create(key);
    const second = await service.leases.create(key);
    expect(first.fee.txHash).toBe(txHash(1));

    service.provider.removeUtxo(fee.input);
    await service.sync.run();

    expect(leaseStatus(first.id)).toBe('expired');
    expect(leaseStatus(second.id)).toBe('open');
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'free' });
    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);
  });

  it('marks a spare collateral UTxO gone when it vanishes and restores it when it reappears, leaving the shared one in place', async () => {
    service.fund(txHash(3), 0, 5_000_000n);
    const spare = service.fund(txHash(4), 0, 5_000_000n);
    await service.sync.run();
    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);

    service.provider.removeUtxo(spare.input);
    const report = await service.sync.run();

    expect(report).toMatchObject({ consumed: 0, gone: 1 });
    expect(poolRows()).toContainEqual({ ref: `${txHash(4)}#0`, kind: 'collateral', status: 'gone' });
    expect(sharedCollateral()).toBe(`${txHash(3)}#0`);
    expect(auditRows()).toEqual([]);

    service.provider.addUtxo(spare);
    const restored = await service.sync.run();

    expect(restored.restored).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(4)}#0`, kind: 'collateral', status: 'free' });
  });

  it('restores a UTxO marked gone when the chain shows it again, but never one consumed', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    await service.sync.run();
    service.provider.removeUtxo(fee.input);
    await service.sync.run();
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'gone' });

    service.provider.addUtxo(fee);
    const report = await service.sync.run();
    expect(report.restored).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' });

    service.db.prepare("UPDATE pool_utxos SET status = 'consumed'").run();
    await service.sync.run();
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });
  });

  it('frees a consumed fee UTxO the chain still lists once every witness on it has passed its validity bound by the restore margin', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    issueWitness(lease.id);
    service.db.prepare("UPDATE leases SET status = 'consumed' WHERE id = ?").run(lease.id);
    service.db.prepare("UPDATE pool_utxos SET status = 'consumed' WHERE tx_hash = ?").run(txHash(1));

    expect(RESTORE_MARGIN_SLOTS).toBe(120n);
    service.clock.now = new Date('2024-01-01T00:12:00.000Z');
    const held = await service.sync.run();
    expect(held.restored).toBe(0);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });

    service.clock.now = new Date('2024-01-01T00:12:01.000Z');
    const freed = await service.sync.run();

    expect(freed.restored).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' });
    expect(leaseStatus(lease.id)).toBe('consumed');
    expect(auditRows().at(-1)).toEqual({
      apiKeyId: null,
      action: 'pool',
      outcome: 'restored',
      detail: { utxo: `${txHash(1)}#0`, slot: `${LEASE_EXPIRY_SLOT + Number(RESTORE_MARGIN_SLOTS) + 1}` },
    });
    const next = await service.leases.create(key);
    expect(next.fee.txHash).toBe(txHash(1));
  });

  it('keeps a consumed fee UTxO consumed while the latest witness on it can still land, and once it vanished', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const lease = await service.leases.create(key);
    issueWitness(lease.id, LEASE_EXPIRY_SLOT + 60);
    service.db.prepare("UPDATE leases SET status = 'consumed' WHERE id = ?").run(lease.id);
    service.db.prepare("UPDATE pool_utxos SET status = 'consumed' WHERE tx_hash = ?").run(txHash(1));

    service.clock.now = new Date('2024-01-01T00:10:30.000Z');
    await service.sync.run();
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });

    service.provider.removeUtxo(fee.input);
    service.clock.now = new Date('2024-01-01T00:12:00.000Z');
    const report = await service.sync.run();

    expect(report.restored).toBe(0);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });
  });

  it('shares one run between callers waiting at the same time', async () => {
    service.fund(txHash(1), 0, 100_000_000n);

    const [first, second] = await Promise.all([service.sync.run(), service.sync.run()]);

    expect(first).toBe(second);
    expect(first.discovered).toBe(1);
  });
});
