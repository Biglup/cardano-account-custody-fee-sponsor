import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import pino from 'pino';
import request from 'supertest';
import { openDatabase } from '../../src/db/connection.js';
import { applyMigrations } from '../../src/db/migrations.js';
import { createApp } from '../../src/http/app.js';

const silentLogger = pino({ level: 'silent' });

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  applyMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('GET /health', () => {
  it('reports the service is up with an empty pool before replenishment', async () => {
    const app = createApp({ db, logger: silentLogger, network: 'preprod' });

    const response = await request(app).get('/health');

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
    const insertUtxo = db.prepare(
      'INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertUtxo.run('tx1', 0, 100_000_000, 'fee', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx2', 0, 100_000_000, 'fee', 'leased', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx3', 0, 5_000_000, 'collateral', 'free', '2024-01-01T00:00:00.000Z');
    insertUtxo.run('tx4', 0, 100_000_000, 'fee', 'gone', '2024-01-01T00:00:00.000Z');

    const app = createApp({ db, logger: silentLogger, network: 'preprod' });
    const response = await request(app).get('/health');

    expect(response.body.pool).toEqual({
      fee: { free: 1, leased: 1 },
      collateral: { free: 1, leased: 0 },
    });
  });
});

describe('unmatched routes', () => {
  it('answers with the same JSON error shape as every other failure', async () => {
    const app = createApp({ db, logger: silentLogger, network: 'preprod' });

    const response = await request(app).get('/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found', detail: 'No route for GET /v1/does-not-exist' });
    expect(response.body).not.toHaveProperty('stack');
  });
});

describe('request body limit', () => {
  it('rejects a JSON body larger than 64 KiB', async () => {
    const app = createApp({ db, logger: silentLogger, network: 'preprod' });
    const oversized = { padding: 'x'.repeat(70 * 1024) };

    const response = await request(app).post('/health').send(oversized);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'payload_too_large' });
  });
});
