import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCodeMapper,
  indexRepository,
  methodOf,
  normalizePath,
  searchablePrefix,
} from './codemap.js';

describe('path normalisation', () => {
  it('drops methods, query strings, fragments and volatile segments', () => {
    expect(normalizePath('POST /api/todos/42?x=1')).toBe('/api/todos/*');
    expect(normalizePath('/settings#tab')).toBe('/settings');
    expect(normalizePath('/users/3fa85f64-5717-4562-b3fc-2c963f66afa6/edit')).toBe('/users/*/edit');
    expect(normalizePath('/orders/ord_1a2b3c4d5e6f')).toBe('/orders/*');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('GET /')).toBe('/');
    expect(normalizePath('add')).toBe('add');
  });

  it('extracts the method and the searchable prefix', () => {
    expect(methodOf('DELETE /api/todos/1')).toBe('DELETE');
    expect(methodOf('/api/todos')).toBeUndefined();
    expect(searchablePrefix('/api/todos/*')).toBe('/api/todos');
    expect(searchablePrefix('/users/*/edit')).toBe('/users');
    expect(searchablePrefix('/')).toBeUndefined();
    expect(searchablePrefix('add')).toBeUndefined();
  });
});

describe('code mapper', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mw-codemap-'));
    mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(dir, '.mutationworkflow', 'reports'), { recursive: true });
    writeFileSync(join(dir, 'src', 'routes', 'todos.js'), "router.post('/api/todos', add);\n");
    writeFileSync(join(dir, 'src', 'client.js'), "fetch('/api/todos').then(render);\n");
    writeFileSync(join(dir, 'src', 'about.js'), "export const about = 'nothing here';\n");
    writeFileSync(join(dir, 'README.md'), 'The API lives at /api/todos.\n');
    writeFileSync(join(dir, 'mutationworkflow.config.yaml'), 'codemap: [{ match: /api/todos }]\n');
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), "'/api/todos' in a dependency\n");
    writeFileSync(join(dir, '.mutationworkflow', 'reports', 'r.md'), 'Endpoints: `/api/todos`\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('indexes source files, leaving out ignored directories, documentation and its own config', () => {
    const index = indexRepository(dir);
    expect([...index.files.keys()].sort()).toEqual([
      'src/about.js',
      'src/client.js',
      'src/routes/todos.js',
    ]);
  });

  it('maps endpoints to files through the repository search and explicit rules', () => {
    const mapper = createCodeMapper({
      rootDir: dir,
      rules: [
        { match: '/api/todos/**', files: ['src/routes/todos.js', 'db/schema.sql'] },
        { match: 'DELETE /api/todos/*', files: ['src/routes/delete.js'] },
      ],
    });
    expect(mapper.filesFor({ urls: ['/'], endpoints: ['GET /api/todos'] })).toEqual([
      'db/schema.sql',
      'src/client.js',
      'src/routes/todos.js',
    ]);
    expect(mapper.filesFor({ urls: [], endpoints: ['DELETE /api/todos/7'] })).toEqual([
      'db/schema.sql',
      'src/client.js',
      'src/routes/delete.js',
      'src/routes/todos.js',
    ]);
    expect(mapper.filesFor({ urls: ['/'], endpoints: [] })).toEqual([]);
  });

  it('lets a rule with a method cover the collection, and maps command words through rules only', () => {
    const mapper = createCodeMapper({
      rootDir: dir,
      rules: [
        { match: 'POST /api/todos/**', files: ['src/routes/create.js'] },
        { match: 'add', files: ['src/commands/add.js'] },
      ],
    });
    expect(mapper.filesFor({ urls: [], endpoints: ['POST /api/todos'] })).toContain(
      'src/routes/create.js',
    );
    expect(mapper.filesFor({ urls: [], endpoints: ['GET /api/todos'] })).not.toContain(
      'src/routes/create.js',
    );
    expect(mapper.filesFor({ urls: [], endpoints: ['add', 'undo'] })).toEqual([
      'src/commands/add.js',
    ]);
  });

  it('reuses a supplied repository index', () => {
    let reads = 0;
    const mapper = createCodeMapper({
      rootDir: dir,
      rules: [],
      repository: () => {
        reads += 1;
        return { files: new Map([['app.js', "app.get('/health', ok)"]]) };
      },
    });
    expect(mapper.filesFor({ urls: ['/health'], endpoints: [] })).toEqual(['app.js']);
    expect(mapper.filesFor({ urls: ['/health'], endpoints: ['GET /health'] })).toEqual(['app.js']);
    expect(reads).toBe(1);
  });
});
