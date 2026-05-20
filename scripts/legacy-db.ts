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
    ...extra,
  });
}
