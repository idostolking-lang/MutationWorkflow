import { MutationWorkflowError } from '@mutationworkflow/core';
import { z } from 'zod';

type Schemas = Record<string, z.ZodType>;

/**
 * Validate `value` against the schema registered for its `type`.
 * @throws MutationWorkflowError `INVALID_INPUT` for unknown types or invalid fields.
 */
export function parseByType<S extends Schemas>(
  schemas: S,
  noun: string,
  value: { type: string },
): z.output<S[keyof S]> {
  const schema = Object.hasOwn(schemas, value.type) ? schemas[value.type] : undefined;
  if (!schema) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `Unknown cli ${noun} "${value.type}"; expected one of: ${Object.keys(schemas).join(', ')}`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MutationWorkflowError(
      'INVALID_INPUT',
      `Invalid cli ${noun} "${value.type}":\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data as z.output<S[keyof S]>;
}

export interface VocabularySpec<E> {
  type: string;
  description: string;
  schema: Record<string, unknown>;
  example: E;
}

/** Action or assertion specs for `describe()`, with JSON Schemas generated from the zod schemas. */
export function specsOf<S extends Schemas, E>(
  schemas: S,
  examples: Record<keyof S, E>,
): VocabularySpec<E>[] {
  return Object.entries(schemas).map(([type, schema]) => ({
    type,
    description: schema.description ?? type,
    schema: z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>,
    example: examples[type as keyof S],
  }));
}
