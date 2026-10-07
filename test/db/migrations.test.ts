import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db/connection.js';
import { applyMigrations } from '../../src/db/migrations.js';

const EXPECTED_TABLES = ['api_keys', 'pool_utxos', 'shared_collateral', 'leases', 'witnesses', 'audit'];

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
      `INSERT INTO leases (id, api_key_id, fee_utxo, expires_at, status, created_at)
       VALUES ('lease-1', 1, 'tx1#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO leases (id, api_key_id, fee_utxo, expires_at, status, created_at)
           VALUES ('lease-2', 1, 'tx1#0', '2024-01-01T00:10:00.000Z', 'open', '2024-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('records no collateral on a lease and names the one shared collateral UTxO in its own single row table', () => {
    applyMigrations(db);

    const leaseColumns = (db.prepare('PRAGMA table_info(leases)').all() as { name: string }[]).map((column) => column.name);
    expect(leaseColumns).not.toContain('collateral_utxo');

    db.prepare("INSERT INTO pool_utxos (tx_hash, tx_index, lovelace, kind, status, discovered_at) VALUES ('tx9', 0, 5000000, 'collateral', 'free', '2024-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO shared_collateral (id, tx_hash, tx_index, chosen_at) VALUES (1, 'tx9', 0, '2024-01-01T00:00:00.000Z')").run();
    expect(() => db.prepare("INSERT INTO shared_collateral (id, tx_hash, tx_index, chosen_at) VALUES (2, 'tx9', 0, '2024-01-01T00:00:00.000Z')").run()).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => db.prepare("UPDATE shared_collateral SET tx_hash = 'tx8' WHERE id = 1").run()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('keys a witness by its transaction hash, names a lease at most once and allows a witness with no lease, keeping the witness set and the validity bound', () => {
    applyMigrations(db);

    const columns = (db.prepare('PRAGMA table_info(witnesses)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toContain('witness_set');
    expect(columns).toContain('invalid_hereafter');
    expect(columns).toContain('api_key_id');

    db.prepare("INSERT INTO api_keys (label, key_hash, quotas, created_at) VALUES ('test', 'hash', '{}', '2024-01-01T00:00:00.000Z')").run();
    db.prepare(
      `INSERT INTO leases (id, api_key_id, fee_utxo, expires_at, status, created_at)
       VALUES ('lease-1', 1, 'tx1#0', '2024-01-01T00:10:00.000Z', 'consumed', '2024-01-01T00:00:00.000Z')`,
    ).run();
    const insert = db.prepare(
      'INSERT INTO witnesses (tx_hash, api_key_id, lease_id, sponsored_lovelace, witness_set, invalid_hereafter, issued_at) VALUES (?, 1, ?, 0, ?, 1, ?)',
    );
    insert.run('hash-1', 'lease-1', 'a10080', '2024-01-01T00:01:00.000Z');
    insert.run('hash-2', null, 'a10080', '2024-01-01T00:01:00.000Z');
    insert.run('hash-3', null, 'a10080', '2024-01-01T00:01:00.000Z');

    expect(() => insert.run('hash-1', null, 'a10080', '2024-01-01T00:01:00.000Z')).toThrow(/UNIQUE constraint failed: witnesses.tx_hash/);
    expect(() => insert.run('hash-4', 'lease-1', 'a10080', '2024-01-01T00:01:00.000Z')).toThrow(/UNIQUE constraint failed: witnesses.lease_id/);
  });

  it('is idempotent', () => {
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();

    const migrationCount = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
    expect(migrationCount.count).toBe(1);
  });
});
