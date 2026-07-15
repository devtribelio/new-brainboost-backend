/**
 * Shared legacy-MariaDB connector for migration / backfill scripts.
 *
 * Credentials are read from .env — never hardcoded:
 *   LEGACY_DB_HOST, LEGACY_DB_USER, LEGACY_DB_PASS, LEGACY_DB_NAME
 */
import 'dotenv/config';
import mysql, {
  type Connection,
  type ConnectionOptions,
  type FieldPacket,
  type RowDataPacket,
} from 'mysql2/promise';

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
    timezone: process.env.LEGACY_DB_TIMEZONE ?? '+07:00',
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Resilient client — reconnect + retry on a dropped legacy connection.
// The legacy RDS drops idle/long connections (ECONNRESET / connection lost);
// every resync query is a read-only SELECT, so retrying after a reconnect is
// side-effect-free. See docs/specs/legacy-resync-plan.md §8.
// ---------------------------------------------------------------------------

/** Minimal surface the syncers use (query) + core uses (end). */
export interface LegacyClient {
  query<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]>;
  end(): Promise<void>;
}

const CONN_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_CON_COUNT_ERROR',
]);

/** True when the error means the connection is dead and a reconnect could recover it. */
export function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; fatal?: boolean; message?: string } | null;
  if (!e) return false;
  if (e.fatal) return true;
  if (e.code && CONN_ERROR_CODES.has(e.code)) return true;
  return /connection.*(lost|closed)|closed state|read ECONNRESET/i.test(e.message ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A LegacyClient that transparently reconnects and retries a query when the
 * connection drops. `retries` = max reconnect attempts per query (exponential
 * backoff 1s/2s/4s…, capped 30s). A non-connection error (bad SQL etc.) is
 * thrown immediately without retry.
 */
export async function connectResilientLegacy(
  extra: ConnectionOptions | undefined,
  retries: number,
  log: (msg: string) => void = () => {},
): Promise<LegacyClient> {
  let conn = await connectLegacyDb(extra);

  async function reconnect(): Promise<void> {
    try {
      await conn.end();
    } catch {
      /* already dead */
    }
    conn = await connectLegacyDb(extra);
  }

  return {
    async query<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, values?: unknown) {
      let attempt = 0;
      for (;;) {
        try {
          return (await conn.query(sql, values as never)) as [T, FieldPacket[]];
        } catch (err) {
          if (!isConnectionError(err) || attempt >= retries) throw err;
          attempt += 1;
          const backoff = Math.min(1000 * 2 ** (attempt - 1), 30_000);
          log(`legacy connection lost (${(err as any)?.code ?? 'unknown'}) — reconnect attempt ${attempt}/${retries} in ${backoff}ms`);
          await sleep(backoff);
          await reconnect();
        }
      }
    },
    async end() {
      try {
        await conn.end();
      } catch {
        /* already closed */
      }
    },
  };
}
