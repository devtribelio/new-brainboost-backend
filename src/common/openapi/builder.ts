import 'reflect-metadata';
import {
  OPENAPI_KEYS,
  type ApiBodyOptions,
  type ApiOperationOptions,
  type ApiQueryOptions,
  type ApiResponseOptions,
  type RouteMetadata,
} from './types';
import { dtoToSchema } from './dto-to-schema';
import { getRoutes, getSchemas } from './registry';
import { ApiErrorDto, PaginationMetaDto } from './common.dto';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface JsonSchema {
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  nullable?: boolean;
  enum?: readonly (string | number)[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
}

interface OpenApiInfo {
  title: string;
  description?: string;
  version: string;
}

interface OpenApiServer {
  url: string;
  description?: string;
}

export interface BuildOpenApiOptions {
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  pathPrefix?: string;
}

function controllerTags(ctor: object): string[] {
  return Reflect.getMetadata(OPENAPI_KEYS.TAGS, ctor) ?? [];
}

function methodMeta<T>(ctor: object, key: symbol, methodKey: string): T | undefined {
  const map = Reflect.getMetadata(key, ctor);
  return map?.[methodKey];
}

function classBearer(ctor: object): boolean {
  const v = Reflect.getMetadata(OPENAPI_KEYS.BEARER, ctor);
  return v === '__class__';
}

function pathToOpenApi(p: string): string {
  // Express :id -> OpenAPI {id}
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationFromRoute(
  route: RouteMetadata,
  schemas: Map<string, JsonSchema>,
  collectedDtos: Set<unknown>,
): { path: string; method: string; spec: Record<string, unknown> } {
  const ctor = route.controller as unknown as object;
  const tags = route.tags ?? controllerTags(ctor);
  const op = methodMeta<ApiOperationOptions>(ctor, OPENAPI_KEYS.OPERATION, route.methodKey);
  const responses =
    methodMeta<ApiResponseOptions[]>(ctor, OPENAPI_KEYS.RESPONSES, route.methodKey) ?? [];
  const queries = methodMeta<ApiQueryOptions[]>(ctor, OPENAPI_KEYS.QUERIES, route.methodKey) ?? [];
  const body = methodMeta<ApiBodyOptions>(ctor, OPENAPI_KEYS.BODY, route.methodKey);
  const bearerMap: Record<string, boolean> | undefined = Reflect.getMetadata(
    OPENAPI_KEYS.BEARER,
    ctor,
  );
  const isBearer =
    classBearer(ctor) || bearerMap?.[route.methodKey] === true || route.bearerAuth === true;

  const spec: Record<string, unknown> = {
    tags,
    summary: op?.summary,
    description: op?.description,
    deprecated: op?.deprecated,
  };

  // Path params from `{}` segments
  const pathParams = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    in: 'path',
    name: m[1],
    required: true,
    schema: { type: 'string' },
  }));

  const queryParams = queries.map((q) => ({
    in: 'query',
    name: q.name,
    required: q.required ?? false,
    description: q.description,
    schema: { type: q.type ?? 'string' },
    ...(q.example !== undefined ? { example: q.example } : {}),
  }));

  if (pathParams.length || queryParams.length) {
    spec.parameters = [...pathParams, ...queryParams];
  }

  if (body) {
    const bodyCtor = body.type();
    if (typeof bodyCtor === 'function') {
      collectedDtos.add(bodyCtor);
      const ref = `#/components/schemas/${(bodyCtor as { name: string }).name}`;
      const refSchema: Record<string, unknown> = body.isArray
        ? { type: 'array', items: { $ref: ref } }
        : { $ref: ref };
      spec.requestBody = {
        required: true,
        description: body.description,
        content: { 'application/json': { schema: refSchema } },
      };
    }
  }

  const responsesSpec: Record<string, unknown> = {};
  for (const r of responses) {
    let schemaSpec: Record<string, unknown> | undefined;
    if (r.schema) {
      schemaSpec = r.schema;
    } else if (r.type) {
      const ctorRef = r.type();
      if (typeof ctorRef === 'function') {
        collectedDtos.add(ctorRef);
        const ref = `#/components/schemas/${(ctorRef as { name: string }).name}`;
        const envelope = r.envelope ?? 'standard';

        if (envelope === 'none') {
          schemaSpec = r.isArray ? { type: 'array', items: { $ref: ref } } : { $ref: ref };
        } else if (envelope === 'paginated') {
          schemaSpec = {
            type: 'object',
            required: ['success', 'data', 'meta', 'error'],
            properties: {
              success: { type: 'boolean', example: true },
              data: { type: 'array', items: { $ref: ref } },
              meta: {
                type: 'object',
                required: ['pagination'],
                properties: {
                  pagination: { $ref: '#/components/schemas/PaginationMetaDto' },
                },
              },
              error: { type: 'object', nullable: true, example: null },
            },
          };
        } else {
          const inner = r.isArray ? { type: 'array', items: { $ref: ref } } : { $ref: ref };
          schemaSpec = {
            type: 'object',
            required: ['success', 'data', 'meta', 'error'],
            properties: {
              success: { type: 'boolean', example: true },
              data: inner,
              meta: { type: 'object', nullable: true, example: null },
              error: { type: 'object', nullable: true, example: null },
            },
          };
        }
      }
    }
    responsesSpec[String(r.status)] = {
      description: r.description ?? '',
      ...(schemaSpec ? { content: { 'application/json': { schema: schemaSpec } } } : {}),
    };
  }
  if (Object.keys(responsesSpec).length === 0) {
    responsesSpec['200'] = { description: 'OK' };
  }
  spec.responses = responsesSpec;

  if (isBearer) {
    spec.security = [{ bearerAuth: [] }];
  }

  // Pre-collect schemas from discovered DTOs
  for (const ctor of collectedDtos) {
    if (typeof ctor === 'function') {
      dtoToSchema(ctor as { new (): unknown; name: string }, schemas as Map<string, JsonSchema>);
    }
  }

  return { path: pathToOpenApi(route.path), method: route.httpMethod, spec };
}

