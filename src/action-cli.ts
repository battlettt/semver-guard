#!/usr/bin/env node
import { main } from './action.js';
import { EXIT_ERROR } from './run.js';

try {
  main();
} catch (error) {
  process.stderr.write(`semver-guard: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = EXIT_ERROR;
}
