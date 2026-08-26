#!/usr/bin/env node
// The entry point, and the only place in this package that writes to a
// terminal or reaches the SDK at runtime (SDD §5.2, FR-5.1, BACKLOG D-85).
//
// Everything under `src/` is a library: the CLI decides what to print and this
// prints it, so the whole surface is testable without a terminal, and nothing
// in the library can reach the live API by forgetting to override a default.
// Both rules are enforced by tests that scan the tracked sources under `src/`,
// which is why this file sits outside it.
import { query } from '@anthropic-ai/claude-agent-sdk';

import { runCli } from '../dist/cli/main.js';

const result = await runCli(process.argv.slice(2), { cwd: process.cwd(), query });

for (const line of result.out) process.stdout.write(`${line}\n`);
for (const line of result.err) process.stderr.write(`${line}\n`);
process.exitCode = result.exitCode;
