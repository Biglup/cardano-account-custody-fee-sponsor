import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hashApiKey } from '../../src/keys.js';
import { TEST_ADMIN_KEY, type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
});

afterEach(() => {
  service.close();
});

const admin = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };

describe('POST /admin/keys', () => {
  it('issues a key once, stores its hash with the label and quotas, and the key then works', async () => {
    const response = await request(service.app).post('/admin/keys').set(admin).send({ label: 'wallet-a', quotas: { openLeases: 7 } });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      apiKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      id: 1,
      label: 'wallet-a',
      quotas: { openLeases: 7, witnessesPerHour: 60, sponsoredLovelacePerDay: 600_000_000 },
    });
    const stored = service.db.prepare('SELECT label, key_hash, quotas FROM api_keys WHERE id = 1').get() as Record<string, string>;
    expect(stored).toEqual({ label: 'wallet-a', key_hash: hashApiKey(response.body.apiKey), quotas: '{"openLeases":7}' });

    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    const lease = await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${response.body.apiKey}`);
    expect(lease.status).toBe(201);
  });

  it('refuses a body without a label or with an unknown quota', async () => {
    const noLabel = await request(service.app).post('/admin/keys').set(admin).send({});
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.error).toBe('invalid_request');
    expect(noLabel.body.detail).toContain('label');

    const unknownQuota = await request(service.app).post('/admin/keys').set(admin).send({ label: 'x', quotas: { witnesses: 1 } });
    expect(unknownQuota.status).toBe(400);
  });
});

describe('GET /admin/keys', () => {
  it('lists every key with its quotas and times, oldest first, and never the hash', async () => {
    const first = await request(service.app).post('/admin/keys').set(admin).send({ label: 'wallet-a', quotas: { openLeases: 7 } });
    service.clock.now = new Date('2024-01-01T00:05:00.000Z');
    const second = await request(service.app).post('/admin/keys').set(admin).send({ label: 'wallet-b' });
    await request(service.app).delete(`/admin/keys/${second.body.id}`).set(admin);

    const response = await request(service.app).get('/admin/keys').set(admin);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      keys: [
        {
          id: 1,
          label: 'wallet-a',
          quotas: { openLeases: 7, witnessesPerHour: 60, sponsoredLovelacePerDay: 600_000_000 },
          createdAt: '2024-01-01T00:00:00.000Z',
          disabledAt: null,
        },
        {
          id: 2,
          label: 'wallet-b',
          quotas: { openLeases: 5, witnessesPerHour: 60, sponsoredLovelacePerDay: 600_000_000 },
          createdAt: '2024-01-01T00:05:00.000Z',
          disabledAt: '2024-01-01T00:05:00.000Z',
        },
      ],
    });
    expect(response.text).not.toContain(hashApiKey(first.body.apiKey));
    expect(response.text).not.toContain(hashApiKey(second.body.apiKey));
  });
});

describe('DELETE /admin/keys/:id', () => {
  it('disables the key, records it, refuses the key afterwards and answers the same for a key already disabled', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    const issued = await request(service.app).post('/admin/keys').set(admin).send({ label: 'wallet-a' });
    const bearer = { Authorization: `Bearer ${issued.body.apiKey}` };
    expect((await request(service.app).post('/v1/leases').set(bearer)).status).toBe(201);
    service.clock.now = new Date('2024-01-01T00:05:00.000Z');

    const disabled = await request(service.app).delete(`/admin/keys/${issued.body.id}`).set(admin);

    expect(disabled.status).toBe(200);
    expect(disabled.body).toEqual({ id: issued.body.id, label: 'wallet-a' });
    expect((await request(service.app).post('/v1/leases').set(bearer)).status).toBe(401);
    expect((await request(service.app).get('/v1/collateral').set(bearer)).status).toBe(401);
    const audit = await request(service.app).get('/admin/audit').set(admin);
    expect(audit.body.entries.filter((entry: { action: string }) => entry.action === 'key')).toEqual([
      { id: expect.any(Number), ts: '2024-01-01T00:05:00.000Z', action: 'key', outcome: 'disabled', detail: { keyId: issued.body.id, label: 'wallet-a' } },
    ]);

    service.clock.now = new Date('2024-01-01T00:10:00.000Z');
    const again = await request(service.app).delete(`/admin/keys/${issued.body.id}`).set(admin);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id: issued.body.id, label: 'wallet-a' });
    expect(service.db.prepare('SELECT disabled_at FROM api_keys WHERE id = ?').get(issued.body.id)).toEqual({ disabled_at: '2024-01-01T00:05:00.000Z' });
    const unchanged = await request(service.app).get('/admin/audit').set(admin);
    expect(unchanged.body.entries.filter((entry: { action: string }) => entry.action === 'key')).toHaveLength(1);
  });

  it('answers 404 not_found for an id no key has, and 400 invalid_request for an id that is not a number', async () => {
    const unknown = await request(service.app).delete('/admin/keys/999').set(admin);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'not_found', detail: 'No key 999 exists' });

    const malformed = await request(service.app).delete('/admin/keys/first').set(admin);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_request');
  });
});

describe('GET /admin/pool', () => {
  it('reports the counts, the reserve, the open leases, the shared collateral and every live UTxO', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    service.fund(txHash(3), 0, 700_000_000n);
    await service.sync.run();
    await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${service.issueKey().apiKey}`);

    const response = await request(service.app).get('/admin/pool').set(admin);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      pool: { fee: { free: 0, leased: 1 }, collateral: { shared: true, spare: 0, consumed: 0 } },
      reserve: { utxos: 1, lovelace: '700000000', syncedAt: expect.any(String) },
      leases: { open: 1 },
      sharedCollateral: { txHash: txHash(2), index: 0, lovelace: 5_000_000, chosenAt: '2024-01-01T00:00:00.000Z' },
      utxos: [
        { txHash: txHash(2), index: 0, lovelace: 5_000_000, kind: 'collateral', status: 'free', discoveredAt: expect.any(String) },
        { txHash: txHash(1), index: 0, lovelace: 100_000_000, kind: 'fee', status: 'leased', discoveredAt: expect.any(String) },
      ],
    });
  });
});

