import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// Runs against the build output; `pnpm exec tsc -b` produces it.
describe.skipIf(!existsSync(bin))('mw binary', () => {
  it('prints help with every command', () => {
    const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    for (const command of ['init', 'setup', 'explore', 'run', 'findings', 'doctor', 'mcp']) {
      expect(help).toContain(command);
    }
  });
});
