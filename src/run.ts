import * as fs from 'node:fs';
import { compareSurfaces } from './compare.js';
import { extractApi, SnapshotError } from './extract.js';
import { formatJson, formatTable, type OutputFormat } from './format.js';

export const EXIT_OK = 0;
export const EXIT_BREAKING = 1;
export const EXIT_ERROR = 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const USAGE = `Usage:
  semver-guard compare --from <dir> --to <dir> [--format table|json]
  semver-guard --help
  semver-guard --version

Compares the exported API of the TypeScript sources under --from (the old
version) with the sources under --to (the new version) and reports breaking
changes.

Options:
  --from <dir>      Directory snapshot of the previous version
  --to <dir>        Directory snapshot of the new version
  --format <fmt>    Output format: "table" (default) or "json"
  -h, --help        Show this help
  -v, --version     Show the version

Exit codes:
  0  no breaking changes
  1  breaking changes found
  2  usage or I/O error
`;

class UsageError extends Error {}

interface CompareOptions {
  from: string;
  to: string;
  format: OutputFormat;
}

function parseCompareArgs(args: string[]): CompareOptions {
  const values: Partial<Record<'from' | 'to' | 'format', string>> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const match = /^--(from|to|format)(?:=(.*))?$/.exec(arg);
    if (!match) {
      throw new UsageError(arg.startsWith('-') ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
    }
    const name = match[1] as 'from' | 'to' | 'format';
    let value = match[2];
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`option --${name} requires a value`);
      }
      i++;
    }
    if (value === '') throw new UsageError(`option --${name} requires a value`);
    if (values[name] !== undefined) throw new UsageError(`option --${name} was given more than once`);
    values[name] = value;
  }
  if (values.from === undefined) throw new UsageError('missing required option --from');
  if (values.to === undefined) throw new UsageError('missing required option --to');
  const format = values.format ?? 'table';
  if (format !== 'table' && format !== 'json') {
    throw new UsageError(`invalid --format "${format}" (expected "table" or "json")`);
  }
  return { from: values.from, to: values.to, format };
}

function readVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

/** Runs the CLI with the given arguments (excluding `node` and the script path) and returns the exit code. */
export function run(argv: string[], io: Io): number {
  const [command, ...rest] = argv;
  try {
    if (command === undefined) throw new UsageError('missing command');
    if (command === '-h' || command === '--help' || command === 'help') {
      io.stdout(USAGE);
      return EXIT_OK;
    }
    if (command === '-v' || command === '--version') {
      io.stdout(`${readVersion()}\n`);
      return EXIT_OK;
    }
    if (command !== 'compare') throw new UsageError(`unknown command: ${command}`);
    if (rest.includes('-h') || rest.includes('--help')) {
      io.stdout(USAGE);
      return EXIT_OK;
    }

    const options = parseCompareArgs(rest);
    const before = extractApi(options.from);
    const after = extractApi(options.to);
    const result = compareSurfaces(before, after, { from: options.from, to: options.to });
    io.stdout(options.format === 'json' ? formatJson(result) : formatTable(result));
    return result.changes.length > 0 ? EXIT_BREAKING : EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`semver-guard: ${error.message}\n\n${USAGE}`);
      return EXIT_ERROR;
    }
    if (error instanceof SnapshotError || isNodeError(error)) {
      io.stderr(`semver-guard: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
