import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { logger } from '@bb/common/config/logger';
import {
  getRequestId,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from '@bb/common/config/request-context';
import { notificationEvents } from '@bb/common/events/notification-events';
import { captureLogs, type CapturedLine } from './helpers/capture-logs';

// Maps out exactly HOW FAR the request context reaches, so the boundaries are
// asserted rather than assumed. See docs/logging.md §4b.

let captured: CapturedLine[];

function ctx(requestId: string): RequestContext {
  return { requestId, method: 'POST', path: '/t', startedAt: performance.now() };
}

function lines(msg: string): CapturedLine[] {
  return captured.filter((l) => l.msg === msg);
}

beforeAll(() => {
  captured = captureLogs();
});

describe('request context propagation', () => {
  it('is readable as a VALUE inside a service, not just in log lines', () => {
    // What a service does when it must pass the id to an outbound call / queue
    // message: import getRequestId() — no plumbing through constructors.
    runWithRequestContext(ctx('ctx-value-1'), () => {
      expect(getRequestId()).toBe('ctx-value-1');
      expect(getRequestContext()?.method).toBe('POST');
    });
  });

  it('survives awaits, so it reaches a service several hops deep', async () => {
    async function inner() {
      await new Promise((r) => setTimeout(r, 5));
      return getRequestId();
    }
    async function outer() {
      await new Promise((r) => setTimeout(r, 5));
      return inner();
    }

    const seen = await runWithRequestContext(ctx('ctx-deep-1'), () => outer());
    expect(seen).toBe('ctx-deep-1');
  });

  it('reaches a domain event listener — emit() is synchronous', async () => {
    const seen: (string | undefined)[] = [];
    notificationEvents.on('post.published', async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(getRequestId());
    });

    runWithRequestContext(ctx('ctx-listener-1'), () => {
      notificationEvents.emit('post.published', {
        postId: 'p1',
        authorId: 'a1',
        topicId: null,
        networkId: null,
        excerpt: 'x',
      });
    });
    await new Promise((r) => setTimeout(r, 20));

    // Listeners are registered at boot but INVOKED from emit(), i.e. in the
    // caller's async context — so a listener firing during a request inherits it.
    expect(seen).toContain('ctx-listener-1');
  });

  it('logs a listener failure through pino WITH the requestId', async () => {
    notificationEvents.on('post.published', async () => {
      throw new Error('listener-kaboom');
    });

    runWithRequestContext(ctx('ctx-listener-err'), () => {
      notificationEvents.emit('post.published', {
        postId: 'p2',
        authorId: 'a2',
        topicId: null,
        networkId: null,
        excerpt: 'y',
      });
    });
    await new Promise((r) => setTimeout(r, 20));

    // Regression guard: this used to be console.error, which bypassed pino and
    // therefore lost the correlation id entirely.
    const line = lines('notification-events listener threw').find(
      (l) => l.requestId === 'ctx-listener-err',
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe(50);
  });

  it('does NOT leak between concurrent requests', async () => {
    const [a, b] = await Promise.all([
      runWithRequestContext(ctx('ctx-race-a'), async () => {
        await new Promise((r) => setTimeout(r, 15));
        return getRequestId();
      }),
      runWithRequestContext(ctx('ctx-race-b'), async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestId();
      }),
    ]);
    expect([a, b]).toEqual(['ctx-race-a', 'ctx-race-b']);
  });

  it('is absent outside a request — workers/cron/scripts add no fields', () => {
    expect(getRequestId()).toBeUndefined();
    logger.info('outside.context.probe');
    expect(lines('outside.context.probe')[0]?.requestId).toBeUndefined();
  });
});
