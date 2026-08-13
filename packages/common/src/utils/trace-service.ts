import { logger } from '@bb/common/config/logger';

const TRACED = Symbol('bb.traced');

/**
 * Wrap a service instance so every method call it receives is timed and logged.
 *
 * Why this exists: the pino mixin already correlates whatever a service chooses
 * to log (see config/request-context.ts), but a service method that logs nothing
 * is invisible — there was no way to see "which service call ate the 800ms".
 * `db.op` covers the DB hop; this covers everything else (external HTTP to
 * Xendit/Didit/Bunny/FCM, sharp image work, in-process computation).
 *
 * Emits one `service.call` line per invocation at **debug**, with `service`,
 * `method`, `durationMs` and `outcome` (`ok` / `error`, plus the error name).
 * Arguments are NEVER logged — they are full of emails, phones and tokens, and
 * a service signature is not a structure pino's redact can reason about.
 *
 * Applied at the route boundary (`*.routes.ts`), so the traced call is the one
 * the controller makes. Calls a service makes to ITSELF are not traced: methods
 * run with the raw instance as `this`, deliberately — self-calls would otherwise
 * double-count the same wall clock and bury the real entry point.
 *
 * Usage: `new FooController(traceService(new FooService()))`.
 */
export function traceService<T extends object>(instance: T, name?: string): T {
  if ((instance as Record<symbol, unknown>)[TRACED]) return instance;
  const label = name ?? instance.constructor?.name ?? 'Service';
  // Wrappers are memoised: a `get` on the same method must return the same
  // function, or code that compares or unbinds handlers would misbehave.
  const wrappers = new Map<string, unknown>();

  return new Proxy(instance, {
    get(target, prop) {
      if (prop === TRACED) return true;
      // `target` (not the proxy) as receiver: a getter that touches a private
      // field would throw if `this` were the proxy.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;

      const cached = wrappers.get(prop);
      if (cached) return cached;

      const wrapper = function traced(...args: unknown[]) {
        // Zero-cost when the level is off: no timer, no closure work, no line.
        if (!logger.isLevelEnabled('debug')) {
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        const startedAt = performance.now();
        const done = (outcome: 'ok' | 'error', err?: unknown) => {
          logger.debug(
            {
              service: label,
              method: prop,
              durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
              outcome,
              ...(err ? { error: errorName(err) } : {}),
            },
            'service.call',
          );
        };

        try {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (isPromiseLike(result)) {
            return result.then(
              (resolved) => {
                done('ok');
                return resolved;
              },
              (err: unknown) => {
                done('error', err);
                throw err;
              },
            );
          }
          done('ok');
          return result;
        } catch (err) {
          done('error', err);
          throw err;
        }
      };

      wrappers.set(prop, wrapper);
      return wrapper;
    },
  });
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

// The error's CLASS, not its message: the class is the signal ("NotFoundException"
// vs "PrismaClientKnownRequestError") while the message can carry user input.
// errorHandler already logs the full error for anything unexpected.
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}
