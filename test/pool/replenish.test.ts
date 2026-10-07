import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutOfFundsError } from '../../src/http/errors.js';
import { buildSplitTransaction, planSplit } from '../../src/pool/replenish.js';
import { REPLENISH_FEE_MARGIN } from '../../src/pool/sizes.js';
import type { PoolSync } from '../../src/pool/sync.js';
import { type TestService, createTestService, txHash } from '../support/service.js';
import { transactionParts } from '../support/transaction.js';

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
});

afterEach(() => {
  service.close();
});

const SETTINGS = { feeUtxoLovelace: 100_000_000, collateralUtxoLovelace: 5_000_000, feeUtxoCount: 10, collateralUtxoCount: 2 };

describe('planSplit', () => {
  it('tops the pool up to its targets when no counts are given', () => {
    service.db
      .prepare("INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES (?, 0, 100000000, 'fee', 'leased', ?)")
      .run(txHash(1), '2024-01-01T00:00:00.000Z');

    const plan = planSplit(service.db, SETTINGS, 10_000_000_000n);

    expect(plan).toEqual({
      feeUtxoLovelace: 100_000_000n,
      feeWanted: 9,
      feeOutputs: 9,
      collateralLovelace: 5_000_000n,
      collateralWanted: 2,
      collateralOutputs: 2,
    });
  });

  it('caps the counts by the reserve less the fee margin, fee outputs first', () => {
    const plan = planSplit(service.db, SETTINGS, 250_000_000n, { feeUtxoCount: 5, collateralCount: 20 });

    expect(plan.feeOutputs).toBe(2);
    expect(plan.collateralOutputs).toBe(9);
    expect(250_000_000n - 2n * 100_000_000n - 9n * 5_000_000n).toBeGreaterThanOrEqual(REPLENISH_FEE_MARGIN);
  });

  it('honours custom sizes and explicit counts', () => {
    const plan = planSplit(service.db, SETTINGS, 1_000_000_000n, { feeUtxoLovelace: 50_000_000, feeUtxoCount: 3, collateralCount: 0 });

    expect(plan.feeUtxoLovelace).toBe(50_000_000n);
    expect(plan.feeOutputs).toBe(3);
    expect(plan.collateralOutputs).toBe(0);
  });

  it('plans nothing when the reserve cannot fund a single output', () => {
    const plan = planSplit(service.db, SETTINGS, 7_000_000n, { feeUtxoCount: 1, collateralCount: 1 });

    expect(plan.feeOutputs).toBe(0);
    expect(plan.collateralOutputs).toBe(0);
  });
});

describe('buildSplitTransaction', () => {
  it('spends the reserve only and pays every planned output and the change to the sponsor address', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    const reserve = service.fund(txHash(2), 0, 1_000_000_000n);
    await service.sync.run();
    const plan = planSplit(service.db, SETTINGS, 1_000_000_000n, { feeUtxoCount: 3, collateralCount: 2 });

    const tx = await buildSplitTransaction(service.db, service.serviceWallet, service.sync, plan);

    const parts = transactionParts(tx);
    expect(parts.inputs).toEqual([reserve.input]);
    expect(parts.outputs).toHaveLength(6);
    for (const output of parts.outputs) {
      expect(output.address).toBe(service.serviceWallet.address);
      expect(output.value.assets ?? {}).toEqual({});
    }
    const lovelace = parts.outputs.map((output) => output.value.coins);
    expect(lovelace.filter((coins) => coins === 100_000_000n)).toHaveLength(3);
    expect(lovelace.filter((coins) => coins === 5_000_000n)).toHaveLength(2);
    const change = lovelace.filter((coins) => coins !== 100_000_000n && coins !== 5_000_000n);
    expect(change).toHaveLength(1);
    expect(change[0]).toBe(1_000_000_000n - 3n * 100_000_000n - 2n * 5_000_000n - parts.fee);
    expect(parts.fee).toBeGreaterThan(0n);
    expect(parts.fee).toBeLessThan(REPLENISH_FEE_MARGIN);
  });

  it('leaves the shared collateral UTxO out of the inputs, even when the reserve it is handed lists it', async () => {
    const collateral = service.fund(txHash(1), 0, 5_000_000n);
    const reserve = service.fund(txHash(2), 0, 1_000_000_000n);
    await service.sync.run();
    expect(service.collateral.current()?.txHash).toBe(txHash(1));
    const plan = planSplit(service.db, SETTINGS, 1_000_000_000n, { feeUtxoCount: 2, collateralCount: 0 });
    expect(service.sync.reserve().utxos).toEqual([reserve]);
    const widened: PoolSync = { ...service.sync, reserve: () => ({ ...service.sync.reserve(), utxos: [collateral, reserve] }) };

    const tx = await buildSplitTransaction(service.db, service.serviceWallet, widened, plan);

    expect(transactionParts(tx).inputs).toEqual([reserve.input]);
  });
});

