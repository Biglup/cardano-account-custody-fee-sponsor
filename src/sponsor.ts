import type Database from 'better-sqlite3';

/** The row recording which sponsor address the database belongs to, as sqlite returns it. */
type SponsorRow = { address: string; recorded_at: string };

/**
 * Binds the database to the sponsor address: the first start records the
 * address the wallet derived, and every later start must derive the same
 * one, since the pool, the leases and the witnesses all describe that
 * wallet's UTxOs. A different address means a different mnemonic was
 * supplied, or a database of another sponsor was pointed at, and the
 * service refuses to start rather than mix the two; the error names
 * neither address in full.
 */
export const bindSponsorAddress = (db: Database.Database, address: string, at: Date): void => {
  const recorded = db.prepare('SELECT address, recorded_at FROM sponsor WHERE id = 1').get() as SponsorRow | undefined;
  if (recorded === undefined) {
    db.prepare('INSERT INTO sponsor (id, address, recorded_at) VALUES (1, ?, ?)').run(address, at.toISOString());
    return;
  }
  if (recorded.address !== address) {
    throw new Error(
      `The database belongs to the sponsor address ending in ${recorded.address.slice(-8)}, recorded at ${recorded.recorded_at}, but SPONSOR_MNEMONIC derives one ending in ${address.slice(-8)}; use that sponsor's database or its mnemonic`,
    );
  }
};
