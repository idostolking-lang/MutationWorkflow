import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../agents/tools.js';
import { silentLogger } from '../util/logger.js';
import { repositoryTools } from './repo-tools.js';

const context: ToolContext = { role: 'inspector', depth: 0, logger: silentLogger };

function text(output: { content: string | Array<{ type: string; text?: string }> }): string {
  return typeof output.content === 'string'
    ? output.content
    : output.content.map((part) => part.text ?? '').join('');
}

describe('repository tools', () => {
  let root: string;
  let tools: ReturnType<typeof repositoryTools>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mw-repo-'));
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    mkdirSync(join(root, 'node_modules/dep'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'secrets'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'secrets\n*.log\n# comment\n');
    writeFileSync(
      join(root, 'package.json'),
      '{ "name": "demo", "scripts": { "dev": "node server.js" } }',
    );
    writeFileSync(
      join(root, 'src/routes/todo.ts'),
      'export const route = "/todos";\nfunction handler() {}\n',
    );
    writeFileSync(join(root, 'src/app.ts'), 'import "./routes/todo.js";\n');
    writeFileSync(join(root, 'node_modules/dep/index.js'), 'module.exports = "/todos";');
    writeFileSync(join(root, 'dist/app.js'), 'console.log("/todos")');
    writeFileSync(join(root, 'secrets/key.txt'), 'TOP SECRET /todos');
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    tools = repositoryTools(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const tool = (name: string) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };

  it('lists files while hiding generated, vendored and gitignored directories', async () => {
    const listing = text(await tool('list_files').execute({ path: '.', depth: 3 }, context));
    expect(listing).toContain('package.json');
    expect(listing).toContain('src/routes/todo.ts');
    expect(listing).not.toContain('node_modules');
    expect(listing).not.toContain('dist/');
    expect(listing).not.toContain('secrets');
    const shallow = text(await tool('list_files').execute({ path: 'src', depth: 1 }, context));
    expect(shallow).toContain('src/routes/');
    expect(shallow).not.toContain('todo.ts');
  });

  it('reads text files with offsets and refuses binaries and escapes', async () => {
    const read = tool('read_file');
    expect(text(await read.execute({ path: 'src/routes/todo.ts', offset: 0 }, context))).toContain(
      '/todos',
    );
    expect(text(await read.execute({ path: 'src/routes/todo.ts', offset: 7 }, context))).toMatch(
      /^const route/,
    );
    const binary = await read.execute({ path: 'logo.png', offset: 0 }, context);
    expect(binary.isError).toBe(true);
    expect(text(binary)).toContain('binary');
    const escape = await read.execute({ path: '../../etc/passwd', offset: 0 }, context);
    expect(escape.isError).toBe(true);
    const missing = await read.execute({ path: 'nope.ts', offset: 0 }, context);
    expect(missing.isError).toBe(true);
  });

  it('searches with a regular expression, path filter and result cap', async () => {
    const search = tool('search');
    const all = text(await search.execute({ pattern: '/todos', maxResults: 60 }, context));
    expect(all).toContain('src/routes/todo.ts:1:');
    expect(all).not.toContain('node_modules');
    expect(all).not.toContain('secrets/key.txt');
    expect(all).not.toContain('dist/app.js');
    const filtered = text(
      await search.execute({ pattern: 'todos', pathContains: 'routes', maxResults: 60 }, context),
    );
    expect(filtered).toContain('1 match(es)');
    const capped = text(await search.execute({ pattern: '.', maxResults: 1 }, context));
    expect(capped).toContain('limit reached');
    const invalid = await search.execute({ pattern: '(', maxResults: 10 }, context);
    expect(invalid.isError).toBe(true);
  });
});
