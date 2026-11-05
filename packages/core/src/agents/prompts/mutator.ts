import { z } from 'zod';
import type { AdapterDescription } from '../../adapter/types.js';
import { AssertionSchema } from '../../schema/action.js';
import type { TargetConfig, Workflow } from '../../schema/index.js';
import { StepInputSchema } from '../../schema/workflow.js';
import { describeAdapter, describeTarget, PRODUCT_BRIEF, SAFETY_RULES } from './common.js';

export const AgentVariantsSchema = z.object({
  variants: z.array(
    z.object({
      titleSuffix: z.string().describe('Short label, e.g. "edit while list is filtered"'),
      description: z.string().describe('What changed and which bug it could reveal'),
      steps: z.array(StepInputSchema).min(1),
      expect: z
        .array(AssertionSchema)
        .optional()
        .describe(
          'Final-state assertions that should still hold; omit to keep only crash detection',
        ),
    }),
  ),
});
export type AgentVariants = z.infer<typeof AgentVariantsSchema>;

export function mutatorPrompt(input: {
  target: TargetConfig;
  adapter: AdapterDescription;
  workflow: Workflow;
  existingVariantDescriptions: string[];
  maxVariants: number;
}): string {
  return `You are the mutator agent of MutationWorkflow. ${PRODUCT_BRIEF}

Deterministic operators already produce the obvious variants of this workflow: skipped, swapped and repeated steps, interruptions, boundary input, role swaps, interleaving with other workflows. Your job is to propose up to ${input.maxVariants} variants those operators cannot think of: the things a hurried, confused or adversarial-but-plausible user would do that stress state and sequencing. Think about stale views, partially completed flows, racing the UI, revisiting a finished flow, undo after side effects, data that is valid in one step and invalid in a later one.

${describeTarget(input.target)}

Workflow:
${JSON.stringify({ title: input.workflow.title, intent: input.workflow.intent, identity: input.workflow.identity, steps: input.workflow.steps, expect: input.workflow.expect }, null, 2)}

Variants that already exist:
${input.existingVariantDescriptions.length > 0 ? input.existingVariantDescriptions.map((d) => `- ${d}`).join('\n') : '- none'}

Do not include step ids; they are assigned by position. Each variant must be a complete step list using only the adapter's action vocabulary and locators that exist in the original workflow or follow from it. Keep expectations only when they should still hold after the change.

${describeAdapter(input.adapter)}

${SAFETY_RULES}

Submit the variants with the finish tool.`;
}
