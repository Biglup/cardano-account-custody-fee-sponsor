import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Opens the sqlite database at `path` with write ahead logging enabled, so
 * readers (the health endpoint, the sweeper) never block on a writer
 * leasing a UTxO. Pass `:memory:` for a database that lives only for the
 * current process, as the test suite does.
 *
 * The parent directory is created if missing, so a fresh checkout can run
 * against the default `DATABASE_PATH` without a manual setup step.
 */
export const openDatabase = (path: string): Database.Database => {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
};
