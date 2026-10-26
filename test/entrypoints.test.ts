import { describe, expect, it } from 'vitest';
import { extractApi, findEntryPoints } from '../src/extract.js';
import { run } from '../src/run.js';
import { diff, makeSnapshot } from './helpers.js';

const PKG = JSON.stringify({ name: 'lib', version: '1.0.0', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } });

const codes = (before: Record<string, string>, after: Record<string, string>) =>
  diff(before, after).changes.map((c) => `${c.code} ${c.file} ${c.export}`);

describe('entry-point-aware public surface', () => {
  const v1 = {
    'package.json': PKG,
    'src/index.ts': "export * from './strings.js';\nexport { Client } from './client.js';\n",
    'src/strings.ts': 'export function shout(text: string): string { return text.toUpperCase(); }\n',
    'src/client.ts': 'export class Client { connect(): void {} }\n',
  };

  it('does not flag a declaration moved to another module behind the same entry point', () => {
    const moved = {
      'package.json': PKG,
      'src/index.ts': "export * from './text/shout.js';\nexport { Client } from './client.js';\n",
      'src/text/shout.ts': 'export function shout(text: string): string { return text.toUpperCase(); }\n',
      'src/client.ts': 'export class Client { connect(): void {} }\n',
    };
    expect(codes(v1, moved)).toEqual([]);

    // Without package.json every module is public, so the same move is a removal.
    const withoutPkg = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'package.json'));
    expect(codes(withoutPkg(v1), withoutPkg(moved))).toEqual(['export-removed src/strings.ts shout']);
  });

  it('still flags an export removed from the entry point', () => {
    const removed = { ...v1, 'src/index.ts': "export { Client } from './client.js';\n" };
    expect(codes(v1, removed)).toEqual(['export-removed src/index.ts shout']);
  });

  it('flags changes to reachable declarations at the entry module', () => {
    const changed = { ...v1, 'src/client.ts': 'export class Client { connect(timeoutMs: number): void {} }\n' };
    const result = diff(v1, changed);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      code: 'member-changed',
      file: 'src/index.ts',
      export: 'Client',
      member: 'connect',
    });
  });

  it('ignores modules that are not reachable from an entry point', () => {
    const files = {
      ...v1,
      'src/internal/cache.ts': 'export function clear(all: boolean): void {}\n',
      'test/helpers.ts': 'export const fixture = 1;\n',
    };
    const changed = {
      ...v1,
      'src/internal/cache.ts': 'export function clear(): number { return 0; }\n',
    };
    expect(codes(files, changed)).toEqual([]);
    const surface = extractApi(makeSnapshot(files));
    expect(surface.entryPoints).toEqual(['src/index.ts']);
    expect(surface.files).toEqual(['src/client.ts', 'src/index.ts', 'src/strings.ts']);
    expect(surface.exports.map((e) => `${e.file} ${e.name}`)).toEqual(['src/index.ts Client', 'src/index.ts shout']);
  });

  it('follows type-only imports, import() types and namespace re-exports', () => {
    const files = {
      'package.json': JSON.stringify({ main: 'index.js' }),
      'index.ts': "export * as util from './util.js';\nexport type { Options } from './options.js';\nexport type Ref = import('./ref.js').Ref;\n",
      'util.ts': 'export function id<T>(x: T): T { return x; }\n',
      'options.ts': 'export interface Options { verbose?: boolean }\n',
      'ref.ts': 'export interface Ref { id: string }\n',
      'unused.ts': 'export const nope = 1;\n',
    };
    const surface = extractApi(makeSnapshot(files));
    expect(surface.files).toEqual(['index.ts', 'options.ts', 'ref.ts', 'util.ts']);
    expect(surface.exports.map((e) => e.name)).toEqual(['Options', 'Ref', 'util', 'util.id']);
  });

  it('treats every subpath export as an entry point', () => {
    const files = {
      'package.json': JSON.stringify({
        exports: {
          '.': './dist/index.js',
          './utils': { types: './dist/utils/index.d.ts', require: './dist/utils/index.cjs', default: './dist/utils/index.js' },
          './package.json': './package.json',
        },
      }),
      'src/index.ts': 'export const version = "1";\n',
      'src/utils/index.ts': 'export function noop(): void {}\n',
    };
    const before = files;
    const after = { ...files, 'src/utils/index.ts': 'export {};\n' };
    expect(codes(before, after)).toEqual(['export-removed src/utils/index.ts noop']);
  });

  it('behaves as before when there is no package.json', () => {
    const files = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' };
    const surface = extractApi(makeSnapshot(files));
    expect(surface.entryPoints).toBeUndefined();
    expect(surface.files).toEqual(['a.ts', 'b.ts']);
    expect(surface.exports.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('falls back to every module when the entry points cannot be resolved', () => {
    for (const pkg of [
      { name: 'no-entry-fields' },
      { main: './dist/missing.js' },
      { exports: { './*': './dist/*.js' } },
      'not json',
    ]) {
      const dir = makeSnapshot({
        'package.json': typeof pkg === 'string' ? pkg : JSON.stringify(pkg),
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
      });
      expect(findEntryPoints(dir)).toBeUndefined();
      expect(extractApi(dir).files).toEqual(['src/a.ts', 'src/b.ts']);
    }
  });

  it('can be turned off', () => {
    const surface = extractApi(makeSnapshot(v1), { entryPoints: false });
    expect(surface.entryPoints).toBeUndefined();
    expect(surface.files).toHaveLength(3);
  });

  it('uses every module on both sides when only one side has entry points', () => {
    const withoutPkg = Object.fromEntries(Object.entries(v1).filter(([name]) => name !== 'package.json'));
    let stdout = '';
    const code = run(['compare', '--from', makeSnapshot(withoutPkg), '--to', makeSnapshot(v1)], {
      stdout: (t) => (stdout += t),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toContain('(4 exports in 3 files checked)');
  });
});

describe('mapping package.json targets to sources', () => {
  const resolve = (pkg: object, files: Record<string, string>) =>
    findEntryPoints(makeSnapshot({ 'package.json': JSON.stringify(pkg), ...files }));
  const mod = 'export const x = 1;\n';

  it('maps compiled output back to sources', () => {
    expect(resolve({ main: './dist/index.js' }, { 'src/index.ts': mod })?.files).toEqual(['src/index.ts']);
    expect(resolve({ main: 'lib/main.cjs' }, { 'src/main.cts': mod })?.files).toEqual(['src/main.cts']);
    expect(resolve({ main: 'index.js' }, { 'index.ts': mod })?.files).toEqual(['index.ts']);
    expect(resolve({ main: './src' }, { 'src/index.ts': mod })?.files).toEqual(['src/index.ts']);
    expect(resolve({ exports: './index.ts' }, { 'index.ts': mod })?.files).toEqual(['index.ts']);
  });

  it('reads outDir and rootDir from tsconfig.json', () => {
    const tsconfig = '{\n  // comments are allowed\n  "compilerOptions": { "outDir": "./out/js", "rootDir": "./source" }\n}\n';
    expect(resolve({ main: './out/js/api.js' }, { 'tsconfig.json': tsconfig, 'source/api.ts': mod })?.files).toEqual([
      'source/api.ts',
    ]);
  });

  it('prefers sources over declaration files, and uses declaration files when there are no sources', () => {
    expect(
      resolve({ types: './dist/index.d.ts' }, { 'dist/index.d.ts': 'export declare const x: number;\n', 'src/index.ts': mod })?.files,
    ).toEqual(['src/index.ts']);
    expect(resolve({ main: './types/index.js' }, { 'types/index.d.ts': 'export declare const x: number;\n' })?.files).toEqual([
      'types/index.d.ts',
    ]);
  });

  it('uses exports instead of main when both are present, and lists unresolved targets', () => {
    const result = resolve(
      { main: './dist/legacy.js', exports: { '.': './dist/index.js', './features/*': './dist/features/*.js', './gone': './dist/gone.js' } },
      { 'src/index.ts': mod, 'src/legacy.ts': mod },
    );
    expect(result).toEqual({
      field: 'exports',
      files: ['src/index.ts'],
      unresolved: ['./dist/features/*.js', './dist/gone.js'],
    });
  });
});
