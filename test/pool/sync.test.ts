import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyUtxo } from '../../src/pool/sync.js';
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

/** Records a witness for the lease, as issuing one for a transaction built on it would. */
const issueWitness = (leaseId: string): void => {
  service.db
    .prepare('INSERT INTO witnesses (lease_id, tx_hash, sponsored_lovelace, witness_set, issued_at) VALUES (?, ?, ?, ?, ?)')
    .run(leaseId, txHash(9), 500_000, 'a10080', '2024-01-01T00:01:00.000Z');
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

  it('marks a vanished UTxO gone when no witness was issued for it, closing its open lease', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    await service.sync.run();
    const lease = await service.leases.create(service.issueKey().record);
    expect(lease.fee.txHash).toBe(txHash(1));

    service.provider.removeUtxo(fee.input);
    const report = await service.sync.run();

    expect(report.gone).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'gone' });
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#1`, kind: 'collateral', status: 'free' });
    expect(leaseStatus(lease.id)).toBe('expired');
  });

  it('marks a vanished UTxO consumed when a witness was issued for its lease', async () => {
    const fee = service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(1), 1, 5_000_000n);
    await service.sync.run();
    const lease = await service.leases.create(service.issueKey().record);
    issueWitness(lease.id);

    service.provider.removeUtxo(fee.input);
    const report = await service.sync.run();

    expect(report.consumed).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'consumed' });
    expect(leaseStatus(lease.id)).toBe('consumed');
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

  it('closes each lease on a vanished collateral UTxO by its own witness, not by its neighbours', async () => {
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

    expect(report.consumed).toBe(1);
    expect(poolRows()).toContainEqual({ ref: `${txHash(3)}#0`, kind: 'collateral', status: 'consumed' });
    expect(leaseStatus(witnessed.id)).toBe('consumed');
    expect(leaseStatus(unwitnessed.id)).toBe('expired');
    expect(poolRows()).toContainEqual({ ref: `${txHash(1)}#0`, kind: 'fee', status: 'free' });
    expect(poolRows()).toContainEqual({ ref: `${txHash(2)}#0`, kind: 'fee', status: 'free' });
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

  it('shares one run between callers waiting at the same time', async () => {
    service.fund(txHash(1), 0, 100_000_000n);

    const [first, second] = await Promise.all([service.sync.run(), service.sync.run()]);

    expect(first).toBe(second);
    expect(first.discovered).toBe(1);
  });
});
