import { describe, expect, it } from 'vitest';
import { FINAL_RESULT_SCHEMA } from '../src/scenario.js';

function assertStrictObjectSchema(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object') throw new Error(`${path} is not a schema object`);
  const value = schema as { type?: string; properties?: Record<string, unknown>; required?: readonly string[] };
  expect(value.type, `${path} must declare a type`).toBeTypeOf('string');
  if (value.type !== 'object' || !value.properties) return;
  expect(new Set(value.required), `${path} must require every declared property`).toEqual(new Set(Object.keys(value.properties)));
  for (const [name, property] of Object.entries(value.properties)) assertStrictObjectSchema(property, `${path}.${name}`);
}

describe('structured final-result schema', () => {
  it('uses the strict JSON Schema shape required by Responses structured outputs', () => {
    assertStrictObjectSchema(FINAL_RESULT_SCHEMA);
  });
});
