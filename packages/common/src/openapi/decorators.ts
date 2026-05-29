import 'reflect-metadata';
import {
  OPENAPI_KEYS,
  type ApiBodyOptions,
  type ApiOperationOptions,
  type ApiQueryOptions,
  type ApiResponseOptions,
  type PropertyOptions,
} from './types';

/**
 * Property decorator for DTO classes — analogue of NestJS `@ApiProperty()`.
 * Stores schema hints used by the OpenAPI builder.
 */
export function ApiProperty(options: PropertyOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const map: Record<string, PropertyOptions> =
      Reflect.getMetadata(OPENAPI_KEYS.PROPERTIES, ctor) ?? {};
    map[propertyKey as string] = { required: true, ...options };
    Reflect.defineMetadata(OPENAPI_KEYS.PROPERTIES, map, ctor);
  };
}

export function ApiPropertyOptional(options: PropertyOptions = {}): PropertyDecorator {
  return ApiProperty({ ...options, required: false });
}

/** Class decorator — tags applied to every operation in the controller. */
export function ApiTags(...tags: string[]): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(OPENAPI_KEYS.TAGS, tags, target);
  };
}

/**
 * Note on decorator typing: controller handlers in this codebase are class
 * fields (`list = async (req, res) => ...`) which TypeScript treats as
 * property decorators (2-arg). To keep decorator usage uniform with NestJS
 * style — `@ApiOperation`, `@ApiResponse`, ... — we declare these as
 * `PropertyDecorator`. Same metadata model works either way.
 */

/** Method/property decorator — operation summary/description. */
export function ApiOperation(options: ApiOperationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const map: Record<string, ApiOperationOptions> =
      Reflect.getMetadata(OPENAPI_KEYS.OPERATION, ctor) ?? {};
    map[propertyKey as string] = options;
    Reflect.defineMetadata(OPENAPI_KEYS.OPERATION, map, ctor);
  };
}

/** Method/property decorator — multiple invocations stack into a list. */
export function ApiResponse(options: ApiResponseOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const map: Record<string, ApiResponseOptions[]> =
      Reflect.getMetadata(OPENAPI_KEYS.RESPONSES, ctor) ?? {};
    const list = map[propertyKey as string] ?? [];
    list.push(options);
    map[propertyKey as string] = list;
    Reflect.defineMetadata(OPENAPI_KEYS.RESPONSES, map, ctor);
  };
}

/** Method/property decorator — multiple invocations stack. */
export function ApiQuery(options: ApiQueryOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const map: Record<string, ApiQueryOptions[]> =
      Reflect.getMetadata(OPENAPI_KEYS.QUERIES, ctor) ?? {};
    const list = map[propertyKey as string] ?? [];
    list.push(options);
    map[propertyKey as string] = list;
    Reflect.defineMetadata(OPENAPI_KEYS.QUERIES, map, ctor);
  };
}

/** Method/property decorator — request body schema. */
export function ApiBody(options: ApiBodyOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const ctor = (target as { constructor: object }).constructor;
    const map: Record<string, ApiBodyOptions> =
      Reflect.getMetadata(OPENAPI_KEYS.BODY, ctor) ?? {};
    map[propertyKey as string] = options;
    Reflect.defineMetadata(OPENAPI_KEYS.BODY, map, ctor);
  };
}

/** Marks an operation as bearer-auth-protected. Class- or method/property-level. */
export function ApiBearerAuth(): PropertyDecorator & ClassDecorator {
  return ((target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      const ctor = (target as { constructor: object }).constructor;
      const map: Record<string, boolean> =
        Reflect.getMetadata(OPENAPI_KEYS.BEARER, ctor) ?? {};
      map[propertyKey as string] = true;
      Reflect.defineMetadata(OPENAPI_KEYS.BEARER, map, ctor);
    } else {
      Reflect.defineMetadata(OPENAPI_KEYS.BEARER, '__class__', target);
    }
  }) as PropertyDecorator & ClassDecorator;
}
