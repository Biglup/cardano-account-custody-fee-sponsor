import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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

const bearer = (apiKey: string): Record<string, string> => ({ Authorization: `Bearer ${apiKey}` });

describe('POST /v1/leases', () => {
  it('answers 201 with the lease, the fee UTxO, the shared collateral UTxO, the sponsor address and the sponsoring limit', async () => {
    await fundPool(1, 1);
    const { apiKey } = service.issueKey();

    const response = await request(service.app).post('/v1/leases').set(bearer(apiKey));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      leaseId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expiresAt: '2024-01-01T00:10:00.000Z',
      fee: { txHash: txHash(100), index: 0, address: service.serviceWallet.address, lovelace: 100_000_000 },
      collateral: { txHash: txHash(200), index: 0, address: service.serviceWallet.address, lovelace: 5_000_000 },
      sponsorAddress: service.serviceWallet.address,
      maxSponsoredLovelace: 6_000_000,
    });
    const health = await request(service.app).get('/health');
    expect(health.body.pool).toEqual({ fee: { free: 0, leased: 1 }, collateral: { shared: true, spare: 0, consumed: 0 } });
  });

  it('names the same shared collateral UTxO on every lease, and answers 409 no_utxo_available when the pool holds none', async () => {
    await fundPool(3, 2);
    const { apiKey } = service.issueKey();

    const first = await request(service.app).post('/v1/leases').set(bearer(apiKey));
    const second = await request(service.app).post('/v1/leases').set(bearer(apiKey));

    expect(first.body.collateral).toEqual(second.body.collateral);
    expect(first.body.collateral.txHash).toBe(txHash(200));
    const health = await request(service.app).get('/health');
    expect(health.body.pool.collateral).toEqual({ shared: true, spare: 1, consumed: 0 });

    const bare = await createTestService();
    try {
      bare.fund(txHash(100), 0, 100_000_000n);
      bare.fund(txHash(300), 0, 1_000_000_000n);
      await bare.sync.run();
      const refused = await request(bare.app).post('/v1/leases').set(bearer(bare.issueKey().apiKey));
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({
        error: 'no_utxo_available',
        detail: 'The pool has no collateral UTxO yet; the reserve holds 1000000000 lovelace and can be split by replenishing',
      });
      expect((await request(bare.app).get('/health')).body.pool).toEqual({ fee: { free: 1, leased: 0 }, collateral: { shared: false, spare: 0, consumed: 0 } });
    } finally {
      bare.close();
    }
  });

  it('never leases the same fee UTxO twice under concurrent requests', async () => {
    await fundPool(10, 2);
    const { apiKey } = service.issueKey('busy', { openLeases: 50 });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => request(service.app).post('/v1/leases').set(bearer(apiKey))),
    );

    const created = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status === 409);
    expect(created).toHaveLength(10);
    expect(refused).toHaveLength(40);
    const feeUtxos = new Set(created.map((response) => `${response.body.fee.txHash}#${response.body.fee.index}`));
    expect(feeUtxos.size).toBe(10);
    for (const response of refused) {
      expect(response.body.error).toBe('no_utxo_available');
      expect(response.body.detail).toMatch(/^All 10 fee UTxOs are leased; the soonest lease expires at 2024-01-01T00:10:00.000Z$/);
    }
    const openLeases = service.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE status = 'open'").get() as { count: number };
    expect(openLeases.count).toBe(10);
  });

  it('answers 429 quota_exceeded naming the quota once the key holds its open leases', async () => {
    await fundPool(6, 1);
    const { apiKey } = service.issueKey();
    for (let i = 0; i < 5; i += 1) {
      expect((await request(service.app).post('/v1/leases').set(bearer(apiKey))).status).toBe(201);
    }

    const response = await request(service.app).post('/v1/leases').set(bearer(apiKey));

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: 'quota_exceeded', detail: 'open_leases: at most 5 open leases per key' });
  });

  it('answers 503 out_of_funds when the pool is empty and the reserve cannot fund a split', async () => {
    service.fund(txHash(200), 0, 5_000_000n);
    service.fund(txHash(300), 0, 20_000_000n);
    await service.sync.run();
    const { apiKey } = service.issueKey();

    const response = await request(service.app).post('/v1/leases').set(bearer(apiKey));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'out_of_funds',
      detail: `The pool has no fee UTxO and the reserve holds 20000000 lovelace; a split needs at least ${100_000_000n + REPLENISH_FEE_MARGIN}`,
    });
  });
});

describe('DELETE /v1/leases/:id', () => {
  it('releases a lease the key holds', async () => {
    await fundPool(1, 1);
    const { apiKey } = service.issueKey();
    const created = await request(service.app).post('/v1/leases').set(bearer(apiKey));

    const response = await request(service.app).delete(`/v1/leases/${created.body.leaseId}`).set(bearer(apiKey));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ leaseId: created.body.leaseId, status: 'released' });
    const health = await request(service.app).get('/health');
    expect(health.body.pool.fee).toEqual({ free: 1, leased: 0 });
  });

  it('answers 404 unknown_lease for a lease another key holds, or that does not exist', async () => {
    await fundPool(1, 1);
    const owner = service.issueKey('owner');
    const other = service.issueKey('other');
    const created = await request(service.app).post('/v1/leases').set(bearer(owner.apiKey));

    const foreign = await request(service.app).delete(`/v1/leases/${created.body.leaseId}`).set(bearer(other.apiKey));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'unknown_lease', detail: `No lease ${created.body.leaseId} exists` });

    const missing = await request(service.app).delete('/v1/leases/missing').set(bearer(owner.apiKey));
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('unknown_lease');
  });

  it('answers 410 lease_expired once the lease has run out', async () => {
    await fundPool(1, 1);
    const { apiKey } = service.issueKey();
    const created = await request(service.app).post('/v1/leases').set(bearer(apiKey));
    service.clock.now = new Date('2024-01-01T00:10:00.000Z');

    const response = await request(service.app).delete(`/v1/leases/${created.body.leaseId}`).set(bearer(apiKey));

    expect(response.status).toBe(410);
    expect(response.body.error).toBe('lease_expired');
  });
});
