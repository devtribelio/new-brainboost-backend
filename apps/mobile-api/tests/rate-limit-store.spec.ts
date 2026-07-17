import { describe, it, expect } from 'vitest';
import type { Store, IncrementResponse } from 'express-rate-limit';
import { FailOpenStore } from '@bb/common/middlewares/rate-limit.middleware';

// The shared Redis store must never take the API down: if Redis is unreachable,
// the limiter has to fail OPEN (allow the request) rather than 500 the endpoint.
function fakeStore(overrides: Partial<Store>): Store {
  return {
    init() {},
    increment: async (): Promise<IncrementResponse> => ({ totalHits: 1, resetTime: undefined }),
    decrement: async () => {},
    resetKey: async () => {},
    ...overrides,
  } as Store;
}

describe('FailOpenStore', () => {
  it('passes through the inner result when Redis is healthy', async () => {
    const store = new FailOpenStore(
      fakeStore({ increment: async () => ({ totalHits: 7, resetTime: undefined }) }),
    );
    expect((await store.increment('k')).totalHits).toBe(7);
  });

  it('returns totalHits:0 (allow) when the inner increment throws', async () => {
    const store = new FailOpenStore(
      fakeStore({
        increment: async () => {
          throw new Error('redis down');
        },
      }),
    );
    expect((await store.increment('k')).totalHits).toBe(0);
  });

  it('swallows decrement/resetKey errors so an outage never propagates', async () => {
    const store = new FailOpenStore(
      fakeStore({
        decrement: async () => {
          throw new Error('redis down');
        },
        resetKey: async () => {
          throw new Error('redis down');
        },
      }),
    );
    await expect(store.decrement('k')).resolves.toBeUndefined();
    await expect(store.resetKey('k')).resolves.toBeUndefined();
  });
});