describe('GET /admin/audit', () => {
  it('lists the audit trail from a point in time, oldest first, with the key and the parsed detail', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    const { apiKey, record } = service.issueKey();
    const lease = await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${apiKey}`);
    service.clock.now = new Date('2024-01-01T00:05:00.000Z');
    await request(service.app).delete(`/v1/leases/${lease.body.leaseId}`).set('Authorization', `Bearer ${apiKey}`);

    const everything = await request(service.app).get('/admin/audit').set(admin);
    const later = await request(service.app).get('/admin/audit').query({ since: '2024-01-01T00:05:00.000Z' }).set(admin);
    const one = await request(service.app).get('/admin/audit').query({ limit: 1 }).set(admin);

    expect(everything.status).toBe(200);
    expect(everything.body.entries).toEqual([
      {
        id: 1,
        ts: '2024-01-01T00:00:00.000Z',
        apiKeyId: record.id,
        action: 'lease',
        outcome: 'created',
        detail: { leaseId: lease.body.leaseId, feeUtxo: `${txHash(1)}#0`, expiresAt: '2024-01-01T00:10:00.000Z' },
      },
      { id: 2, ts: '2024-01-01T00:05:00.000Z', apiKeyId: record.id, action: 'lease', outcome: 'released', detail: { leaseId: lease.body.leaseId } },
    ]);
    expect(later.body.entries.map((entry: { outcome: string }) => entry.outcome)).toEqual(['released']);
    expect(one.body.entries.map((entry: { outcome: string }) => entry.outcome)).toEqual(['created']);
  });

  it('reads since with an offset or without a fraction as the same instant the trail stores', async () => {
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    const { apiKey } = service.issueKey();
    const lease = await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${apiKey}`);
    service.clock.now = new Date('2024-01-01T00:05:00.000Z');
    await request(service.app).delete(`/v1/leases/${lease.body.leaseId}`).set('Authorization', `Bearer ${apiKey}`);
    const outcomes = async (since: string): Promise<string[]> => {
      const response = await request(service.app).get('/admin/audit').query({ since }).set(admin);
      expect(response.status).toBe(200);
      return response.body.entries.map((entry: { outcome: string }) => entry.outcome);
    };

    expect(await outcomes('2024-01-01T01:05:00.000+01:00')).toEqual(['released']);
    expect(await outcomes('2024-01-01T00:05:00Z')).toEqual(['released']);
    expect(await outcomes('2023-12-31T19:00:00-05:00')).toEqual(['created', 'released']);
    expect(await outcomes('2024-01-01T00:05:01Z')).toEqual([]);
  });

  it('refuses a since that is not a timestamp, a limit over the page size and an unknown parameter', async () => {
    const since = await request(service.app).get('/admin/audit').query({ since: 'yesterday' }).set(admin);
    expect(since.status).toBe(400);
    expect(since.body.error).toBe('invalid_request');
    expect(since.body.detail).toContain('since');

    const limit = await request(service.app).get('/admin/audit').query({ limit: 1001 }).set(admin);
    expect(limit.status).toBe(400);

    const unknown = await request(service.app).get('/admin/audit').query({ key: 1 }).set(admin);
    expect(unknown.status).toBe(400);
  });
});

describe('POST /admin/pool/replenish', () => {
  it('splits the reserve and reports the transaction and counts', async () => {
    service.fund(txHash(3), 0, 400_000_000n);

    const response = await request(service.app).post('/admin/pool/replenish').set(admin).send({ feeUtxoCount: 2, collateralCount: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      txId: expect.stringMatching(/^[0-9a-f]{64}$/),
      feeOutputs: 2,
      collateralOutputs: 1,
      reserveLovelace: expect.stringMatching(/^\d+$/),
    });
    const health = await request(service.app).get('/health');
    expect(health.body.pool).toEqual({ fee: { free: 2, leased: 0 }, collateral: { shared: true, spare: 0, consumed: 0 } });
  });

  it('answers 503 out_of_funds when the reserve cannot fund the split', async () => {
    service.fund(txHash(3), 0, 10_000_000n);

    const response = await request(service.app).post('/admin/pool/replenish').set(admin).send({ feeUtxoCount: 1, collateralCount: 0 });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('out_of_funds');
    expect(response.body.detail).toContain('10000000 lovelace');
  });

  it('refuses an unknown field', async () => {
    const response = await request(service.app).post('/admin/pool/replenish').set(admin).send({ count: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_request');
  });
});
