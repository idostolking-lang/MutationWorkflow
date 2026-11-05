#!/usr/bin/env node
// Fake coding-agent command line used by the driver tests. It speaks enough of the Claude Code
// (`-p ... --mcp-config ... --output-format json`) and Codex (`exec -c mcp_servers.mw.url=...
// --output-last-message FILE PROMPT`) command lines to exercise the drivers: it finds the tool
// server in its arguments, performs the tool calls the task text asks for, and prints a result
// the way the real tool would.
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes('--crash')) {
  console.error('simulated failure');
  process.exit(3);
}

const mcpConfig = flag('--mcp-config');
let url;
let task;
let style;
let outputFile;
if (mcpConfig) {
  style = 'claude';
  url = JSON.parse(mcpConfig).mcpServers.mw.url;
  task = flag('-p') ?? '';
} else {
  style = 'codex';
  const override = argv.find((arg) => arg.startsWith('mcp_servers.mw.url='));
  url = JSON.parse(override.slice('mcp_servers.mw.url='.length));
  task = argv.at(-1) ?? '';
  outputFile = flag('--output-last-message');
}

const script = JSON.parse(task.match(/SCRIPT:(\[.*\])/s)?.[1] ?? '[]');
const client = new Client({ name: 'fake-agent-cli', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const tools = (await client.listTools()).tools.map((tool) => tool.name);
const outputs = [];
for (const step of script) {
  const result = await client.callTool({ name: step.tool, arguments: step.input });
  outputs.push(
    result.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(''),
  );
}
await client.close();

const summary = JSON.stringify({ tools, outputs, model: flag('--model') ?? null, argv });
if (style === 'claude') {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: summary,
      num_turns: script.length + 1,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
      modelUsage: { 'fake-model-x': {} },
    }),
  );
} else {
  writeFileSync(outputFile, summary);
  console.log('codex done');
}
