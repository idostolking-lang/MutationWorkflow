import type { AdapterDescription } from '../../adapter/types.js';
import type { TargetConfig } from '../../schema/target.js';

export const PRODUCT_BRIEF = `MutationWorkflow finds the bugs that live between an application's test cases: it discovers the workflows real users perform, derives mutations of them (a skipped step, a repeated submit, a reload mid-flow, odd input, a different role), replays everything deterministically against a local copy of the application, and keeps what it learns in a persistent memory.`;

export const SAFETY_RULES = `Rules that always apply:
- You only ever interact with a local test instance of the application that was started for you. Still, never trigger real-world side effects you can see coming (payments, emails or messages to real people, deleting accounts, calling third-party services) even if the UI offers them.
- Stay inside the configured scope. If an action is refused as out of scope or blocked, treat that as information, not an obstacle to work around.
- Prefer tools over guesses. Read before you conclude; observe before you act.
- Be precise and concise in everything you write; it will be stored and read by engineers.`;

export function describeTarget(target: TargetConfig): string {
  const lines = [`Target "${target.id}" (${target.kind})${target.name ? `: ${target.name}` : ''}`];
  if (target.description) lines.push(target.description);
  if (Object.keys(target.options).length > 0)
    lines.push(`Options: ${JSON.stringify(target.options)}`);
  if (target.identities.length > 0) {
    lines.push(
      `Identities: ${target.identities.map((i) => `${i.id}${i.description ? ` (${i.description})` : ''}`).join(', ')}`,
    );
  }
  if (target.invariants.length > 0) {
    lines.push(`Invariants: ${target.invariants.map((i) => i.description ?? i.id).join('; ')}`);
  }
  const { allowUrls, denyUrls, denyText } = target.scope;
  if (allowUrls.length + denyUrls.length + denyText.length > 0) {
    lines.push(
      `Scope: allow ${JSON.stringify(allowUrls)} deny ${JSON.stringify(denyUrls)} never activate text matching ${JSON.stringify(denyText)}`,
    );
  }
  return lines.join('\n');
}

/** Render an adapter's vocabulary for a prompt: one line per action/assertion plus the guide. */
export function describeAdapter(adapter: AdapterDescription): string {
  const actions = adapter.actions
    .map(
      (a) =>
        `- ${a.type}: ${a.description}${a.example ? ` e.g. ${JSON.stringify(a.example)}` : ''}`,
    )
    .join('\n');
  const assertions = adapter.assertions
    .map(
      (a) =>
        `- ${a.type}: ${a.description}${a.example ? ` e.g. ${JSON.stringify(a.example)}` : ''}`,
    )
    .join('\n');
  return `Adapter "${adapter.kind}": ${adapter.summary}

Actions:
${actions}

Assertions:
${assertions}

${adapter.guide}`;
}
