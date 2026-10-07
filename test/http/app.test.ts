import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type TestService, createTestService } from '../support/service.js';

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
});

afterEach(() => {
  service.close();
});

describe('GET /health', () => {
  it('reports the service is up with an empty pool before replenishment', async () => {
    const response = await request(service.app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      network: 'preprod',
      pool: {
        fee: { free: 0, leased: 0 },
        collateral: { shared: false, spare: 0, consumed: 0 },
      },
    });
  });

  it('counts free and leased fee UTxOs, and the shared, spare and consumed collateral UTxOs', async () => {
    const insertUtxo = service.db.prepare(
      'INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertUtxo.run('tx1', 0, 100_000_000, 'fee', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx2', 0, 100_000_000, 'fee', 'leased', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx3', 0, 5_000_000, 'collateral', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx4', 0, 100_000_000, 'fee', 'gone', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx5', 0, 5_000_000, 'collateral', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx6', 0, 5_000_000, 'collateral', 'consumed', '2024-01-01T00:00:00.000Z');

    const before = await request(service.app).get('/health');
    expect(before.body.pool).toEqual({ fee: { free: 1, leased: 1 }, collateral: { shared: false, spare: 2, consumed: 1 } });

    service.db.prepare("INSERT INTO shared_collateral (id, tx_hash, tx_index, chosen_at) VALUES (1, 'tx3', 0, '2024-01-01T00:00:00.000Z')").run();
    const after = await request(service.app).get('/health');

    expect(after.body.pool).toEqual({ fee: { free: 1, leased: 1 }, collateral: { shared: true, spare: 1, consumed: 1 } });
  });
});

describe('unmatched routes', () => {
  it('answers with the same JSON error shape as every other failure', async () => {
    const response = await request(service.app).get('/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', detail: 'No route for GET /v1/does-not-exist' });
    expect(response.body).not.toHaveProperty('stack');
  });
});

describe('request body limit', () => {
  it('rejects a JSON body larger than 64 KiB', async () => {
    const oversized = { padding: 'x'.repeat(70 * 1024) };

    const response = await request(service.app).post('/health').send(oversized);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'payload_too_large' });
  });
});
