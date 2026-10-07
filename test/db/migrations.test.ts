import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { applyMigrations } from '../../src/db/migrations.js';

const EXPECTED_TABLES = ['api_keys', 'pool_utxos', 'leases', 'witnesses', 'audit'];

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('applyMigrations', () => {
  it('creates every table the design requires', () => {
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('creates the partial unique index that stops two open leases sharing a fee UTxO', () => {
    applyMigrations(db);

    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'leases_open_fee_utxo'")
      .get() as { sql: string } | undefined;

    expect(index).toBeDefined();
    expect(index?.sql).toContain('fee_utxo');
    expect(index?.sql).toContain("WHERE status = 'open'");

    db.prepare(
      "INSERT INTO api_keys (label, key_hash, quotas, created_at) VALUES ('test', 'hash', '{}', '2024-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
       VALUES ('lease-1', 1, 'tx1#0', 'tx2#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
           VALUES ('lease-2', 1, 'tx1#0', 'tx3#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('allows the same collateral UTxO to back more than one open lease', () => {
    applyMigrations(db);

    db.prepare(
      "INSERT INTO api_keys (label, key_hash, quotas, created_at) VALUES ('test', 'hash', '{}', '2024-01-01T00:00:00.000Z')",
    ).run();
    db.prepare(
      `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
       VALUES ('lease-1', 1, 'tx1#0', 'tx9#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO leases (id, api_key_id, fee_utxo, collateral_utxo, expires_at, status, created_at)
           VALUES ('lease-2', 1, 'tx2#0', 'tx9#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('is idempotent', () => {
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();

    const migrationCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(migrationCount.count).toBe(1);
  });
});