export function buildOpenApiDocument(options: BuildOpenApiOptions): Record<string, unknown> {
  const schemas = new Map<string, JsonSchema>();
  const collectedDtos = new Set<unknown>();

  // Always include envelope-shared DTOs so paginated/error references resolve.
  for (const ctor of [PaginationMetaDto, ApiErrorDto]) {
    collectedDtos.add(ctor);
    dtoToSchema(ctor as unknown as { new (): unknown; name: string }, schemas);
  }

  // Pre-register schemas from explicit registry calls
  for (const ctor of getSchemas()) {
    if (typeof ctor === 'function') {
      collectedDtos.add(ctor);
      dtoToSchema(ctor as { new (): unknown; name: string }, schemas);
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const prefix = options.pathPrefix ?? '';
  for (const route of getRoutes()) {
    const { path, method, spec } = operationFromRoute(route, schemas, collectedDtos);
    const fullPath = prefix + path;
    paths[fullPath] = paths[fullPath] ?? {};
    paths[fullPath][method] = spec;
  }

  // Final pass: ensure all collected DTOs (e.g. nested ones added during build)
  // are converted.
  for (const ctor of collectedDtos) {
    if (typeof ctor === 'function') {
      dtoToSchema(ctor as { new (): unknown; name: string }, schemas);
    }
  }

  return {
    openapi: '3.0.3',
    info: options.info,
    servers: options.servers ?? [{ url: '/' }],
    components: {
      schemas: Object.fromEntries(schemas),
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    paths,
    tags: collectTags(),
  };
}

function collectTags(): { name: string; description?: string }[] {
  const tagSet = new Set<string>();
  for (const route of getRoutes()) {
    const tags = route.tags ?? controllerTags(route.controller as unknown as object);
    for (const t of tags) tagSet.add(t);
  }
  return [...tagSet].map((name) => ({ name }));
}
