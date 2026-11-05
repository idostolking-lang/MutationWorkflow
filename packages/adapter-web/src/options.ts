import { MutationWorkflowError } from '@mutationworkflow/core';
import { z } from 'zod';
import { isLoopbackUrl } from './scope.js';

/** Options of a `kind: web` target (`target.options` in the config). */
export const WebAdapterOptionsSchema = z
  .object({
    baseUrl: z
      .url({ protocol: /^https?$/, error: 'baseUrl must be an http(s) URL' })
      .describe(
        'Root URL of the application, e.g. http://localhost:3000; must be a loopback host unless allowRemoteBaseUrl is true',
      ),
    allowRemoteBaseUrl: z
      .boolean()
      .default(false)
      .describe(
        'Allow a baseUrl that is not localhost, *.localhost, 127.0.0.0/8 or [::1]. Only for a local instance reached through another host name; never production',
      ),
    browser: z
      .enum(['chromium', 'firefox', 'webkit'])
      .default('chromium')
      .describe('Browser engine to launch'),
    headless: z.boolean().default(true).describe('Run the browser without a window'),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .default({ width: 1280, height: 800 })
      .describe('Page viewport in CSS pixels'),
    launchOptions: z
      .record(z.string(), z.unknown())
      .default({})
      .describe('Extra Playwright launch options, passed through unchanged'),
    storageStatePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Playwright storage state file (cookies, localStorage), relative to the project root, loaded into every session',
      ),
  })
  .superRefine((options, ctx) => {
    if (options.allowRemoteBaseUrl || isLoopbackUrl(options.baseUrl)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message:
        'baseUrl must point at a loopback host (localhost, *.localhost, 127.0.0.0/8 or [::1]); set the target option allowRemoteBaseUrl: true to drive a local instance under another host name',
    });
  });
export type WebAdapterOptions = z.infer<typeof WebAdapterOptionsSchema>;
export type WebAdapterOptionsInput = z.input<typeof WebAdapterOptionsSchema>;

/** Validate `target.options`; throws a `CONFIG_INVALID` error with a readable message. */
export function parseWebAdapterOptions(options: unknown, targetId?: string): WebAdapterOptions {
  const result = WebAdapterOptionsSchema.safeParse(options);
  if (result.success) return result.data;
  const where = targetId ? ` of target "${targetId}"` : '';
  throw new MutationWorkflowError(
    'CONFIG_INVALID',
    `Invalid web adapter options${where}:\n${z.prettifyError(result.error)}`,
  );
}
