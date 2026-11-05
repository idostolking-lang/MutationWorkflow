#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv);
process.exitCode = code;
// Let pending output flush and the event loop drain; force the exit if something lingers.
setTimeout(() => process.exit(code), 2_000).unref();
