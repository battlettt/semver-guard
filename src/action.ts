import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_BREAKING, EXIT_ERROR, EXIT_OK, run, type Io } from './run.js';

/**
 * The inputs of the GitHub Action (`action.yml`), as read from the
 * environment. An empty or whitespace-only value counts as "not given",
 * which is what GitHub passes for an optional input the workflow leaves out.
 */
export interface ActionInputs {
  from?: string;
  to?: string;
  fromRef?: string;
  toRef?: string;
  baseline?: string;
  format?: string;
  workingDirectory?: string;
}

/**
 * Environment variable for each input. `action.yml` sets these from
 * `${{ inputs.* }}` in the step's `env:` block, so input values never become
 * part of a shell script.
 */
export const ACTION_ENV: Readonly<Record<keyof ActionInputs, string>> = {
  from: 'SEMVER_GUARD_FROM',
  to: 'SEMVER_GUARD_TO',
  fromRef: 'SEMVER_GUARD_FROM_REF',
  toRef: 'SEMVER_GUARD_TO_REF',
  baseline: 'SEMVER_GUARD_BASELINE',
  format: 'SEMVER_GUARD_FORMAT',
  workingDirectory: 'SEMVER_GUARD_WORKING_DIRECTORY',
};

/** Name of each input in `action.yml`, used in error messages. */
export const ACTION_INPUT_NAMES: Readonly<Record<keyof ActionInputs, string>> = {
  from: 'from',
  to: 'to',
  fromRef: 'from-ref',
  toRef: 'to-ref',
  baseline: 'baseline',
  format: 'format',
  workingDirectory: 'working-directory',
};

/** The action inputs are inconsistent; reported with the input names, before the CLI runs. */
export class ActionInputError extends Error {}

/** What the action runs: `semver-guard <args>` with `cwd` as the current directory. */
export interface ActionInvocation {
  args: string[];
  cwd: string;
}

/** Reads the inputs from the environment variables in {@link ACTION_ENV}. */
export function readActionInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const inputs: ActionInputs = {};
  for (const key of Object.keys(ACTION_ENV) as (keyof ActionInputs)[]) {
    const value = env[ACTION_ENV[key]];
    if (value !== undefined) inputs[key] = value;
  }
  return inputs;
}

function value(inputs: ActionInputs, key: keyof ActionInputs): string | undefined {
  const raw = inputs[key]?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/[\r\n]/.test(raw)) throw new ActionInputError(`input ${ACTION_INPUT_NAMES[key]} must be a single line`);
  return raw;
}

/**
 * Maps action inputs to the CLI arguments and working directory.
 *
 * - `compare` comes first, then the old side (`--from` or `--from-ref`), the
 *   new side (`--to` or `--to-ref`), `--baseline` if given, and `--format`
 *   (always, `table` if empty).
 * - Every option is passed as `--name=value`, so a value is never mistaken
 *   for an option.
 * - Values are trimmed; empty values are left out.
 * - Each side needs exactly one of its directory and ref inputs.
 * - `cwd` is `working-directory` resolved against `workspace`
 *   (`$GITHUB_WORKSPACE`). Relative `from`, `to` and `baseline` paths are
 *   resolved by the CLI against it, and git refs are read from the repository
 *   that contains it (and compare that directory at each ref).
 */
export function actionInvocation(inputs: ActionInputs, workspace: string): ActionInvocation {
  const args = ['compare'];
  const side = (dirKey: 'from' | 'to', refKey: 'fromRef' | 'toRef', option: 'from' | 'to') => {
    const dir = value(inputs, dirKey);
    const ref = value(inputs, refKey);
    const names = `${ACTION_INPUT_NAMES[dirKey]} or ${ACTION_INPUT_NAMES[refKey]}`;
    if (dir !== undefined && ref !== undefined) {
      throw new ActionInputError(`inputs ${ACTION_INPUT_NAMES[dirKey]} and ${ACTION_INPUT_NAMES[refKey]} cannot both be set (set ${names})`);
    }
    if (dir !== undefined) args.push(`--${option}=${dir}`);
    else if (ref !== undefined) args.push(`--${option}-ref=${ref}`);
    else throw new ActionInputError(`one of the inputs ${names} is required`);
  };
  side('from', 'fromRef', 'from');
  side('to', 'toRef', 'to');
  const baseline = value(inputs, 'baseline');
  if (baseline !== undefined) args.push(`--baseline=${baseline}`);
  args.push(`--format=${value(inputs, 'format') ?? 'table'}`);
  return { args, cwd: path.resolve(workspace, value(inputs, 'workingDirectory') ?? '.') };
}

