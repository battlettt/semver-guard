import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { makeSnapshot } from './helpers.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

/** Test-only identity and settings, so the tests do not depend on the user's git config. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'semver-guard tests',
  GIT_AUTHOR_EMAIL: 'tests@example.invalid',
  GIT_COMMITTER_NAME: 'semver-guard tests',
  GIT_COMMITTER_EMAIL: 'tests@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** Writes `files` into `dir` and commits them. */
function commit(dir: string, message: string, files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * A repository with two commits: `v1` and then `v2`, where v2 changes the
 * signature of `greet` and removes `farewell`.
 */
function makeRepo(): string {
  const dir = makeSnapshot({});
  git(dir, 'init', '-q');
  commit(dir, 'v1', {
    'src/index.ts': `export function greet(name: string): string { return 'hi ' + name; }
export function farewell(): void {}
`,
  });
  git(dir, 'tag', 'v1');
  commit(dir, 'v2', {
    'src/index.ts': `export function greet(name: string, punctuation: string): string { return 'hi ' + name + punctuation; }
`,
  });
  git(dir, 'tag', 'v2');
  return dir;
}

function cli(cwd: string, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd });
  return { code, stdout, stderr };
}

const refSnapshotDirs = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('semver-guard-ref-'));

describe.skipIf(!hasGit)('git ref inputs', () => {
  it('flags breaking changes between two tags', () => {
    const repo = makeRepo();
    const { code, stdout, stderr } = cli(repo, 'compare', '--from-ref', 'v1', '--to-ref', 'v2', '--format', 'json');
    expect(stderr).toBe('');
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.from).toBe('v1');
    expect(report.to).toBe('v2');
    expect(report.changes.map((c: { code: string; export: string }) => `${c.code} ${c.export}`)).toEqual([
      'export-removed farewell',
      'signature-changed greet',
    ]);
    expect(report.changes[1].message).toBe('required parameter punctuation was added');
  });

  it('accepts commit SHAs, branch names and relative refs', () => {
    const repo = makeRepo();
    const first = git(repo, 'rev-parse', 'HEAD~1');
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(cli(repo, 'compare', '--from-ref', first, '--to-ref', branch).code).toBe(1);
    expect(cli(repo, 'compare', '--from-ref=HEAD~1', '--to-ref=HEAD').stdout).toContain('2 breaking changes found.');
    expect(cli(repo, 'compare', '--from-ref', 'v2', '--to-ref', 'HEAD').code).toBe(0);
  });

  it('compares the subdirectory the command runs in', () => {
    const repo = makeSnapshot({});
    git(repo, 'init', '-q');
    commit(repo, 'v1', {
      'packages/lib/index.ts': 'export const answer: number = 42;\n',
      'packages/other/index.ts': 'export const unrelated = 1;\n',
    });
    commit(repo, 'v2', {
      'packages/lib/index.ts': 'export const answer: string = "42";\n',
      'packages/other/index.ts': 'export {};\n',
    });
    const { code, stdout } = cli(path.join(repo, 'packages', 'lib'), 'compare', '--from-ref', 'HEAD~1', '--to-ref', 'HEAD');
    expect(code).toBe(1);
    expect(stdout).toMatch(/type-changed\s+answer\s+index\.ts/);
    expect(stdout).not.toContain('unrelated');
  });

  it('allows a ref on one side and a directory on the other', () => {
    const repo = makeRepo();
    // The working copy is at v2; restore farewell there without committing.
    fs.writeFileSync(
      path.join(repo, 'src', 'index.ts'),
      `export function greet(name: string, punctuation?: string): string { return 'hi ' + name; }
export function farewell(): void {}
`,
    );
    expect(cli(repo, 'compare', '--from-ref', 'v1', '--to', path.join(repo, 'src')).code).toBe(1);
    const fromRoot = cli(repo, 'compare', '--from-ref', 'v1', '--to', repo);
    expect(fromRoot.stdout).toContain('No breaking changes found.');
    expect(fromRoot.code).toBe(0);
  });

  it('removes the temporary snapshots afterwards', () => {
    const repo = makeRepo();
    const before = new Set(refSnapshotDirs());
    cli(repo, 'compare', '--from-ref', 'v1', '--to-ref', 'v2');
    cli(repo, 'compare', '--from-ref', 'v1', '--to-ref', 'no-such-ref');
    expect(refSnapshotDirs().filter((name) => !before.has(name))).toEqual([]);
  });

  it('reports an unknown ref', () => {
    const repo = makeRepo();
    const { code, stdout, stderr } = cli(repo, 'compare', '--from-ref', 'v0', '--to-ref', 'v2');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown git ref: v0');
  });

  it('rejects mixing a ref and a directory for the same side', () => {
    const repo = makeRepo();
    for (const [argv, message] of [
      [['--from', repo, '--from-ref', 'v1', '--to-ref', 'v2'], '--from and --from-ref cannot be used together'],
      [['--from-ref', 'v1', '--to', repo, '--to-ref=v2'], '--to and --to-ref cannot be used together'],
      [['--to-ref', 'v2'], 'missing required option --from (or --from-ref)'],
    ] as const) {
      const { code, stderr } = cli(repo, 'compare', ...argv);
      expect(code).toBe(2);
      expect(stderr).toContain(message);
      expect(stderr).toContain('Usage:');
    }
  });

  it('requires a git repository when refs are given', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-guard-norepo-'));
    try {
      const { code, stdout, stderr } = cli(notARepo, 'compare', '--from-ref', 'v1', '--to-ref', 'v2');
      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toContain('is not inside a git work tree');
      expect(stderr).toContain('Usage:');
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
