import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;

afterEach(() => {
  service.close();
});

const bearer = (apiKey: string): Record<string, string> => ({ Authorization: `Bearer ${apiKey}` });

describe('rate limits', () => {
  it('answers 429 rate_limited once an address made its requests for the minute, whatever it presented', async () => {
    service = await createTestService({ IP_RATE_LIMIT_PER_MINUTE: '3' });

    const allowed = await Promise.all([
      request(service.app).get('/health'),
      request(service.app).post('/v1/leases').set(bearer('forged')),
      request(service.app).get('/admin/pool'),
    ]);
    const refused = await request(service.app).get('/health');

    expect(allowed.map((response) => response.status)).toEqual([200, 401, 401]);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'rate_limited', detail: 'Too many requests' });
    expect(refused.headers['ratelimit-policy']).toContain('q=3');
    expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('answers 429 rate_limited once a key made its requests for the minute, leaving other keys and its quotas alone', async () => {
    service = await createTestService({ KEY_RATE_LIMIT_PER_MINUTE: '2' });
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 100_000_000n);
    service.fund(txHash(3), 0, 5_000_000n);
    await service.sync.run();
    const busy = service.issueKey('busy').apiKey;
    const other = service.issueKey('other').apiKey;

    const first = await request(service.app).post('/v1/leases').set(bearer(busy));
    const second = await request(service.app).delete(`/v1/leases/${first.body.leaseId}`).set(bearer(busy));
    const third = await request(service.app).post('/v1/leases').set(bearer(busy));
    const elsewhere = await request(service.app).post('/v1/leases').set(bearer(other));

    expect([first.status, second.status]).toEqual([201, 200]);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'rate_limited', detail: 'Too many requests' });
    expect(elsewhere.status).toBe(201);
    const open = service.db.prepare("SELECT COUNT(*) AS count FROM leases WHERE status = 'open'").get() as { count: number };
    expect(open.count).toBe(1);
  });

  it('does not count a request refused for its key against that key', async () => {
    service = await createTestService({ KEY_RATE_LIMIT_PER_MINUTE: '1' });
    service.fund(txHash(1), 0, 100_000_000n);
    service.fund(txHash(2), 0, 5_000_000n);
    await service.sync.run();
    const key = service.issueKey().apiKey;
    await request(service.app).post('/v1/leases').set(bearer('forged'));

    const response = await request(service.app).post('/v1/leases').set(bearer(key));

    expect(response.status).toBe(201);
  });
});
