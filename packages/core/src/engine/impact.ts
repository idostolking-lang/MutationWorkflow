import type { Workflow } from '../schema/index.js';
import type { Store } from '../store/types.js';
import { globToRegExp } from '../util/glob.js';

/**
 * Which workflows a code change affects. Every run teaches a workflow what it touches (pages,
 * endpoints, and through the code map the files behind them); a push or a scheduled run then
 * replays the workflows whose footprint overlaps the change, plus the ones nobody knows about
 * yet, and skips the rest.
 */

/** Files whose change can affect anything: dependency manifests, build and global config. */
const SHARED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/,
  /(^|\/)(tsconfig[^/]*\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|\.env\.example)$/,
  /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Makefile)$/,
  /(^|\/)(prisma\/schema\.prisma|migrations?\/)/,
];

export interface TargetImpact {
  targetId: string;
  /** Base workflows whose known footprint overlaps the change. */
  impacted: Workflow[];
  /** Base workflows that have not run yet, or whose footprint maps to no file. */
  unknown: Workflow[];
  /** Base workflows known not to touch the changed files. */
  unaffected: Workflow[];
  /** A shared file changed (manifest, lockfile, global config): everything should run. */
  sharedChange: boolean;
}

export interface ImpactReport {
  changedFiles: string[];
  /** The git range the files came from, when they were not given explicitly. */
  range?: string;
  targets: TargetImpact[];
}

export function isSharedFile(path: string): boolean {
  return SHARED_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

/** True when `file` equals, is under, or matches one of the workflow's touched paths or globs. */
export function touches(workflowFiles: ReadonlyArray<string>, file: string): boolean {
  return workflowFiles.some((entry) => {
    if (entry === file) return true;
    if (/[*?[\]]/.test(entry)) return globToRegExp(entry).test(file);
    return file.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
  });
}

/**
 * Sort a target's base workflows by what a change does to them. Variants are not listed: they
 * follow their base.
 */
export async function impactOnTarget(
  store: Store,
  targetId: string,
  changedFiles: ReadonlyArray<string>,
): Promise<TargetImpact> {
  const bases = await store.workflows.list({
    targetId,
    parentId: null,
    status: ['active', 'pending-review'],
  });
  const impacted: Workflow[] = [];
  const unknown: Workflow[] = [];
  const unaffected: Workflow[] = [];
  for (const workflow of bases) {
    const files = workflow.touches?.files ?? [];
    if (files.length === 0) {
      unknown.push(workflow);
    } else if (changedFiles.some((file) => touches(files, file))) {
      impacted.push(workflow);
    } else {
      unaffected.push(workflow);
    }
  }
  return {
    targetId,
    impacted,
    unknown,
    unaffected,
    sharedChange: changedFiles.some(isSharedFile),
  };
}

/**
 * The workflow ids to replay for a change: the impacted and unknown bases with all their
 * variants. Returns undefined, meaning "run everything", when a shared file changed or when no
 * workflow is known to be unaffected (a full run then costs the same and teaches more).
 */
export async function selectForChange(
  store: Store,
  impact: TargetImpact,
): Promise<string[] | undefined> {
  if (impact.sharedChange || impact.unaffected.length === 0) return undefined;
  const ids: string[] = [];
  for (const base of [...impact.impacted, ...impact.unknown]) {
    ids.push(base.id);
    for (const variant of await store.workflows.list({ parentId: base.id })) ids.push(variant.id);
  }
  return ids;
}
