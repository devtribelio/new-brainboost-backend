import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logger } from '@bb/common/config/logger';
import { traceService } from '@bb/common/utils/trace-service';
import { captureLogs, type CapturedLine } from './helpers/capture-logs';

class Boom extends Error {
  constructor() {
    super('boom');
    this.name = 'Boom';
  }
}

class Sample {
  // Private field: proves the proxy resolves getters against the real instance.
  readonly #secretDepth = 42;
  readonly plain = 'not-a-function';

  get depth(): number {
    return this.#secretDepth;
  }

  async fetchThing(id: string): Promise<string> {
    return `thing-${id}`;
  }

  syncThing(): number {
    return 7;
  }

  async explodes(): Promise<never> {
    throw new Boom();
  }

  throwsSync(): never {
    throw new Boom();
  }

  outer(): string {
    // Self-call: must NOT produce its own span (see traceService docblock).
    return this.inner();
  }

  inner(): string {
    return 'inner';
  }
}

let captured: CapturedLine[];
const originalLevel = logger.level;

function calls(): CapturedLine[] {
  return captured.filter((l) => l.msg === 'service.call');
}

beforeAll(() => {
  captured = captureLogs();
  logger.level = 'debug';
});

afterAll(() => {
  logger.level = originalLevel;
});

describe('traceService', () => {
  it('logs one span per async call with service, method, duration and outcome', async () => {
    const svc = traceService(new Sample());
    await expect(svc.fetchThing('x')).resolves.toBe('thing-x');

    const line = calls().find((l) => l.method === 'fetchThing');
    expect(line).toMatchObject({ service: 'Sample', method: 'fetchThing', outcome: 'ok' });
    expect(typeof line?.durationMs).toBe('number');
    expect(line?.level).toBe(20); // debug
  });

  it('waits for the promise before timing it', async () => {
    class Slow {
      async work(): Promise<void> {
        await new Promise((r) => setTimeout(r, 40));
      }
    }
    await traceService(new Slow()).work();

    const line = calls().find((l) => l.method === 'work');
    // Would be ~0 if the span closed on the returned promise instead of its result.
    expect(line?.durationMs as number).toBeGreaterThanOrEqual(35);
  });

  it('records a rejected promise as an error and rethrows it unchanged', async () => {
    const svc = traceService(new Sample());
    await expect(svc.explodes()).rejects.toThrow(Boom);

    const line = calls().find((l) => l.method === 'explodes');
    expect(line).toMatchObject({ outcome: 'error', error: 'Boom' });
  });

  it('records a synchronous throw and rethrows it unchanged', () => {
    const svc = traceService(new Sample());
    expect(() => svc.throwsSync()).toThrow(Boom);

    const line = calls().find((l) => l.method === 'throwsSync');
    expect(line).toMatchObject({ outcome: 'error', error: 'Boom' });
  });

  it('handles synchronous return values', () => {
    expect(traceService(new Sample()).syncThing()).toBe(7);
    expect(calls().find((l) => l.method === 'syncThing')?.outcome).toBe('ok');
  });

  it('does not trace self-calls — only the entry point gets a span', () => {
    const before = calls().length;
    expect(traceService(new Sample()).outer()).toBe('inner');
    const added = calls().slice(before);
    // Double-counting the same wall clock would bury the real entry point.
    expect(added.map((l) => l.method)).toEqual(['outer']);
  });

  it('passes non-function properties and getters through untouched', () => {
    const svc = traceService(new Sample());
    expect(svc.plain).toBe('not-a-function');
    // Resolving the getter against the proxy would throw on the #private field.
    expect(svc.depth).toBe(42);
  });

  it('returns the same wrapper for repeated access to a method', () => {
    const svc = traceService(new Sample());
    expect(svc.fetchThing).toBe(svc.fetchThing);
  });

  it('is idempotent — wrapping a wrapped instance returns it unchanged', () => {
    const once = traceService(new Sample());
    expect(traceService(once)).toBe(once);
  });

  it('uses an explicit label when given one', async () => {
    await traceService(new Sample(), 'CustomLabel').fetchThing('y');
    expect(calls().some((l) => l.service === 'CustomLabel')).toBe(true);
  });

  it('emits nothing when the level is above debug', async () => {
    logger.level = 'info';
    const before = calls().length;
    await traceService(new Sample()).fetchThing('quiet');
    expect(calls().length).toBe(before);
    logger.level = 'debug';
  });
});
