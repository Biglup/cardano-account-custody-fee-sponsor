import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hashApiKey } from '../../src/keys.js';
import { TEST_ADMIN_KEY, type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;

beforeEach(async () => {
  service = await createTestService();
  service.fund(txHash(1), 0, 100_000_000n);
  service.fund(txHash(2), 0, 5_000_000n);
  await service.sync.run();
});

afterEach(() => {
  service.close();
});

describe('API key authentication', () => {
  it('refuses a request without an authorization header', async () => {
    const response = await request(service.app).post('/v1/leases');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'unauthorized', detail: 'A valid API key is required' });
  });

  it('refuses a key that was never issued, and a non bearer scheme', async () => {
    const unknown = await request(service.app).post('/v1/leases').set('Authorization', 'Bearer not-a-key');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('unauthorized');

    const basic = await request(service.app).post('/v1/leases').set('Authorization', `Basic ${service.issueKey().apiKey}`);
    expect(basic.status).toBe(401);
  });

  it('refuses a disabled key', async () => {
    const { apiKey, record } = service.issueKey('disabled');
    service.db.prepare('UPDATE api_keys SET disabled_at = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', record.id);

    const response = await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('accepts an issued key, which is stored only as its hash', async () => {
    const { apiKey, record } = service.issueKey('client');
    const stored = service.db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get(record.id) as { key_hash: string };
    expect(stored.key_hash).toBe(hashApiKey(apiKey));
    expect(stored.key_hash).not.toBe(apiKey);

    const response = await request(service.app).post('/v1/leases').set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(201);
  });
});

describe('admin authentication', () => {
  it('refuses the admin routes without the admin key, including with a client key', async () => {
    const missing = await request(service.app).get('/admin/pool');
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'unauthorized', detail: 'The admin API key is required' });

    const client = await request(service.app).get('/admin/pool').set('Authorization', `Bearer ${service.issueKey().apiKey}`);
    expect(client.status).toBe(401);

    const prefix = await request(service.app).get('/admin/pool').set('Authorization', `Bearer ${TEST_ADMIN_KEY}x`);
    expect(prefix.status).toBe(401);
  });

  it('accepts the admin key', async () => {
    const response = await request(service.app).get('/admin/pool').set('Authorization', `Bearer ${TEST_ADMIN_KEY}`);

    expect(response.status).toBe(200);
  });
});