describe('replenish', () => {
  it('signs, submits, waits for confirmation and resyncs so the new UTxOs become leasable and one collateral is shared', async () => {
    service.fund(txHash(2), 0, 2_000_000_000n);

    const result = await service.replenish();

    expect(result.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.feeOutputs).toBe(10);
    expect(result.collateralOutputs).toBe(2);
    expect(service.provider.submitted).toHaveLength(1);
    const parts = transactionParts(service.provider.submitted[0] as string);
    expect(parts.outputs).toHaveLength(13);
    expect(result.reserveLovelace).toBe(2_000_000_000n - 10n * 100_000_000n - 2n * 5_000_000n - parts.fee);
    const counts = service.db
      .prepare("SELECT kind, COUNT(*) AS count FROM pool_utxos WHERE status = 'free' GROUP BY kind ORDER BY kind")
      .all();
    expect(counts).toEqual([
      { kind: 'collateral', count: 2 },
      { kind: 'fee', count: 10 },
    ]);

    const lease = await service.leases.create(service.issueKey().record);
    expect(lease.fee.txHash).toBe(result.txId);
    expect(service.collateral.current()?.txHash).toBe(result.txId);
    expect(service.db.prepare("SELECT COUNT(*) AS count FROM pool_utxos WHERE kind = 'collateral' AND status = 'free'").get()).toEqual({ count: 2 });
  });

  it('never spends the shared collateral UTxO, whatever the reserve holds', async () => {
    const collateral = service.fund(txHash(1), 0, 5_000_000n);
    service.fund(txHash(2), 0, 500_000_000n);
    await service.sync.run();
    expect(service.collateral.current()?.txHash).toBe(txHash(1));

    await service.replenish({ feeUtxoCount: 1, collateralCount: 1 });

    const parts = transactionParts(service.provider.submitted[0] as string);
    expect(parts.inputs).toEqual([{ txId: txHash(2), index: 0 }]);
    expect(await service.provider.resolveUnspentOutputs([collateral.input])).toEqual([collateral]);
    expect(service.collateral.current()?.txHash).toBe(txHash(1));
  });

  it('carries a signature from the sponsor wallet', async () => {
    service.fund(txHash(2), 0, 500_000_000n);

    await service.replenish({ feeUtxoCount: 1, collateralCount: 0 });

    const witnessed = service.provider.submitted[0] as string;
    const witnesses = (await service.serviceWallet.wallet.signTransaction(witnessed, false))[0];
    expect(witnesses?.vkey).toMatch(/^[0-9a-f]{64}$/);
    expect(witnessed).toContain(witnesses?.vkey);
    expect(witnessed).toContain(witnesses?.signature);
  });

  it('submits nothing when the pool is already at its targets', async () => {
    for (let i = 0; i < 10; i += 1) {
      service.fund(txHash(100 + i), 0, 100_000_000n);
    }
    service.fund(txHash(200), 0, 5_000_000n);
    service.fund(txHash(201), 0, 5_000_000n);
    service.fund(txHash(2), 0, 2_000_000_000n);

    const result = await service.replenish();

    expect(result.txId).toBeUndefined();
    expect(service.provider.submitted).toHaveLength(0);
    expect(result.reserveLovelace).toBe(2_000_000_000n);
  });

  it('refuses as out of funds when the reserve cannot fund what was asked', async () => {
    service.fund(txHash(2), 0, 50_000_000n);

    const failure = await service.replenish({ feeUtxoCount: 1, collateralCount: 0 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OutOfFundsError);
    expect((failure as OutOfFundsError).toResponseBody()).toEqual({
      error: 'out_of_funds',
      detail: `The reserve holds 50000000 lovelace; a split needs at least ${100_000_000n + REPLENISH_FEE_MARGIN} to create one fee UTxO`,
    });
    expect(service.provider.submitted).toHaveLength(0);
  });
});
