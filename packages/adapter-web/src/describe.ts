import type {
  Action,
  ActionSpec,
  AdapterDescription,
  Assertion,
  AssertionSpec,
} from '@mutationworkflow/core';
import { z } from 'zod';
import { ACTION_EXAMPLES, WebActionSchema } from './actions.js';
import { ASSERTION_EXAMPLES, WebAssertionSchema } from './assertions.js';

/** Prose for agents on using the web vocabulary. */
export const WEB_GUIDE = `Each session is a fresh browser tab that starts on about:blank, so begin with a navigate action; navigate accepts URLs relative to the base URL such as "/" or "/settings".
Observations are the page's ARIA snapshot: one line per element, indented by nesting, written as \`- role "accessible name"\` (for example \`- button "Add"\`, \`- textbox "New todo"\`, \`- listitem: Buy milk\`). Turn what you see directly into locators: \`{ "role": "button", "name": "Add" }\`. Prefer role+name, then label (form fields), then testId; use text for plain content and css only as a last resort, because css breaks when markup changes. Names match as case-insensitive substrings unless "exact" is true; when several elements match, add "nth" (zero-based) or a more specific name, otherwise the action is blocked as ambiguous.
An action outcome of "blocked" means the UI did not offer the action: the element was missing, hidden, disabled or ambiguous within the step timeout, or the scope forbids it. That is information about the application, not an adapter failure. "error" means the page crashed, the server was unreachable or the browser failed.
State assertions (url, title, text, element, value) retry until they hold or the step timeout passes, so assert on what the user should see after the action rather than adding waits.`;

/** Build the adapter description from the action and assertion schemas. */
export function describeWebAdapter(): AdapterDescription {
  return {
    kind: 'web',
    summary:
      'Drives a web application in a real browser with Playwright and reports console errors, uncaught exceptions, failed requests and HTTP error responses.',
    actions: WebActionSchema.options.map(
      (schema): ActionSpec => ({
        type: schema.shape.type.value,
        description: schema.description ?? '',
        schema: toJsonSchema(schema),
        example: ACTION_EXAMPLES[schema.shape.type.value] as Action,
      }),
    ),
    assertions: WebAssertionSchema.options.map(
      (schema): AssertionSpec => ({
        type: schema.shape.type.value,
        description: schema.description ?? '',
        schema: toJsonSchema(schema),
        example: ASSERTION_EXAMPLES[schema.shape.type.value] as Assertion,
      }),
    ),
    hints: {
      anchorActionTypes: ['navigate'],
      inputActions: [
        { type: 'fill', field: 'value' },
        { type: 'select', field: 'value' },
      ],
      interruptSequences: [[{ type: 'reload' }], [{ type: 'back' }, { type: 'forward' }]],
      waitAction: { type: 'wait', field: 'ms' },
    },
    guide: WEB_GUIDE,
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
}
