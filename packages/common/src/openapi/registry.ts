import type { RouteMetadata } from './types';

/**
 * Process-wide registry. `bindRoute` is called from each module's routes file
 * alongside the Express binding so we have a single source of truth for
 * controller -> HTTP method/path mapping.
 */
const ROUTES: RouteMetadata[] = [];
const SCHEMAS = new Set<unknown>();
let currentPrefix = '';

export function registerRoute(meta: RouteMetadata): void {
  // Capture the prefix in effect when this route was bound so the OpenAPI
  // builder can join `(prefix, path)` later.
  ROUTES.push({ ...meta, path: currentPrefix + meta.path });
}

export function registerSchema(ctor: unknown): void {
  SCHEMAS.add(ctor);
}

/**
 * Used by the module loader to scope subsequent `bindRoute` calls under a
 * mount prefix (e.g. `/member`). Restored to '' after the module's
 * `routes()` returns.
 */
export function withModulePrefix<T>(prefix: string, fn: () => T): T {
  const previous = currentPrefix;
  currentPrefix = previous + prefix;
  try {
    return fn();
  } finally {
    currentPrefix = previous;
  }
}

export function getRoutes(): readonly RouteMetadata[] {
  return ROUTES;
}

export function getSchemas(): readonly unknown[] {
  return [...SCHEMAS];
}

export function clearRegistry(): void {
  ROUTES.length = 0;
  SCHEMAS.clear();
}
