import type { Router, RequestHandler } from 'express';
import { asyncHandler } from '@/common/utils/async-handler';
import { registerRoute } from './registry';
import type { HttpMethod } from './types';

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
  const handlers = [...(opts.middlewares ?? []), wrapped];
  opts.router[opts.method](opts.path, ...handlers);

  registerRoute({
    controller: opts.controller.constructor as new (...args: unknown[]) => unknown,
    methodKey: opts.handlerKey,
    httpMethod: opts.method,
    path: opts.path,
    tags: opts.tags,
  });
}
