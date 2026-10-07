import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESTORE_MARGIN_SLOTS, classifyUtxo } from '../../src/pool/sync.js';
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
  service.db
    .prepare('INSERT INTO witnesses (lease_id, tx_hash, sponsored_lovelace, witness_set, invalid_hereafter, issued_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(leaseId, txHash(9), 500_000, 'a10080', invalidHereafter, '2024-01-01T00:01:00.000Z');
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
  it('discovers fee and collateral UTxOs as free and keeps the rest as reserve', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    service.fund(txHash(2), 0, 9_000_000_000n);

    const report = await service.sync.run();

    expect(report.discovered).toBe(2);
    expect(poolRows()).toEqual([
      { ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' },
      { ref: `${txHash(1)}#1`, kind: 'collateral', status: 'free' },
    ]);
    expect(report.reserve.lovelace).toBe(9_000_000_000n);
    expect(report.reserve.utxos).toHaveLength(1);
    expect(service.sync.reserve().syncedAt).toBeDefined();
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

  it('writes one audit row per lease it closes, whatever closed it', async () => {
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

    expect(auditRows().map((row) => [row.outcome, row.detail.leaseId])).toEqual([
      ['created', first.id],
      ['created', second.id],
      ['released', first.id],
      ['expired', second.id],
    ]);
  });

  it('frees the fee UTxOs of every lease closed when their shared collateral UTxO vanishes', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    const collateral = service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const first = await service.leases.create(key);
    const second = await service.leases.create(key);
    expect(first.collateral.txHash).toBe(txHash(3));
    expect(second.collateral.txHash).toBe(txHash(3));

    service.provider.removeUtxo(collateral.input);
    service.fund(txHash(4), 0, 5_000_000n);
    const report = await service.sync.run();

    expect(report.gone).toBe(1);
    expect(leaseStatus(first.id)).toBe('expired');
    expect(leaseStatus(second.id)).toBe('expired');
    expect(poolRows()).toEqual([
      { ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' },
      { ref: `${txHash(2)}#0`, kind: 'fee', status: 'free' },
      { ref: `${txHash(3)}#0`, kind: 'collateral', status: 'gone' },
      { ref: `${txHash(4)}#0`, kind: 'collateral', status: 'free' },
    ]);
    const next = await service.leases.create(key);
    expect(next.fee.txHash).toBe(txHash(1));
    expect(next.collateral.txHash).toBe(txHash(4));
  });

  it('keeps the collateral UTxO of a vanished fee UTxO leased while another lease still holds it', async () => {
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
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'leased' });
  });

  it('closes each lease on a vanished collateral UTxO by its own witness, marks the UTxO gone whatever the witnesses, and restores it when it reappears', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    const collateral = service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().record;
    const witnessed = await service.leases.create(key);
    const unwitnessed = await service.leases.create(key);
    issueWitness(witnessed.id);

    service.provider.removeUtxo(collateral.input);
    const report = await service.sync.run();

    expect(report).toMatchObject({ consumed: 0, gone: 1 });
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'gone' });
    expect(leaseStatus(witnessed.id)).toBe('consumed');
    expect(leaseStatus(unwitnessed.id)).toBe('expired');
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' });
    expect(poolRows()).toContainEqual({ ref: `${txHash(2)}#0`, kind: 'fee', status: 'free' });

    service.provider.addUtxo(collateral);
    const restored = await service.sync.run();

    expect(restored.restored).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'free' });
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
