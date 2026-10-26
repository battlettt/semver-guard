import * as fs from 'node:fs';
import type { BreakingChange, ChangeCode, CompareResult } from './model.js';

/** The baseline file is missing, is not valid JSON, or does not have the expected shape. */
export class BaselineError extends Error {}

/** A breaking change the maintainer has accepted, identified the same way as in the JSON report. */
export interface BaselineEntry {
  code: ChangeCode;
  export: string;
  /** Omitted: matches the change in any file. */
  file?: string;
  /** Omitted: matches only changes that have no member. */
  member?: string;
  /** Free-form note explaining why the change is accepted. */
  reason?: string;
}

export interface BaselineResult {
  /** The comparison result without the accepted changes. */
  result: CompareResult;
  /** Entries that matched no reported change. */
  unused: BaselineEntry[];
}

const CHANGE_CODES: ReadonlySet<string> = new Set<ChangeCode>([
  'export-removed',
  'kind-changed',
  'signature-changed',
  'type-changed',
  'type-parameters-changed',
  'heritage-changed',
  'modifier-changed',
  'member-removed',
  'member-changed',
  'member-added',
  'enum-member-removed',
  'enum-member-changed',
]);

/** Report fields that may appear in an entry (so report entries can be pasted as-is) but are not used for matching. */
const IGNORED_ENTRY_FIELDS = new Set(['exportKind', 'message', 'before', 'after', 'reexportedBy']);
const ENTRY_FIELDS = new Set(['code', 'export', 'file', 'member', 'reason']);
/** Top-level fields of a JSON report, so a saved report can be used as a baseline. */
const IGNORED_TOP_LEVEL_FIELDS = new Set(['from', 'to', 'summary']);

/**
 * Reads a baseline file: a JSON object with an `accepted` array of entries, or
 * a JSON report written by `--format json` (whose `changes` are all accepted).
 */
export function loadBaseline(file: string): BaselineEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new BaselineError(
      code === 'ENOENT' ? `baseline file not found: ${file}` : `cannot read baseline file ${file}: ${(error as Error).message}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new BaselineError(`baseline file ${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseBaseline(data, file);
}

/** Validates already-parsed baseline JSON. `file` is used in error messages. */
export function parseBaseline(data: unknown, file = 'baseline'): BaselineEntry[] {
  const fail = (message: string): never => {
    throw new BaselineError(`invalid baseline file ${file}: ${message}`);
  };
  if (!isObject(data)) fail('expected a JSON object with an "accepted" array');
  const root = data as Record<string, unknown>;
  const listKey = 'accepted' in root ? 'accepted' : 'changes' in root ? 'changes' : undefined;
  if (listKey === undefined) fail('expected a JSON object with an "accepted" array');
  if ('accepted' in root && 'changes' in root) fail('use either "accepted" or "changes", not both');
  for (const key of Object.keys(root)) {
    if (key !== listKey && !IGNORED_TOP_LEVEL_FIELDS.has(key)) fail(`unknown top-level field "${key}"`);
  }
  const list = root[listKey!];
  if (!Array.isArray(list)) fail(`"${listKey}" must be an array`);

  return (list as unknown[]).map((item, i) => {
    const where = `${listKey}[${i}]`;
    if (!isObject(item)) return fail(`${where} must be an object`);
    const raw = item as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ENTRY_FIELDS.has(key) && !IGNORED_ENTRY_FIELDS.has(key)) fail(`${where} has unknown field "${key}"`);
    }
    if (typeof raw.code !== 'string' || raw.code === '') fail(`${where}.code must be a non-empty string`);
    if (!CHANGE_CODES.has(raw.code as string)) {
      fail(`${where}.code "${raw.code}" is not a known change code (expected one of: ${[...CHANGE_CODES].join(', ')})`);
    }
    if (typeof raw.export !== 'string' || raw.export === '') fail(`${where}.export must be a non-empty string`);
    for (const key of ['file', 'member', 'reason'] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') fail(`${where}.${key} must be a string`);
    }
    const entry: BaselineEntry = { code: raw.code as ChangeCode, export: raw.export as string };
    if (raw.file !== undefined) entry.file = raw.file as string;
    if (raw.member !== undefined) entry.member = raw.member as string;
    if (raw.reason !== undefined) entry.reason = raw.reason as string;
    return entry;
  });
}

export function matchesBaseline(entry: BaselineEntry, change: BreakingChange): boolean {
  return (
    entry.code === change.code &&
    entry.export === change.export &&
    entry.member === change.member &&
    (entry.file === undefined || entry.file === change.file)
  );
}

/** Removes accepted changes from `result` and reports which entries matched nothing. */
export function applyBaseline(result: CompareResult, entries: BaselineEntry[]): BaselineResult {
  const used = new Set<BaselineEntry>();
  const changes = result.changes.filter((change) => {
    const matching = entries.filter((entry) => matchesBaseline(entry, change));
    for (const entry of matching) used.add(entry);
    return matching.length === 0;
  });
  return {
    result: {
      ...result,
      summary: { ...result.summary, breaking: changes.length, accepted: result.changes.length - changes.length },
      changes,
    },
    unused: entries.filter((entry) => !used.has(entry)),
  };
}

/** Short description of an entry for warnings, e.g. `member-removed Client#disconnect in src/client.ts`. */
export function describeBaselineEntry(entry: BaselineEntry): string {
  const label = entry.member !== undefined ? `${entry.export}#${entry.member}` : entry.export;
  return `${entry.code} ${label}${entry.file !== undefined ? ` in ${entry.file}` : ''}`;
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
