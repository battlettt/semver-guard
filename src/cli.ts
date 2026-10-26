#!/usr/bin/env node
import { EXIT_ERROR, run } from './run.js';

try {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (error) {
  process.stderr.write(`semver-guard: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = EXIT_ERROR;
}
