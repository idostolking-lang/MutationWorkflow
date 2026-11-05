import { z } from 'zod';

/**
 * An adapter-specific action. The `type` selects an entry in the adapter's action
 * vocabulary (for example `click` or `fill` for web, `write` for terminals); every other
 * field is a parameter of that action and is validated by the adapter.
 */
export const ActionSchema = z
  .looseObject({
    type: z.string().min(1).describe('Action type from the adapter vocabulary'),
  })
  .describe('An adapter-specific action; fields other than "type" are its parameters');
export type Action = z.infer<typeof ActionSchema>;

/**
 * An adapter-specific check about the observable state of the application. Like actions,
 * the vocabulary belongs to the adapter; the engine only records whether it passed.
 */
export const AssertionSchema = z
  .looseObject({
    type: z.string().min(1).describe('Assertion type from the adapter vocabulary'),
    description: z.string().optional().describe('What this assertion verifies, in user terms'),
  })
  .describe('An adapter-specific assertion; fields other than "type" are its parameters');
export type Assertion = z.infer<typeof AssertionSchema>;
