import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { FIXTURES, makeSnapshot } from './helpers.js';

const BEFORE = path.join(FIXTURES, 'before');
const AFTER = path.join(FIXTURES, 'after');

function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

/** Writes a baseline file and returns its path. */
function baseline(contents: unknown): string {
  const text = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
  return path.join(makeSnapshot({ 'baseline.json': text }), 'baseline.json');
}

const SIMPLE_BEFORE = { 'index.ts': 'export function f(a: string) {}\nexport function g() {}\n' };
const SIMPLE_AFTER = { 'index.ts': 'export function f(a: string, b: number) {}\n' };

describe('--baseline', () => {
  it('suppresses accepted changes so they no longer cause exit 1', () => {
    const from = makeSnapshot(SIMPLE_BEFORE);
    const to = makeSnapshot(SIMPLE_AFTER);
    expect(cli('compare', '--from', from, '--to', to).code).toBe(1);

    const file = baseline({
      accepted: [
        { code: 'signature-changed', file: 'index.ts', export: 'f', reason: 'b is required in 2.0' },
        { code: 'export-removed', export: 'g' },
      ],
    });
    const { code, stdout, stderr } = cli('compare', '--from', from, '--to', to, '--baseline', file);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('No breaking changes found.');
    expect(stdout).toContain('2 accepted breaking changes were suppressed by the baseline.');
  });

  it('keeps reporting changes that are not in the baseline', () => {
    const file = baseline({ accepted: [{ code: 'member-removed', file: 'src/client.ts', export: 'Client', member: 'disconnect' }] });
    const { code, stdout } = cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline', file, '--format', 'json');
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.summary).toMatchObject({ breaking: 5, accepted: 1 });
    expect(report.changes).toHaveLength(5);
    expect(report.changes.some((c: { member?: string }) => c.member === 'disconnect')).toBe(false);
    // A member entry matches only that member, not the export as a whole.
    expect(report.changes.some((c: { member?: string }) => c.member === 'timeoutMs')).toBe(true);
  });

  it('accepts a saved JSON report as the baseline', () => {
    const report = cli('compare', '--from', BEFORE, '--to', AFTER, '--format', 'json').stdout;
    const { code, stdout, stderr } = cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline', baseline(report));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('6 accepted breaking changes were suppressed by the baseline.');
  });

  it('matches every file when an entry has no file', () => {
    const file = baseline({ accepted: [{ code: 'export-removed', export: 'legacyHelper' }] });
    const report = JSON.parse(cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline', file, '--format', 'json').stdout);
    expect(report.summary).toMatchObject({ breaking: 4, accepted: 2 });
  });

  it('warns about entries that match nothing, without failing', () => {
    const from = makeSnapshot(SIMPLE_BEFORE);
    const to = makeSnapshot(SIMPLE_AFTER);
    const file = baseline({
      accepted: [
        { code: 'signature-changed', export: 'f' },
        { code: 'export-removed', export: 'g' },
        { code: 'member-removed', file: 'index.ts', export: 'Gone', member: 'old' },
      ],
    });
    const { code, stdout, stderr } = cli('compare', '--from', from, '--to', to, '--baseline', file, '--format', 'json');
    expect(code).toBe(0);
    expect(JSON.parse(stdout).changes).toEqual([]);
    expect(stderr).toBe(
      `semver-guard: warning: baseline entry member-removed Gone#old in index.ts did not match any reported change (remove it from ${file})\n`,
    );
  });

  it('does not add summary.accepted without a baseline', () => {
    const report = JSON.parse(cli('compare', '--from', BEFORE, '--to', AFTER, '--format', 'json').stdout);
    expect(report.summary).not.toHaveProperty('accepted');
  });
});

describe('invalid baseline files exit 2', () => {
  it.each([
    ['{ not json', 'is not valid JSON'],
    ['[]', 'expected a JSON object with an "accepted" array'],
    [{ accepted: {} }, '"accepted" must be an array'],
    [{ accepted: [], extra: 1 }, 'unknown top-level field "extra"'],
    [{ accepted: ['export-removed f'] }, 'accepted[0] must be an object'],
    [{ accepted: [{ export: 'f' }] }, 'accepted[0].code must be a non-empty string'],
    [{ accepted: [{ code: 'removed', export: 'f' }] }, 'accepted[0].code "removed" is not a known change code'],
    [{ accepted: [{ code: 'export-removed' }] }, 'accepted[0].export must be a non-empty string'],
    [{ accepted: [{ code: 'member-removed', export: 'C', member: 3 }] }, 'accepted[0].member must be a string'],
    [{ accepted: [{ code: 'export-removed', export: 'f', memebr: 'x' }] }, 'accepted[0] has unknown field "memebr"'],
  ])('%j', (contents, message) => {
    const { code, stdout, stderr } = cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline', baseline(contents));
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('semver-guard: ');
    expect(stderr).toContain(message);
  });

  it('reports a missing baseline file', () => {
    const missing = path.join(FIXTURES, 'no-such-baseline.json');
    const { code, stderr } = cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline', missing);
    expect(code).toBe(2);
    expect(stderr).toContain(`baseline file not found: ${missing}`);
  });

  it('requires a value', () => {
    const { code, stderr } = cli('compare', '--from', BEFORE, '--to', AFTER, '--baseline');
    expect(code).toBe(2);
    expect(stderr).toContain('option --baseline requires a value');
  });
});
