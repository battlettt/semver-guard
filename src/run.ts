import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyBaseline, BaselineError, describeBaselineEntry, loadBaseline, type BaselineEntry } from './baseline.js';
import { compareSurfaces } from './compare.js';
import { extractApi, findEntryPoints, SnapshotError } from './extract.js';
import { formatJson, formatTable, type OutputFormat } from './format.js';
import { findGitContext, GitError, materializeRef, type RefSnapshot } from './git.js';

export const EXIT_OK = 0;
export const EXIT_BREAKING = 1;
export const EXIT_ERROR = 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Directory that git refs are resolved in. Defaults to `process.cwd()`. */
  cwd?: string;
}

export const USAGE = `Usage:
  semver-guard compare --from <dir> --to <dir> [--format table|json] [--baseline <file>]
  semver-guard compare --from-ref <ref> --to-ref <ref> [options]
  semver-guard --help
  semver-guard --version

Compares the exported API of the TypeScript sources under --from (the old
version) with the sources under --to (the new version) and reports breaking
changes. If a snapshot has a package.json with "exports" or "main", only what
its entry points export is compared.

Options:
  --from <dir>        Directory snapshot of the previous version
  --to <dir>          Directory snapshot of the new version
  --from-ref <ref>    Git tag, branch or commit of the previous version
  --to-ref <ref>      Git tag, branch or commit of the new version
                      (refs are read from the repository containing the
                      current directory; each side takes a directory or a ref)
  --baseline <file>   JSON file of accepted breaking changes to suppress
  --format <fmt>      Output format: "table" (default) or "json"
  -h, --help          Show this help
  -v, --version     Show the version

Exit codes:
  0  no breaking changes
  1  breaking changes found
  2  usage or I/O error
`;

class UsageError extends Error {}

/** One side of the comparison: a directory or a git ref. */
type Side = { dir: string } | { ref: string };

interface CompareOptions {
  from: Side;
  to: Side;
  format: OutputFormat;
  baseline?: string;
}

type OptionName = 'from' | 'to' | 'from-ref' | 'to-ref' | 'format' | 'baseline';

function parseCompareArgs(args: string[]): CompareOptions {
  const values: Partial<Record<OptionName, string>> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const match = /^--(from-ref|to-ref|from|to|format|baseline)(?:=(.*))?$/.exec(arg);
    if (!match) {
      throw new UsageError(arg.startsWith('-') ? `unknown option: ${arg}` : `unexpected argument: ${arg}`);
    }
    const name = match[1] as OptionName;
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
  const side = (name: 'from' | 'to', version: string): Side => {
    const dir = values[name];
    const ref = values[`${name}-ref`];
    if (dir !== undefined && ref !== undefined) {
      throw new UsageError(
        `--${name} and --${name}-ref cannot be used together (give the ${version} version as a directory or as a git ref, not both)`,
      );
    }
    if (dir !== undefined) return { dir };
    if (ref !== undefined) return { ref };
    throw new UsageError(`missing required option --${name} (or --${name}-ref)`);
  };
  const from = side('from', 'old');
  const to = side('to', 'new');
  const format = values.format ?? 'table';
  if (format !== 'table' && format !== 'json') {
    throw new UsageError(`invalid --format "${format}" (expected "table" or "json")`);
  }
  return { from, to, format, baseline: values.baseline };
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

    return compare(parseCompareArgs(rest), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`semver-guard: ${error.message}\n\n${USAGE}`);
      return EXIT_ERROR;
    }
    if (
      error instanceof SnapshotError ||
      error instanceof GitError ||
      error instanceof BaselineError ||
      isNodeError(error)
    ) {
      io.stderr(`semver-guard: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
}

function compare(options: CompareOptions, io: Io): number {
  const cwd = path.resolve(io.cwd ?? process.cwd());
  const refs = [options.from, options.to].filter((side) => 'ref' in side);
  const git = refs.length > 0 ? findGitContext(cwd) : undefined;
  if (refs.length > 0 && !git) {
    throw new UsageError(
      `--from-ref/--to-ref need a git repository, but ${cwd} is not inside a git work tree (run semver-guard from inside the repository, or use --from/--to with directories)`,
    );
  }
  // Read the baseline before doing any work, so a bad file fails fast.
  const baseline: BaselineEntry[] | undefined =
    options.baseline !== undefined ? loadBaseline(options.baseline) : undefined;

  const snapshots: RefSnapshot[] = [];
  try {
    const resolve = (side: Side): { dir: string; label: string; errorLabel?: string } => {
      if ('dir' in side) return { dir: side.dir, label: side.dir };
      const snapshot = materializeRef(side.ref, git!);
      snapshots.push(snapshot);
      return { dir: snapshot.dir, label: side.ref, errorLabel: `git ref ${side.ref}` };
    };
    const from = resolve(options.from);
    const to = resolve(options.to);

    // Entry points only apply when both sides declare them; otherwise a
    // package.json gaining "exports" would make every other module look removed.
    const entryPoints = findEntryPoints(from.dir) !== undefined && findEntryPoints(to.dir) !== undefined;
    const before = extractApi(from.dir, { entryPoints, label: from.errorLabel });
    const after = extractApi(to.dir, { entryPoints, label: to.errorLabel });
    let result = compareSurfaces(before, after, { from: from.label, to: to.label });

    if (baseline) {
      const applied = applyBaseline(result, baseline);
      result = applied.result;
      for (const entry of applied.unused) {
        io.stderr(
          `semver-guard: warning: baseline entry ${describeBaselineEntry(entry)} did not match any reported change (remove it from ${options.baseline})\n`,
        );
      }
    }

    io.stdout(options.format === 'json' ? formatJson(result) : formatTable(result));
    return result.changes.length > 0 ? EXIT_BREAKING : EXIT_OK;
  } finally {
    for (const snapshot of snapshots) snapshot.cleanup();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
