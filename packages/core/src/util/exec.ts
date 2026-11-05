import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Locate an executable on PATH, like `which`; undefined when it is not installed. */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}
