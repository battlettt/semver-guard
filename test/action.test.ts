import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ACTION_ENV,
  ACTION_INPUT_NAMES,
  actionInvocation,
  escapeCommandData,
  readActionInputs,
  runAction,
  shellQuote,
  stepSummary,
  type ActionInputs,
} from '../src/action.js';
import { FIXTURES, makeSnapshot } from './helpers.js';

const ROOT = path.resolve(FIXTURES, '..');
const WORKSPACE = '/home/runner/work/lib/lib';

function args(inputs: ActionInputs): string[] {
  return actionInvocation(inputs, WORKSPACE).args;
}

/** Environment that `action.yml` would pass for `inputs` (with the action.yml defaults for omitted inputs). */
function envFor(inputs: Record<string, string>, workspace = ROOT): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GITHUB_WORKSPACE: workspace };
  for (const [key, name] of Object.entries(ACTION_INPUT_NAMES) as [keyof ActionInputs, string][]) {
    env[ACTION_ENV[key]] = inputs[name] ?? (name === 'format' ? 'table' : name === 'working-directory' ? '.' : '');
  }
  return env;
}

function action(inputs: Record<string, string>, workspace = ROOT) {
  let stdout = '';
  let stderr = '';
  const summaries: string[] = [];
  const code = runAction(envFor(inputs, workspace), {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    appendSummary: (md) => summaries.push(md),
  });
  return { code, stdout, stderr, summaries };
}

describe('action input mapping', () => {
  it('maps directory inputs', () => {
    expect(args({ from: 'old', to: 'new' })).toEqual(['compare', '--from=old', '--to=new', '--format=table']);
  });

  it('maps git ref inputs', () => {
    expect(args({ fromRef: 'origin/main', toRef: '3f2c1ab' })).toEqual([
      'compare',
      '--from-ref=origin/main',
      '--to-ref=3f2c1ab',
      '--format=table',
    ]);
  });

  it('allows a ref on one side and a directory on the other', () => {
    expect(args({ fromRef: 'v1.4.0', to: '.' })).toEqual(['compare', '--from-ref=v1.4.0', '--to=.', '--format=table']);
    expect(args({ from: 'old', toRef: 'HEAD' })).toEqual(['compare', '--from=old', '--to-ref=HEAD', '--format=table']);
  });

  it('adds --baseline and the given format', () => {
    expect(args({ fromRef: 'v1', toRef: 'HEAD', baseline: 'semver-baseline.json', format: 'json' })).toEqual([
      'compare',
      '--from-ref=v1',
      '--to-ref=HEAD',
      '--baseline=semver-baseline.json',
      '--format=json',
    ]);
  });

  it('treats empty and whitespace-only inputs as not given, and trims values', () => {
    expect(
      args({ from: '', fromRef: '  v1 ', to: ' new\t', toRef: '   ', baseline: ' ', format: '' }),
    ).toEqual(['compare', '--from-ref=v1', '--to=new', '--format=table']);
  });

  it('passes the format through for the CLI to validate', () => {
    expect(args({ from: 'a', to: 'b', format: 'xml' })).toEqual(['compare', '--from=a', '--to=b', '--format=xml']);
  });

  it('keeps values that look like options attached to their option', () => {
    expect(args({ from: '--weird dir', to: '-x' })).toEqual(['compare', '--from=--weird dir', '--to=-x', '--format=table']);
  });

  it('rejects a directory and a ref for the same side', () => {
    expect(() => args({ from: 'a', fromRef: 'v1', to: 'b' })).toThrow(
      'inputs from and from-ref cannot both be set (set from or from-ref)',
    );
    expect(() => args({ from: 'a', to: 'b', toRef: 'HEAD' })).toThrow('inputs to and to-ref cannot both be set');
  });

  it('requires both sides', () => {
    expect(() => args({ to: 'b' })).toThrow('one of the inputs from or from-ref is required');
    expect(() => args({ fromRef: 'v1' })).toThrow('one of the inputs to or to-ref is required');
    expect(() => args({})).toThrow('one of the inputs from or from-ref is required');
  });

  it('rejects multi-line values', () => {
    expect(() => args({ from: 'a\nb', to: 'c' })).toThrow('input from must be a single line');
    expect(() => args({ from: 'a', to: 'c', baseline: 'x\r\ny' })).toThrow('input baseline must be a single line');
  });

  it('resolves working-directory against the workspace', () => {
    expect(actionInvocation({ from: 'a', to: 'b' }, WORKSPACE).cwd).toBe(WORKSPACE);
    expect(actionInvocation({ from: 'a', to: 'b', workingDirectory: '.' }, WORKSPACE).cwd).toBe(WORKSPACE);
    expect(actionInvocation({ from: 'a', to: 'b', workingDirectory: 'packages/lib/' }, WORKSPACE).cwd).toBe(
      path.join(WORKSPACE, 'packages', 'lib'),
    );
    expect(actionInvocation({ from: 'a', to: 'b', workingDirectory: '/abs/pkg' }, WORKSPACE).cwd).toBe(
      path.resolve('/abs/pkg'),
    );
  });

  it('reads the inputs from their environment variables', () => {
    expect(
      readActionInputs({
        SEMVER_GUARD_FROM: '',
        SEMVER_GUARD_TO: 'new',
        SEMVER_GUARD_FROM_REF: 'v1',
        SEMVER_GUARD_BASELINE: 'b.json',
        SEMVER_GUARD_FORMAT: 'json',
        SEMVER_GUARD_WORKING_DIRECTORY: 'pkg',
        UNRELATED: 'x',
      }),
    ).toEqual({ from: '', to: 'new', fromRef: 'v1', baseline: 'b.json', format: 'json', workingDirectory: 'pkg' });
    expect(args(readActionInputs(envFor({ 'from-ref': 'v1', 'to-ref': 'HEAD' })))).toEqual([
      'compare',
      '--from-ref=v1',
      '--to-ref=HEAD',
      '--format=table',
    ]);
  });
});

