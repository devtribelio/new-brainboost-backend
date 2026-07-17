/**
 * Shared legacy-MariaDB connector for migration / backfill scripts.
 *
 * Credentials are read from .env — never hardcoded:
 *   LEGACY_DB_HOST, LEGACY_DB_USER, LEGACY_DB_PASS, LEGACY_DB_NAME
 */
import 'dotenv/config';
import mysql, { type Connection, type ConnectionOptions } from 'mysql2/promise';

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}. Set the LEGACY_DB_* vars in .env.`);
  }
  return v;
}

/** Open a connection to the legacy MariaDB using .env credentials. */
export function connectLegacyDb(extra?: ConnectionOptions): Promise<Connection> {
  return mysql.createConnection({
    host: reqEnv('LEGACY_DB_HOST'),
    user: reqEnv('LEGACY_DB_USER'),
    password: reqEnv('LEGACY_DB_PASS'),
    database: reqEnv('LEGACY_DB_NAME'),
    // Legacy DATETIMEs are stored as Asia/Jakarta / Bangkok wall-clock (WIB, UTC+7).
    // Without this, mysql2 reads them as if UTC → every timestamp lands 7h in the
    // future. Telling mysql2 the source tz makes it convert to the correct UTC Date.
    // Mirrors apps/resync-worker/src/legacy-db.ts — keep both in sync.
    timezone: process.env.LEGACY_DB_TIMEZONE ?? '+07:00',
    ...extra,
  });
}
