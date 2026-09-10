import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { OPENAPI_KEYS, type PropertyOptions } from './types';

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

function toJsonSchemaType(type: PropertyOptions['type']): {
  schema: JsonSchema;
  refName?: string;
} {
  if (typeof type === 'function') {
    const ref = (type as () => unknown)();
    // `() => [Dto]` is the NestJS way to spell an array of DTOs, and it is what
    // every nested list in the event module uses. Unwrapped here rather than left
    // unhandled: the factory returns an ARRAY, not a function, so it used to fall
    // through every branch below and emit `{ type: 'string' }` — documenting
    // `attendees`, both `tickets` arrays, `items` and `ticketTypes` as strings,
    // with nothing anywhere to say so.
    const target = Array.isArray(ref) ? ref[0] : ref;
    if (typeof target === 'function') {
      const name = (target as { name: string }).name;
      const itemSchema = { $ref: `#/components/schemas/${name}` };
      return {
        schema: Array.isArray(ref) ? { type: 'array', items: itemSchema } : itemSchema,
        refName: name,
      };
    }
  }
  if (type === 'integer') return { schema: { type: 'integer' } };
  if (type === 'number') return { schema: { type: 'number' } };
  if (type === 'boolean') return { schema: { type: 'boolean' } };
  if (type === 'array') return { schema: { type: 'array', items: { type: 'string' } } };
  if (type === 'object') return { schema: { type: 'object' } };
  return { schema: { type: 'string' } };
}

function buildPropertySchema(opts: PropertyOptions): { schema: JsonSchema; nestedRef?: string } {
  if (opts.type === 'array') {
    if (opts.itemType) {
      const item = toJsonSchemaType(opts.itemType);
      return {
        schema: {
          type: 'array',
          items: item.schema,
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.example !== undefined ? { example: opts.example } : {}),
        },
        nestedRef: item.refName,
      };
    }
    return {
      schema: {
        type: 'array',
        items: { type: 'string' },
        ...(opts.description ? { description: opts.description } : {}),
      },
    };
  }
  const { schema, refName } = toJsonSchemaType(opts.type);
  if (opts.format) schema.format = opts.format;
  if (opts.description) schema.description = opts.description;
  if (opts.example !== undefined) schema.example = opts.example;
  if (opts.enum) schema.enum = opts.enum;
  if (opts.nullable) schema.nullable = true;
  return { schema, nestedRef: refName };
}

/**
 * Convert a class decorated with `@ApiProperty` to an OpenAPI schema.
 * Class-validator-jsonschema would handle this too, but we want a
 * dependency-light path that respects our `@ApiProperty` overrides first
 * and falls back to `class-validator` decorators only when the explicit
 * type is missing.
 */
export function dtoToSchema(
  ctor: { new (): unknown; name: string },
  collected: Map<string, JsonSchema>,
): JsonSchema {
  const cached = collected.get(ctor.name);
  if (cached) return cached;

  const props: Record<string, PropertyOptions> =
    Reflect.getMetadata(OPENAPI_KEYS.PROPERTIES, ctor) ?? {};
  const schema: JsonSchema = { type: 'object', properties: {}, required: [] };
  // Reserve slot to break recursion through nested refs
  collected.set(ctor.name, schema);

  // Best-effort discover validation rules — runs validateSync on instance to
  // surface required-vs-optional from class-validator decorators when the user
  // didn't pass `required` to @ApiProperty.
  let inferredRequired: Set<string> | undefined;
  try {
    const instance = new ctor() as Record<string, unknown>;
    const errors = validateSync(instance as object, { skipMissingProperties: false });
    inferredRequired = new Set(
      errors.filter((e) => e.constraints && Object.keys(e.constraints).length > 0).map((e) => e.property),
    );
  } catch {
    inferredRequired = undefined;
  }

  for (const [propName, opts] of Object.entries(props)) {
    const { schema: propSchema, nestedRef } = buildPropertySchema(opts);
    if (nestedRef) {
      const nestedFactory =
        typeof opts.type === 'function'
          ? (opts.type as () => unknown)
          : typeof opts.itemType === 'function'
            ? (opts.itemType as () => unknown)
            : undefined;
      if (nestedFactory) {
        const nested = nestedFactory();
        // Same unwrap as `toJsonSchemaType`: without it the `$ref` it emitted for
        // an array would point at a component that was never registered.
        const target = Array.isArray(nested) ? nested[0] : nested;
        if (typeof target === 'function') {
          dtoToSchema(target as { new (): unknown; name: string }, collected);
        }
      }
    }
    schema.properties![propName] = propSchema;
    const isRequired =
      opts.required === true ||
      (opts.required === undefined && inferredRequired?.has(propName));
    if (isRequired) schema.required!.push(propName);
  }

  if (schema.required && schema.required.length === 0) delete schema.required;
  return schema;
}