describe('action helpers', () => {
  it('quotes arguments for display', () => {
    expect(shellQuote('--from-ref=origin/main')).toBe('--from-ref=origin/main');
    expect(shellQuote('--from=my dir')).toBe(`'--from=my dir'`);
    expect(shellQuote(`--to=it's`)).toBe(`'--to=it'\\''s'`);
  });

  it('escapes workflow command data', () => {
    expect(escapeCommandData('50% done\r\nnext')).toBe('50%25 done%0D%0Anext');
  });

  it('puts the report in a fenced block in the summary', () => {
    expect(stepSummary(0, 'No breaking changes found.\n')).toBe(
      '### semver-guard: no breaking changes\n\n```\nNo breaking changes found.\n```\n',
    );
    expect(stepSummary(1, 'a ``` b\n')).toBe('### semver-guard: breaking changes found\n\n~~~~\na ``` b\n~~~~\n');
  });
});

describe('runAction', () => {
  it('fails with exit code 1, an error annotation and the table when there are breaking changes', () => {
    const { code, stdout, stderr, summaries } = action({ from: 'fixtures/before', to: 'fixtures/after' });
    expect(code).toBe(1);
    expect(stderr).toBe('');
    const lines = stdout.split('\n');
    expect(lines[0]).toBe('$ semver-guard compare --from=fixtures/before --to=fixtures/after --format=table');
    expect(stdout).toMatch(/member-removed\s+Client#disconnect/);
    expect(stdout).toContain(
      '::error title=semver-guard::6 breaking changes found. Bump the major version, restore compatibility, or accept the changes in a baseline file.\n',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/^### semver-guard: breaking changes found\n\n```\nsemver-guard: fixtures\/before -> fixtures\/after/);
  });

  it('passes with exit code 0 and no annotation when there are none', () => {
    const { code, stdout, summaries } = action({ from: 'fixtures/after', to: 'fixtures/after' });
    expect(code).toBe(0);
    expect(stdout).toContain('No breaking changes found.');
    expect(stdout).not.toContain('::error');
    expect(summaries[0]).toMatch(/^### semver-guard: no breaking changes/);
  });

  it('counts breaking changes from the JSON report', () => {
    const { code, stdout } = action({ from: 'fixtures/before', to: 'fixtures/after', format: 'json' });
    expect(code).toBe(1);
    const report = stdout.slice(stdout.indexOf('\n') + 1, stdout.indexOf('::error'));
    expect(JSON.parse(report).summary.breaking).toBe(6);
    expect(stdout).toContain('::error title=semver-guard::6 breaking changes found.');
  });

  it('applies the baseline input relative to working-directory', () => {
    const pkg = makeSnapshot({
      'old/index.ts': 'export function a() {}\nexport function b() {}\n',
      'new/index.ts': 'export function a() {}\n',
      'semver-baseline.json': JSON.stringify({ accepted: [{ code: 'export-removed', export: 'b' }] }),
    });
    const workspace = path.dirname(pkg);
    const dir = path.basename(pkg);
    expect(action({ from: 'old', to: 'new', 'working-directory': dir }, workspace).code).toBe(1);
    const { code, stdout } = action({ from: 'old', to: 'new', baseline: 'semver-baseline.json', 'working-directory': dir }, workspace);
    expect(code).toBe(0);
    expect(stdout).toContain(`  (in ${pkg})\n`);
    expect(stdout).toContain('No breaking changes found.');
  });

  it('reports input errors as an annotation with exit code 2, without running the CLI', () => {
    const { code, stdout, summaries } = action({ from: 'fixtures/before', 'from-ref': 'v1', to: 'fixtures/after' });
    expect(code).toBe(2);
    expect(stdout).toBe('::error title=semver-guard::inputs from and from-ref cannot both be set (set from or from-ref)\n');
    expect(summaries).toEqual([]);
  });

  it('reports CLI errors as an annotation with exit code 2', () => {
    const { code, stdout, stderr } = action({ from: 'fixtures/missing', to: 'fixtures/after' });
    expect(code).toBe(2);
    expect(stderr).toMatch(/^semver-guard: .*fixtures\/missing/);
    expect(stdout).toMatch(/::error title=semver-guard::semver-guard: .*fixtures\/missing.*\n$/);

    const format = action({ from: 'fixtures/after', to: 'fixtures/after', format: 'xml' });
    expect(format.code).toBe(2);
    expect(format.stdout).toContain('::error title=semver-guard::semver-guard: invalid --format "xml" (expected "table" or "json")');
  });

  it('reports a missing working-directory', () => {
    const { code, stdout } = action({ from: 'a', to: 'b', 'working-directory': 'does/not/exist' });
    expect(code).toBe(2);
    expect(stdout).toContain(`::error title=semver-guard::working-directory ${path.join(ROOT, 'does/not/exist')} does not exist`);
  });

  it('restores the current directory', () => {
    const before = process.cwd();
    action({ from: 'fixtures/after', to: 'fixtures/after', 'working-directory': 'fixtures' });
    expect(process.cwd()).toBe(before);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe.skipIf(!hasGit)('runAction with git refs', () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'semver-guard tests',
    GIT_AUTHOR_EMAIL: 'tests@example.invalid',
    GIT_COMMITTER_NAME: 'semver-guard tests',
    GIT_COMMITTER_EMAIL: 'tests@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd: string, ...gitArgs: string[]) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...gitArgs], { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed: ${result.stderr}`);
  };

  it('compares working-directory at each ref, like the release-gate example', () => {
    const repo = makeSnapshot({
      'packages/lib/src/index.ts': 'export function greet(name: string): string | number { return name; }\nexport function bye() {}\n',
      'packages/other/src/index.ts': 'export const x = 1;\n',
    });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'packages/lib/src/index.ts'), 'export function greet(name: string | number): string | number { return name; }\n');
    fs.writeFileSync(path.join(repo, 'packages/other/src/index.ts'), '');
    git(repo, 'commit', '-q', '-am', 'change');

    const { code, stdout } = action({ 'from-ref': 'main', 'to-ref': 'HEAD', format: 'json', 'working-directory': 'packages/lib' }, repo);
    expect(code).toBe(1);
    const report = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1));
    expect(report.changes.map((c: { code: string; export: string }) => `${c.code} ${c.export}`)).toEqual(['export-removed bye']);
  });
});

describe('action.yml', () => {
  const manifest = parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
  const steps: { name?: string; run?: string; env?: Record<string, string>; 'working-directory'?: string }[] = manifest.runs.steps;

  it('is a composite action with the documented inputs and defaults', () => {
    expect(manifest.runs.using).toBe('composite');
    expect(Object.keys(manifest.inputs).sort()).toEqual(Object.values(ACTION_INPUT_NAMES).sort());
    for (const input of Object.values(manifest.inputs) as { required: boolean; description: string }[]) {
      expect(input.required).toBe(false);
      expect(input.description.length).toBeGreaterThan(0);
    }
    expect(manifest.inputs.format.default).toBe('table');
    expect(manifest.inputs['working-directory'].default).toBe('.');
  });

  it('builds from source in its own checkout', () => {
    const build = steps.find((step) => step.run?.includes('npm ci'));
    expect(build?.['working-directory']).toBe('${{ github.action_path }}');
    expect(build?.run).toContain('npm run build');
  });

  it('passes every input to the mapping module through its environment variable', () => {
    const compare = steps[steps.length - 1];
    expect(compare.run).toBe('node "$GITHUB_ACTION_PATH/dist/action-cli.js"');
    const expected = Object.fromEntries(
      (Object.keys(ACTION_ENV) as (keyof ActionInputs)[]).map((key) => [ACTION_ENV[key], `\${{ inputs.${ACTION_INPUT_NAMES[key]} }}`]),
    );
    expect(compare.env).toEqual(expected);
  });

  it('never expands inputs inside a shell script', () => {
    for (const step of steps) {
      expect((step as { shell?: string }).shell).toBe('bash');
      expect(step.run).not.toMatch(/\$\{\{/);
    }
  });

  it('runs the file that npm run build produces', () => {
    expect(fs.existsSync(path.join(ROOT, 'src', 'action-cli.ts'))).toBe(true);
  });
});

describe('examples/release-gate.yml', () => {
  const workflow = parse(fs.readFileSync(path.join(ROOT, 'examples', 'release-gate.yml'), 'utf8'));
  const inputs = Object.keys(parse(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8')).inputs);

  it('runs on pull requests with full history and the local action', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    const steps: { uses?: string; with?: Record<string, unknown> }[] = workflow.jobs['api-compatibility'].steps;
    expect(steps[0]).toEqual({ uses: 'actions/checkout@v4', with: { 'fetch-depth': 0 } });
    const gate = steps.find((step) => step.uses === './');
    expect(gate?.with).toEqual({
      'from-ref': 'origin/${{ github.base_ref }}',
      'to-ref': '${{ github.event.pull_request.head.sha }}',
    });
    for (const key of Object.keys(gate?.with ?? {})) expect(inputs).toContain(key);
  });
});

const ACTION_BIN = path.join(ROOT, 'dist', 'action-cli.js');

describe.skipIf(!fs.existsSync(ACTION_BIN))('built action entry point (requires npm run build)', () => {
  const exec = (inputs: Record<string, string>) =>
    spawnSync(process.execPath, [ACTION_BIN], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...envFor(inputs) },
      encoding: 'utf8',
    });

  it('exits 1 on breaking changes and 0 without', () => {
    const breaking = exec({ from: 'fixtures/before', to: 'fixtures/after' });
    expect(breaking.status).toBe(1);
    expect(breaking.stdout).toContain('6 breaking changes found.');
    expect(breaking.stdout).toContain('::error title=semver-guard::');
    const clean = exec({ from: 'fixtures/after', to: 'fixtures/after' });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('No breaking changes found.');
  });

  it('writes the job summary file', () => {
    const summary = path.join(makeSnapshot({}), 'summary.md');
    const result = spawnSync(process.execPath, [ACTION_BIN], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary, ...envFor({ from: 'fixtures/after', to: 'fixtures/after' }) },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/^### semver-guard: no breaking changes\n/);
  });
});