/** Quotes `arg` for display in a POSIX shell command line. */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Escapes the message of a workflow command (`::error::message`). */
export function escapeCommandData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export interface ActionIo extends Io {
  /** `$GITHUB_STEP_SUMMARY`; the report is appended to it when set. */
  appendSummary?: (markdown: string) => void;
}

/**
 * Runs semver-guard for the action: maps the inputs, prints the command,
 * runs the CLI in-process with its output going to the step log, adds an
 * error annotation on failure and the report to the job summary, and returns
 * the CLI's exit code (`0`, `1` for breaking changes, `2` for errors).
 */
export function runAction(env: NodeJS.ProcessEnv, io: ActionIo): number {
  let invocation: ActionInvocation;
  try {
    invocation = actionInvocation(readActionInputs(env), env.GITHUB_WORKSPACE ?? process.cwd());
  } catch (error) {
    if (!(error instanceof ActionInputError)) throw error;
    io.stdout(`::error title=semver-guard::${escapeCommandData(error.message)}\n`);
    return EXIT_ERROR;
  }

  io.stdout(`$ semver-guard ${invocation.args.map(shellQuote).join(' ')}\n`);
  if (invocation.cwd !== path.resolve(env.GITHUB_WORKSPACE ?? process.cwd())) {
    io.stdout(`  (in ${invocation.cwd})\n`);
  }

  let report = '';
  let errors = '';
  const previous = process.cwd();
  let code: number;
  try {
    process.chdir(invocation.cwd);
  } catch {
    const message = `working-directory ${invocation.cwd} does not exist or is not a directory`;
    io.stdout(`::error title=semver-guard::${escapeCommandData(message)}\n`);
    return EXIT_ERROR;
  }
  try {
    code = run(invocation.args, {
      stdout: (text) => {
        report += text;
        io.stdout(text);
      },
      stderr: (text) => {
        errors += text;
        io.stderr(text);
      },
      cwd: invocation.cwd,
    });
  } finally {
    process.chdir(previous);
  }

  if (code === EXIT_BREAKING) {
    io.stdout(
      `::error title=semver-guard::${escapeCommandData(`${breakingSummary(report)} Bump the major version, restore compatibility, or accept the changes in a baseline file.`)}\n`,
    );
  } else if (code !== EXIT_OK) {
    const message = errors.split('\n').find((line) => line.trim() !== '') ?? `semver-guard exited with code ${code}`;
    io.stdout(`::error title=semver-guard::${escapeCommandData(message)}\n`);
  }
  if (io.appendSummary && report !== '') io.appendSummary(stepSummary(code, report));
  return code;
}

function breakingSummary(report: string): string {
  const table = /^\d+ breaking changes? found\./m.exec(report);
  if (table) return table[0];
  try {
    const n = (JSON.parse(report) as { summary?: { breaking?: unknown } }).summary?.breaking;
    if (typeof n === 'number') return `${n} breaking change${n === 1 ? '' : 's'} found.`;
  } catch {
    // Not JSON; fall through.
  }
  return 'Breaking changes found.';
}

/** Markdown for `$GITHUB_STEP_SUMMARY`: a heading with the outcome and the report in a code block. */
export function stepSummary(code: number, report: string): string {
  const heading = code === EXIT_OK ? 'semver-guard: no breaking changes' : 'semver-guard: breaking changes found';
  const fence = report.includes('```') ? '~~~~' : '```';
  return `### ${heading}\n\n${fence}\n${report.replace(/\n$/, '')}\n${fence}\n`;
}

/** Entry point used by `dist/action-cli.js`. */
export function main(): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = runAction(process.env, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    appendSummary: summaryFile ? (markdown) => fs.appendFileSync(summaryFile, markdown) : undefined,
  });
}
