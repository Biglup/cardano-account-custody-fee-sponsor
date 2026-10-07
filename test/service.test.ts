import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { LeaseBody } from '../src/api.js';
import { buildCreation } from './support/client.js';
import { OTHER_MNEMONIC, type TestService, createTestService, txHash } from './support/service.js';

/** A directory of the test's own for the database file, removed afterwards. */
let directory: string;
let databasePath: string;
const services: TestService[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sponsor-'));
  databasePath = join(directory, 'sponsor.sqlite');
});

afterEach(() => {
  for (const service of services.splice(0)) {
    try {
      service.close();
    } catch {
      continue;
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

/** Builds a test service over the shared database file, remembering it for the cleanup. */
const open = async (overrides: Record<string, string> = {}, shared: Parameters<typeof createTestService>[1] = {}): Promise<TestService> => {
  const service = await createTestService({ DATABASE_PATH: databasePath, ...overrides }, shared);
  services.push(service);
  return service;
};

describe('createService', () => {
  it('binds the database to the sponsor address on first start and refuses a start from another mnemonic', async () => {
    const first = await open();
    const address = first.serviceWallet.address;
    expect(first.db.prepare('SELECT address, recorded_at FROM sponsor').all()).toEqual([{ address, recorded_at: '2024-01-01T00:00:00.000Z' }]);
    first.close();

    await expect(open({ SPONSOR_MNEMONIC: OTHER_MNEMONIC })).rejects.toThrow(
      new RegExp(`belongs to the sponsor address ending in ${address.slice(-8)}, recorded at 2024-01-01T00:00:00.000Z, but SPONSOR_MNEMONIC derives one ending in`),
    );

    const again = await open();
    expect(again.serviceWallet.address).toBe(address);
    expect(again.db.prepare('SELECT COUNT(*) AS count FROM sponsor').get()).toEqual({ count: 1 });
  });

  it('keeps the leases, the witnesses, the pool and the shared collateral across a restart over the same database file', async () => {
    const service = await open();
    service.fund(txHash(100), 0, 100_000_000n);
    service.fund(txHash(200), 0, 5_000_000n);
    await service.sync.run();
    const { apiKey, record } = service.issueKey();
    const bearer = { Authorization: `Bearer ${apiKey}` };
    const lease = (await request(service.app).post('/v1/leases').set(bearer)).body as LeaseBody;
    const transaction = await buildCreation(service, lease);
    const issued = await request(service.app).post(`/v1/leases/${lease.leaseId}/witness`).set(bearer).send({ transaction });
    expect(issued.status).toBe(200);
    service.close();

    const restarted = await open({}, { provider: service.provider, clock: service.clock });

    expect(restarted.leases.find(record, lease.leaseId).status).toBe('consumed');
    expect(restarted.witnesses.ofLease(lease.leaseId)?.witnessSet).toBe(issued.body.witnessSet);
    expect(restarted.collateral.current()).toMatchObject({ txHash: txHash(200), index: 0, status: 'free' });
    expect(restarted.db.prepare('SELECT status FROM pool_utxos WHERE tx_hash = ?').get(txHash(100))).toEqual({ status: 'consumed' });
    await restarted.sync.run();
    const reissued = await request(restarted.app).post(`/v1/leases/${lease.leaseId}/witness`).set(bearer).send({ transaction });
    expect(reissued.status).toBe(200);
    expect(reissued.body).toEqual({ witnessSet: issued.body.witnessSet, leaseId: lease.leaseId });
    const health = await request(restarted.app).get('/health');
    expect(health.body.pool).toEqual({ fee: { free: 0, leased: 0 }, collateral: { shared: true, spare: 0, consumed: 0 } });
  });
});
