import type Database from 'better-sqlite3';

/** One decision the service made, as the audit trail records it. */
export interface AuditEntry {
  apiKeyId?: number;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
}

/**
 * Appends a decision to the audit table. The detail is stored as JSON and
 * is meant to hold identifiers and amounts only: lease ids, UTxO
 * references, transaction hashes and lovelace, never a transaction body
 * or a key.
 */
export const recordAudit = (db: Database.Database, entry: AuditEntry): void => {
  db.prepare('INSERT INTO audit (ts, api_key_id, action, outcome, detail) VALUES (?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    entry.apiKeyId ?? null,
    entry.action,
    entry.outcome,
    JSON.stringify(entry.detail),
  );
};
