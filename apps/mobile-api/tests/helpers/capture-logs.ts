import { logger } from '@bb/common/config/logger';

export interface CapturedLine {
  msg: string;
  level: number;
  [key: string]: unknown;
}

/**
 * Point the shared pino logger at an in-memory sink and return the collected
 * lines. The logger is a singleton (that is the point — service logs go through
 * it), so intercepting its destination is the only way to assert on real output.
 *
 * pino keeps the destination on a private, non-registered symbol, so it is looked
 * up by description. A pino upgrade that renames it throws here rather than
 * silently capturing nothing.
 */
export function captureLogs(): CapturedLine[] {
  const captured: CapturedLine[] = [];
  const sink = {
    write(chunk: string) {
      for (const raw of chunk.split('\n')) {
        if (!raw.trim()) continue;
        try {
          captured.push(JSON.parse(raw) as CapturedLine);
        } catch {
          // pino-pretty output in dev mode — not parseable, ignore.
        }
      }
    },
  };

  const streamSym = Object.getOwnPropertySymbols(logger).find(
    (s) => s.description === 'pino.stream',
  );
  if (!streamSym) throw new Error('pino stream symbol not found — pino internals changed');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (logger as any)[streamSym] = sink;

  return captured;
}
