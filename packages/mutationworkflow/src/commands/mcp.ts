import type { Command } from 'commander';
import type { Cli } from '../context.js';
import { serveStdio } from '../mcp/server.js';

export function registerMcp(program: Command, cli: Cli): void {
  program
    .command('mcp')
    .description('Serve the MCP server on stdio (for Claude Code, Codex, Cursor)')
    .action(async () => {
      cli.interruptExpected = true;
      const engine = await cli.openEngine({ allowMissingConfig: true });
      await serveStdio(engine, { signal: cli.signal });
    });
}
