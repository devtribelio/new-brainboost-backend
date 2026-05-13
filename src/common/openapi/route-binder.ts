import type { Router, RequestHandler } from 'express';
import { asyncHandler } from '@/common/utils/async-handler';
import { registerRoute } from './registry';
import { REQUIRES_BEARER_AUTH, type HttpMethod } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BindOptions {
  router: Router;
  controller: { constructor: { name: string } };
  method: HttpMethod;
  path: string;
  handlerKey: string;
  middlewares?: RequestHandler[];
  tags?: string[];
}

/**
 * Bind a controller method to an Express router AND register OpenAPI metadata
 * keyed by `(controller class, methodKey)`. Replaces direct `router.METHOD()`
 * calls so we never have to maintain two sources of truth for paths.
 */
export function bindRoute(opts: BindOptions): void {
  const handlerFn = (opts.controller as Record<string, unknown>)[opts.handlerKey];
  if (typeof handlerFn !== 'function') {
    throw new Error(
      `bindRoute: ${opts.controller.constructor.name}.${opts.handlerKey} is not a function`,
    );
  }
  const wrapped = asyncHandler(handlerFn.bind(opts.controller) as any);
  const middlewares = opts.middlewares ?? [];
  const handlers = [...middlewares, wrapped];
  opts.router[opts.method](opts.path, ...handlers);

  const bearerAuth = middlewares.some(
    (m) => (m as unknown as Record<symbol, unknown>)[REQUIRES_BEARER_AUTH] === true,
  );

  registerRoute({
    controller: opts.controller.constructor as new (...args: unknown[]) => unknown,
    methodKey: opts.handlerKey,
    httpMethod: opts.method,
    path: opts.path,
    tags: opts.tags,
    bearerAuth: bearerAuth || undefined,
  });
}
