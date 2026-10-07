import type Database from 'better-sqlite3';

/** One migration: a stable id and the schema change it applies. */
interface Migration {
  id: string;
  up: (db: Database.Database) => void;
}

/**
 * The initial schema: api keys, the sponsor's own pool of UTxOs, the
 * leases clients hold against that pool, the witnesses issued for leases,
 * and an audit trail of every decision the service makes.
 *
 * A witness keeps the witness set it issued so that the same transaction
 * presented again receives the same one. A witness set holds public keys
 * and signatures only; the transaction itself is never stored, only its
 * hash.
 *
 * A pool UTxO is identified by its transaction hash and output index.
 * A lease records which fee and collateral UTxO it holds as
 * `tx_hash#index` references into `pool_utxos`. The partial unique index
 * on `leases.fee_utxo` is what stops two concurrent requests from leasing
 * the same fee UTxO; collateral UTxOs are deliberately left unindexed
 * because the design lets several open leases share one, since a
 * collateral UTxO is only ever spent on a phase two failure the policy
 * already refuses to witness.
 */
const INITIAL_SCHEMA = `
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  quotas TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE pool_utxos (
  tx_hash TEXT NOT NULL,
  tx_index INTEGER NOT NULL,
  lovelace INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fee', 'collateral')),
  status TEXT NOT NULL CHECK (status IN ('free', 'leased', 'consumed', 'gone')),
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (tx_hash, tx_index)
);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  api_key_id INTEGER NOT NULL REFERENCES api_keys (id),
  fee_utxo TEXT NOT NULL,
  collateral_utxo TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'released', 'consumed', 'expired')),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX leases_open_fee_utxo ON leases (fee_utxo) WHERE status = 'open';

CREATE TABLE witnesses (
  lease_id TEXT PRIMARY KEY REFERENCES leases (id),
  tx_hash TEXT NOT NULL,
  sponsored_lovelace INTEGER NOT NULL,
  witness_set TEXT NOT NULL,
  issued_at TEXT NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  api_key_id INTEGER,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

/** Every migration, in the order it must run. */
const migrations: Migration[] = [
  {
    id: '0001_initial_schema',
    up: (db) => db.exec(INITIAL_SCHEMA),
  },
];

/**
 * Applies every migration that has not yet run against `db`, recording
 * each one in `schema_migrations` so a later call is a no-op. Safe to call
 * on every startup and, for tests, against a fresh in memory database.
 */
export const applyMigrations = (db: Database.Database): void => {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) {
      continue;
    }
    const runMigration = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, new Date().toISOString());
    });
    runMigration();
  }
};
