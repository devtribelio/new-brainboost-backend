/**
 * NestJS-style OpenAPI metadata model.
 * The `@nestjs/swagger` package is too tightly coupled to Nest's DI; this
 * is a minimal homegrown equivalent that consumes class-validator DTOs and
 * emits OpenAPI 3.0 JSON without taking on the Nest runtime.
 */

import 'reflect-metadata';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface PropertyOptions {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | (() => unknown);
  format?: string;
  description?: string;
  example?: unknown;
  required?: boolean;
  nullable?: boolean;
  enum?: readonly (string | number)[];
  itemType?: 'string' | 'number' | 'integer' | 'boolean' | (() => unknown);
}

export interface ApiOperationOptions {
  summary?: string;
  description?: string;
  deprecated?: boolean;
}

export interface ApiResponseOptions {
  status: number;
  description?: string;
  type?: () => unknown;
  isArray?: boolean;
  schema?: Record<string, unknown>;
}

export interface ApiQueryOptions {
  name: string;
  type?: 'string' | 'number' | 'integer' | 'boolean';
  required?: boolean;
  description?: string;
  example?: unknown;
}

export interface ApiBodyOptions {
  type: () => unknown;
  description?: string;
  isArray?: boolean;
}

export interface ApiBearerAuthOptions {
  name?: string;
}

export interface RouteMetadata {
  controller: new (...args: unknown[]) => unknown;
  methodKey: string;
  httpMethod: HttpMethod;
  path: string;
  tags?: string[];
  operation?: ApiOperationOptions;
  responses?: ApiResponseOptions[];
  query?: ApiQueryOptions[];
  body?: ApiBodyOptions;
  bearerAuth?: boolean;
}

export const OPENAPI_KEYS = {
  PROPERTIES: Symbol('openapi:properties'),
  TAGS: Symbol('openapi:tags'),
  OPERATION: Symbol('openapi:operation'),
  RESPONSES: Symbol('openapi:responses'),
  QUERIES: Symbol('openapi:queries'),
  BODY: Symbol('openapi:body'),
  BEARER: Symbol('openapi:bearer'),
} as const;

/**
 * Marker property key. Middleware functions that read `Authorization: Bearer …`
 * tag themselves with this so `bindRoute` can auto-emit
 * `security: [{ bearerAuth: [] }]` on the OpenAPI operation without needing a
 * separate `@ApiBearerAuth()` decorator on the controller method.
 */
export const REQUIRES_BEARER_AUTH = Symbol('openapi:requires-bearer-auth');
