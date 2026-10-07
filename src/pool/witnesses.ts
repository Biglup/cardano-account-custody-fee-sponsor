import Database from 'better-sqlite3';
import { QuotaExceededError } from '../http/errors.js';
import type { ApiKey } from '../keys.js';

/**
 * A witness the service issued: the hash of the transaction it signs, the
 * lease it consumed when one was involved, what it sponsors, the witness
 * set itself, and the slot the transaction stops being valid at, after
 * which the fee UTxO it spends is safe to lease again if the chain still
 * holds it.
 */
export interface Witness {
  txHash: string;
  leaseId: string | undefined;
  sponsoredLovelace: number;
  witnessSet: string;
  invalidHereafter: number;
  issuedAt: string;
}

/** A witness quota a key has used up: which one, and the sentence saying its bound. */
export interface QuotaShortfall {
  quota: 'witnesses_per_hour' | 'sponsored_lovelace_per_day';
  detail: string;
}

/** Thrown when a witness for the transaction was already recorded, which is what a concurrent request for the same transaction sees. */
export class WitnessRecordedError extends Error {
  readonly txHash: string;

  constructor(txHash: string) {
    super(`A witness for transaction ${txHash} was already recorded`);
    this.name = 'WitnessRecordedError';
    this.txHash = txHash;
  }
}

/** The witness store: records the witnesses issued, finds them again and measures the witness quotas against them. */
export interface WitnessStore {
  /**
   * The witness quota the key would break by obtaining one more witness
   * now, sponsoring `sponsoredLovelace` when that is known yet, or
   * undefined when both quotas hold.
   */
  quotaShortfall(apiKey: ApiKey, sponsoredLovelace?: number): QuotaShortfall | undefined;
  /**
   * Records a witness issued to the key, after checking its witness
   * quotas once more in the same step, so that requests in flight at the
   * same time cannot pass them together; a quota that no longer holds is
   * refused by `QuotaExceededError`, a transaction already witnessed by
   * `WitnessRecordedError`.
   */
  record(apiKey: ApiKey, witness: Omit<Witness, 'issuedAt'>): void;
  /** The witness issued for the lease, if one was. */
  ofLease(leaseId: string): Witness | undefined;
  /** The witness issued for the transaction, if one was. */
  ofTransaction(txHash: string): Witness | undefined;
}

/** Everything the store needs injected; `now` lets tests move the clock the quota windows are measured against. */
export interface WitnessStoreDependencies {
  db: Database.Database;
  now?: () => Date;
}

type WitnessRow = {
  tx_hash: string;
  lease_id: string | null;
  sponsored_lovelace: number;
  witness_set: string;
  invalid_hereafter: number;
  issued_at: string;
};

/** The windows the witness quotas are measured over. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Whether an error is sqlite refusing a row that breaks a unique constraint. */
const isUniqueViolation = (err: unknown): boolean => err instanceof Database.SqliteError && err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';

/** The witness a row describes. */
const toWitness = (row: WitnessRow): Witness => ({
  txHash: row.tx_hash,
  leaseId: row.lease_id ?? undefined,
  sponsoredLovelace: row.sponsored_lovelace,
  witnessSet: row.witness_set,
  invalidHereafter: row.invalid_hereafter,
  issuedAt: row.issued_at,
});

/**
 * Creates the witness store. The quotas count the witnesses issued to a
 * key over the last hour and the lovelace they sponsored over the last
 * day; a witness answered again for a transaction already witnessed is
 * never recorded twice, so it counts once. Recording is one sqlite
 * transaction that measures the quotas again, which is what makes their
 * bound hold however many requests for one key are in flight at once.
 */
export const createWitnessStore = ({ db, now = () => new Date() }: WitnessStoreDependencies): WitnessStore => {
  const insertWitness = db.prepare(
    'INSERT INTO witnesses (tx_hash, api_key_id, lease_id, sponsored_lovelace, witness_set, invalid_hereafter, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectByLease = db.prepare('SELECT * FROM witnesses WHERE lease_id = ?');
  const selectByTransaction = db.prepare('SELECT * FROM witnesses WHERE tx_hash = ?');
  const countRecent = db.prepare('SELECT COUNT(*) AS count FROM witnesses WHERE api_key_id = ? AND issued_at > ?');
  const sumRecentSponsored = db.prepare('SELECT COALESCE(SUM(sponsored_lovelace), 0) AS total FROM witnesses WHERE api_key_id = ? AND issued_at > ?');

  /** The start of the window of `length` milliseconds ending now, as the witness table stores times. */
  const windowStart = (length: number): string => new Date(now().getTime() - length).toISOString();

  const quotaShortfall = (apiKey: ApiKey, sponsoredLovelace?: number): QuotaShortfall | undefined => {
    const issued = (countRecent.get(apiKey.id, windowStart(HOUR_MS)) as { count: number }).count;
    if (issued >= apiKey.quotas.witnessesPerHour) {
      return { quota: 'witnesses_per_hour', detail: `at most ${apiKey.quotas.witnessesPerHour} witnesses per hour per key` };
    }
    if (sponsoredLovelace === undefined) {
      return undefined;
    }
    const total = BigInt((sumRecentSponsored.get(apiKey.id, windowStart(DAY_MS)) as { total: number }).total);
    if (total + BigInt(sponsoredLovelace) > BigInt(apiKey.quotas.sponsoredLovelacePerDay)) {
      return {
        quota: 'sponsored_lovelace_per_day',
        detail: `at most ${apiKey.quotas.sponsoredLovelacePerDay} sponsored lovelace per day per key`,
      };
    }
    return undefined;
  };

  const record = db.transaction((apiKey: ApiKey, witness: Omit<Witness, 'issuedAt'>): void => {
    const shortfall = quotaShortfall(apiKey, witness.sponsoredLovelace);
    if (shortfall !== undefined) {
      throw new QuotaExceededError(shortfall.quota, shortfall.detail);
    }
    try {
      insertWitness.run(
        witness.txHash,
        apiKey.id,
        witness.leaseId ?? null,
        witness.sponsoredLovelace,
        witness.witnessSet,
        witness.invalidHereafter,
        now().toISOString(),
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new WitnessRecordedError(witness.txHash);
      }
      throw err;
    }
  });

  return {
    quotaShortfall,
    record,
    ofLease: (leaseId) => {
      const row = selectByLease.get(leaseId) as WitnessRow | undefined;
      return row === undefined ? undefined : toWitness(row);
    },
    ofTransaction: (txHash) => {
      const row = selectByTransaction.get(txHash) as WitnessRow | undefined;
      return row === undefined ? undefined : toWitness(row);
    },
  };
};
