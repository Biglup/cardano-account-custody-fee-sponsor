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
        collateral: { free: 0, leased: 0 },
      },
    });
  });

  it('counts free and leased UTxOs by kind', async () => {
    const insertUtxo = service.db.prepare(
      'INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertUtxo.run('tx1', 0, 100_000_000, 'fee', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx2', 0, 100_000_000, 'fee', 'leased', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx3', 0, 5_000_000, 'collateral', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx4', 0, 100_000_000, 'fee', 'gone', '2024-01-01T00:00:00.000Z');

    const response = await request(service.app).get('/health');

    expect(response.body.pool).toEqual({
      fee: { free: 1, leased: 1 },
      collateral: { free: 1, leased: 0 },
    });
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
