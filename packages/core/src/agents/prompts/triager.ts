import { z } from 'zod';
import { SeveritySchema } from '../../schema/common.js';
import { TriageVerdictSchema } from '../../schema/finding.js';
import type { TargetConfig } from '../../schema/target.js';
import { describeTarget, PRODUCT_BRIEF, SAFETY_RULES } from './common.js';

export const TriageDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      findingId: z.string(),
      verdict: TriageVerdictSchema,
      title: z
        .string()
        .describe('Specific, user-facing title, e.g. "Submitting twice creates duplicate items"'),
      summary: z
        .string()
        .describe(
          'What happens, the exact sequence that triggers it, and the observed vs expected behaviour',
        ),
      severity: SeveritySchema,
      rationale: z.string().describe('Why this verdict; what evidence supports it'),
      duplicateOf: z.string().optional().describe('Id of another finding this one duplicates'),
    }),
  ),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;

export function triagerPrompt(input: { target: TargetConfig }): string {
  return `You are the triager agent of MutationWorkflow. ${PRODUCT_BRIEF}

Automatic oracles flagged the findings below. Each comes with the workflow that ran, how it was mutated, what happened at every step, the error signals the application emitted, failed expectations, and evidence such as screenshots and logs (use get_evidence to look at them). Decide for each finding:
- bug: the application misbehaved. A crash, an unhandled exception, a server error or corrupted state is always a bug, however unusual the sequence; a failed expectation on a mutated workflow is a bug only when the application should have prevented or handled the mutated sequence (double submission creating duplicates is a bug; an item missing because the step that adds it was skipped is not).
- not-a-bug: the application handled the unusual sequence correctly (refused, showed validation, stayed consistent) and the expectation failed only because the mutation made it inapplicable.
- needs-human: the right behaviour depends on product intent you cannot infer.

For every finding write a precise title and a summary an engineer can reproduce from, choose the severity by user impact, and mark duplicates (same root cause) with duplicateOf pointing at the finding that best represents them.

${describeTarget(input.target)}

${SAFETY_RULES}

Submit your decisions with the finish tool, one entry per finding id you were given.`;
}
