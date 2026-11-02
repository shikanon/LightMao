import { Type } from 'typebox';
import { Value } from 'typebox/value';
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/client';

const fail = (): never => {
  throw new Error(
    '插件参数结构超出支持范围：只接受有界的基本 JSON Schema，不执行正则、引用或自定义代码',
  );
};
const keyAllowed = (key: string) =>
  /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key) &&
  !['__proto__', 'constructor', 'prototype'].includes(key);

// Untrusted schemas never reach a code generator or a regular-expression engine.
export function safeMcpSchema(input: unknown) {
  if (JSON.stringify(input).length > 48000) fail();
  let nodes = 0;
  function visit(value: unknown, depth: number): Record<string, unknown> {
    if (++nodes > 500 || depth > 8 || !value || typeof value !== 'object' || Array.isArray(value))
      return fail();
    const source = value as Record<string, unknown>;
    const allowed = [
      'type',
      'description',
      'title',
      'properties',
      'required',
      'additionalProperties',
      'items',
      'enum',
      'const',
      'anyOf',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'default',
      '$schema',
    ];
    if (Object.keys(source).some((key) => !allowed.includes(key))) fail();
    const result: Record<string, unknown> = {};
    if (source.type !== undefined) {
      if (
        !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
          source.type as string,
        )
      )
        fail();
      result.type = source.type;
    }
    if (source.description !== undefined) {
      if (typeof source.description !== 'string') fail();
      result.description = (source.description as string).slice(0, 1000);
    }
    if (source.anyOf !== undefined) {
      if (!Array.isArray(source.anyOf) || source.anyOf.length < 1 || source.anyOf.length > 8)
        fail();
      result.anyOf = (source.anyOf as unknown[]).map((part) => visit(part, depth + 1));
    }
    if (source.properties !== undefined) {
      if (
        !source.properties ||
        typeof source.properties !== 'object' ||
        Array.isArray(source.properties)
      )
        fail();
      const entries = Object.entries(source.properties as Record<string, unknown>);
      if (entries.length > 50 || entries.some(([key]) => !keyAllowed(key))) fail();
      result.properties = Object.fromEntries(
        entries.map(([key, part]) => [key, visit(part, depth + 1)]),
      );
    }
    if (source.required !== undefined) {
      if (
        !Array.isArray(source.required) ||
        source.required.length > 50 ||
        source.required.some(
          (key) => typeof key !== 'string' || !Object.hasOwn(result.properties || {}, key),
        )
      )
        fail();
      result.required = source.required;
    }
    if (
      source.additionalProperties !== undefined &&
      typeof source.additionalProperties !== 'boolean'
    )
      fail();
    if (source.type === 'object')
      result.additionalProperties = source.additionalProperties === true;
    if (source.items !== undefined) result.items = visit(source.items, depth + 1);
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (source[key] === undefined) continue;
      if (
        typeof source[key] !== 'number' ||
        !Number.isFinite(source[key]) ||
        Math.abs(source[key] as number) > 1e12
      )
        fail();
      result[key] = source[key];
    }
    if (source.type === 'string')
      result.maxLength = Math.min((source.maxLength as number | undefined) ?? 128000, 128000);
    if (source.type === 'array')
      result.maxItems = Math.min((source.maxItems as number | undefined) ?? 1000, 1000);
    for (const key of ['enum', 'const']) {
      if (source[key] === undefined) continue;
      const values = key === 'enum' ? source[key] : [source[key]];
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 50 ||
        values.some((v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v)) ||
        JSON.stringify(values).length > 4000
      )
        fail();
      result[key] = source[key];
    }
    return result;
  }
  return Type.Unsafe(visit(input, 0)) as ReturnType<typeof Type.Unsafe> & Record<string, unknown>;
}
export const mcpValidator: jsonSchemaValidator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const safe = safeMcpSchema(schema);
    return (input: unknown) =>
      Value.Check(safe, input)
        ? { valid: true, data: input as T, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: '插件返回数据不符合已声明的结构' };
  },
};
