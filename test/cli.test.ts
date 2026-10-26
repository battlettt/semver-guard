import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
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

describe('semver-guard compare', () => {
  it('exits 1 and prints a table when breaking changes are found', () => {
    const { code, stdout, stderr } = cli('compare', '--from', BEFORE, '--to', AFTER);
    expect(code).toBe(1);
    expect(stderr).toBe('');
    const lines = stdout.split('\n');
    expect(lines[0]).toMatch(/^semver-guard: .*before -> .*after \(14 exports in 4 files checked\)$/);
    expect(lines[2]).toMatch(/^CHANGE\s+EXPORT\s+FILE\s+DETAILS$/);
    expect(stdout).toMatch(/member-removed\s+Client#disconnect\s+src\/client\.ts\s+method disconnect was removed/);
    expect(stdout).toMatch(/export-removed\s+legacyHelper\s+src\/legacy\.ts/);
    expect(stdout).toContain('before: (date: Date, locale: string): string');
    expect(stdout).toContain('after:  (date: Date, options: FormatOptions): string');
    expect(stdout).toContain('also re-exported by: src/index.ts');
    expect(stdout).toContain('6 breaking changes found.');
  });

  it('exits 0 when there are no breaking changes', () => {
    const { code, stdout } = cli('compare', '--from', BEFORE, '--to', BEFORE);
    expect(code).toBe(0);
    expect(stdout).toContain('No breaking changes found.');
  });

  it('treats additive-only releases as non-breaking', () => {
    const from = makeSnapshot({ 'index.ts': 'export function a(x: string) { return x; }' });
    const to = makeSnapshot({
      'index.ts': 'export function a(x: string, y?: number) { return x; }\nexport function b() {}',
    });
    expect(cli('compare', '--from', from, '--to', to).code).toBe(0);
  });

  it('prints machine-readable JSON with --format json', () => {
    const { code, stdout } = cli('compare', `--from=${BEFORE}`, `--to=${AFTER}`, '--format', 'json');
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(Object.keys(report)).toEqual(['from', 'to', 'summary', 'changes']);
    expect(report.from).toBe(BEFORE);
    expect(report.to).toBe(AFTER);
    expect(report.summary).toEqual({
      breaking: 6,
      filesBefore: 4,
      filesAfter: 4,
      exportsBefore: 14,
      exportsAfter: 16,
    });
    expect(report.changes).toHaveLength(6);
    for (const change of report.changes) {
      expect(typeof change.code).toBe('string');
      expect(typeof change.file).toBe('string');
      expect(typeof change.export).toBe('string');
      expect(typeof change.exportKind).toBe('string');
      expect(typeof change.message).toBe('string');
      for (const key of Object.keys(change)) {
        expect(['code', 'file', 'export', 'exportKind', 'member', 'message', 'before', 'after', 'reexportedBy']).toContain(key);
      }
    }
    expect(report.changes[0]).toEqual({
      code: 'member-removed',
      file: 'src/client.ts',
      export: 'Client',
      exportKind: 'class',
      member: 'disconnect',
      message: 'method disconnect was removed',
      before: 'disconnect(): void',
      reexportedBy: ['src/index.ts'],
    });
  });

  it('prints an empty change list in JSON when nothing broke', () => {
    const { code, stdout } = cli('compare', '--from', AFTER, '--to', AFTER, '--format', 'json');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ summary: { breaking: 0 }, changes: [] });
  });
});

describe('usage and I/O errors exit 2', () => {
  it.each([
    [[], 'missing command'],
    [['diff'], 'unknown command: diff'],
    [['compare', '--to', AFTER], 'missing required option --from'],
    [['compare', '--from', BEFORE], 'missing required option --to'],
    [['compare', '--from'], 'option --from requires a value'],
    [['compare', '--from', BEFORE, '--to', AFTER, '--format', 'xml'], 'invalid --format "xml"'],
    [['compare', '--from', BEFORE, '--to', AFTER, '--verbose'], 'unknown option: --verbose'],
    [['compare', '--from', BEFORE, '--from', BEFORE, '--to', AFTER], 'option --from was given more than once'],
    [['compare', 'extra', '--from', BEFORE, '--to', AFTER], 'unexpected argument: extra'],
  ])('%j', (argv, message) => {
    const { code, stdout, stderr } = cli(...argv);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(message);
    expect(stderr).toContain('Usage:');
  });

  it('reports a missing directory', () => {
    const { code, stderr } = cli('compare', '--from', path.join(FIXTURES, 'does-not-exist'), '--to', AFTER);
    expect(code).toBe(2);
    expect(stderr).toMatch(/directory not found: .*does-not-exist/);
  });

  it('reports a path that is not a directory', () => {
    const { code, stderr } = cli('compare', '--from', path.join(BEFORE, 'package.json'), '--to', AFTER);
    expect(code).toBe(2);
    expect(stderr).toContain('not a directory');
  });

  it('reports a directory without TypeScript files', () => {
    const empty = makeSnapshot({ 'README.md': '# nothing here' });
    const { code, stderr } = cli('compare', '--from', empty, '--to', AFTER);
    expect(code).toBe(2);
    expect(stderr).toContain('no TypeScript (.ts or .tsx) files found');
  });
});

describe('help and version', () => {
  it('prints help and exits 0', () => {
    expect(cli('--help')).toMatchObject({ code: 0, stdout: expect.stringContaining('semver-guard compare --from <dir> --to <dir>') });
    expect(cli('compare', '--help').code).toBe(0);
  });

  it('prints the package version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FIXTURES, '..', 'package.json'), 'utf8'));
    expect(cli('--version')).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });
});

const BIN = path.join(FIXTURES, '..', 'dist', 'cli.js');

describe.skipIf(!fs.existsSync(BIN))('built executable (requires npm run build)', () => {
  it('runs as a node process with the documented exit codes', () => {
    const breaking = spawnSync(process.execPath, [BIN, 'compare', '--from', BEFORE, '--to', AFTER, '--format', 'json'], {
      encoding: 'utf8',
    });
    expect(breaking.status).toBe(1);
    expect(JSON.parse(breaking.stdout).summary.breaking).toBe(6);

    const clean = spawnSync(process.execPath, [BIN, 'compare', '--from', AFTER, '--to', AFTER], { encoding: 'utf8' });
    expect(clean.status).toBe(0);

    const usage = spawnSync(process.execPath, [BIN, 'compare'], { encoding: 'utf8' });
    expect(usage.status).toBe(2);
  });
});
