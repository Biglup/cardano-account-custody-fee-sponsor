import type Database from 'better-sqlite3';

/** One decision the service made, as the audit trail records it. */
export interface AuditEntry {
  apiKeyId?: number;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
}

/** An audit entry as the admin route reads it back: numbered and timestamped, with no key for a decision no key asked for. */
export interface RecordedAuditEntry {
  id: number;
  ts: string;
  apiKeyId: number | undefined;
  action: string;
  outcome: string;
  detail: Record<string, unknown>;
}

/** A row of the audit table as sqlite returns it. */
export interface AuditRow {
  id: number;
  ts: string;
  api_key_id: number | null;
  action: string;
  outcome: string;
  detail: string;
}

/** The recorded entry a row describes, with its detail parsed back into the object that was recorded. */
export const toAuditEntry = (row: AuditRow): RecordedAuditEntry => ({
  id: row.id,
  ts: row.ts,
  apiKeyId: row.api_key_id ?? undefined,
  action: row.action,
  outcome: row.outcome,
  detail: JSON.parse(row.detail) as Record<string, unknown>,
});

/**
 * Appends a decision made at `at` to the audit table. The detail is
 * stored as JSON and is meant to hold identifiers and amounts only: lease
 * ids, UTxO references, transaction hashes and lovelace, never a
 * transaction body or a key.
 */
export const recordAudit = (db: Database.Database, entry: AuditEntry, at: Date): void => {
  db.prepare('INSERT INTO audit (ts, api_key_id, action, outcome, detail) VALUES (?, ?, ?, ?, ?)').run(
    at.toISOString(),
    entry.apiKeyId ?? null,
    entry.action,
    entry.outcome,
    JSON.stringify(entry.detail),
  );
};
