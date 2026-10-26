import { describe, expect, it } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi } from '../src/extract.js';
import type { CompareResult } from '../src/model.js';
import { makeSnapshot } from './helpers.js';

/** Compares two single-file snapshots with the given type comparison mode. */
function compare(before: string, after: string, typeComparison: 'assignability' | 'text' = 'assignability'): CompareResult {
  return compareSurfaces(
    extractApi(makeSnapshot({ 'index.ts': before })),
    extractApi(makeSnapshot({ 'index.ts': after })),
    { from: 'before', to: 'after' },
    { typeComparison },
  );
}

const messages = (before: string, after: string, mode?: 'assignability' | 'text') =>
  compare(before, after, mode).changes.map((c) => c.message);

describe('parameter types (old type must be assignable to the new one)', () => {
  it('allows widening a parameter from string to string | number', () => {
    expect(messages('export function f(a: string) {}', 'export function f(a: string | number) {}')).toEqual([]);
  });

  it('allows adding a member to a union parameter', () => {
    expect(
      messages(
        "export function setMode(mode: 'light' | 'dark') {}",
        "export function setMode(mode: 'light' | 'dark' | 'system') {}",
      ),
    ).toEqual([]);
  });

  it('allows widening to unknown and to a supertype object', () => {
    expect(messages('export function f(a: string) {}', 'export function f(a: unknown) {}')).toEqual([]);
    expect(
      messages(
        'export function f(a: { id: string; name: string }) {}',
        'export function f(a: { id: string }) {}',
      ),
    ).toEqual([]);
  });

  it('flags narrowing a parameter from string | number to string', () => {
    expect(messages('export function f(a: string | number) {}', 'export function f(a: string) {}')).toEqual([
      'type of parameter a changed from string | number to string',
    ]);
  });

  it('flags removing a member from a union parameter', () => {
    expect(
      messages(
        "export function setMode(mode: 'light' | 'dark' | 'system') {}",
        "export function setMode(mode: 'light' | 'dark') {}",
      ),
    ).toEqual(["type of parameter mode changed from 'light' | 'dark' | 'system' to 'light' | 'dark'"]);
  });

  it('flags an unrelated parameter type', () => {
    expect(messages('export function f(a: string) {}', 'export function f(a: number) {}')).toEqual([
      'type of parameter a changed from string to number',
    ]);
  });

  it('applies to class methods and constructors', () => {
    expect(
      messages(
        'export class C { constructor(a: string) {} m(a: string): void {} }',
        'export class C { constructor(a: string | number) {} m(a: string | number): void {} }',
      ),
    ).toEqual([]);
    const r = compare(
      'export class C { constructor(a: string | number) {} m(a: string | number): void {} }',
      'export class C { constructor(a: string) {} m(a: string): void {} }',
    );
    expect(r.changes.map((c) => `${c.code} ${c.member}`)).toEqual([
      'signature-changed constructor',
      'member-changed m',
    ]);
  });
});

describe('return types (new type must be assignable to the old one)', () => {
  it('allows narrowing a return type from string | number to string', () => {
    expect(
      messages(
        'export function f(): string | number { return 1; }',
        "export function f(): string { return ''; }",
      ),
    ).toEqual([]);
  });

  it('allows narrowing an inferred return type', () => {
    expect(
      messages(
        'export function f(a: string | number) { return a; }',
        'export function f(a: string | number) { return String(a); }',
      ),
    ).toEqual([]);
  });

  it('flags widening a return type from string to string | number', () => {
    expect(
      messages(
        "export function f(): string { return ''; }",
        'export function f(): string | number { return 1; }',
      ),
    ).toEqual(['return type changed from string to string | number']);
  });

  it('flags widening a return type from string to string | undefined', () => {
    expect(
      messages(
        "export function f(): string { return ''; }",
        'export function f(): string | undefined { return undefined; }',
      ),
    ).toEqual(['return type changed from string to string | undefined']);
  });
});

describe('properties', () => {
  it('allows a readonly class property to narrow but flags it widening', () => {
    expect(
      messages(
        'export class C { readonly p: string | number = 1; }',
        "export class C { readonly p: string = ''; }",
      ),
    ).toEqual([]);
    expect(
      messages(
        "export class C { readonly p: string = ''; }",
        'export class C { readonly p: string | number = 1; }',
      ),
    ).toEqual(['type changed from string to string | number']);
  });

  it('requires writable and interface properties to keep an equivalent type', () => {
    expect(
      messages('export class C { p: string | number = 1; }', "export class C { p: string = ''; }"),
    ).toEqual(['type changed from string | number to string']);
    expect(
      messages('export interface I { p: string }', 'export interface I { p: string | number }'),
    ).toEqual(['type changed from string to string | number']);
    expect(messages('export interface I { p: string[] }', 'export interface I { p: Array<string> }')).toEqual([]);
  });
});

describe('interface method return types are invariant', () => {
  it('flags a narrower return type, because implementations would break', () => {
    expect(
      messages(
        'export interface I { m(): string | number }',
        'export interface I { m(): string }',
      ),
    ).toEqual(['return type changed from string | number to string']);
  });

  it('allows a wider method parameter', () => {
    expect(
      messages('export interface I { m(a: string): void }', 'export interface I { m(a: string | number): void }'),
    ).toEqual([]);
  });
});

describe('interface call signatures are invariant', () => {
  it('flags a wider parameter, because implementations would break', () => {
    expect(
      messages('export interface I { (a: string): void }', 'export interface I { (a: string | number): void }'),
    ).toEqual(['type of parameter a changed from string to string | number']);
  });
});

describe('overloads', () => {
  it('allows merging overloads into one signature that accepts all of them', () => {
    expect(
      messages(
        'export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a: any) {}',
        'export function f(a: string | number): void {}',
      ),
    ).toEqual([]);
  });
});

describe('parameter count rules are unchanged', () => {
  it('allows an added optional parameter, flags an added required one and a removed one', () => {
    expect(messages('export function f(a: string) {}', 'export function f(a: string, b?: number) {}')).toEqual([]);
    expect(messages('export function f(a: string) {}', 'export function f(a: string, b: number) {}')).toEqual([
      'required parameter b was added',
    ]);
    expect(messages('export function f(a: string, b: number) {}', 'export function f(a: string) {}')).toEqual([
      'parameter b was removed',
    ]);
  });
});

describe('compared with the text comparison', () => {
  const cases: Array<[string, string, string]> = [
    ['parameter widening', 'export function f(a: string) {}', 'export function f(a: string | number) {}'],
    ['return narrowing', 'export function f(): string | number { return 1; }', "export function f(): string { return ''; }"],
    ['equivalent spelling', 'export function f(a: Array<string>): void {}', 'export function f(a: string[]): void {}'],
    [
      'renamed but identical type',
      'export interface Options { verbose: boolean }\nexport function f(o: Options) {}',
      'export interface Options { verbose: boolean }\nexport type Settings = Options;\nexport function f(o: Settings) {}',
    ],
  ];

  it('README example: several compatible changes in one declaration', () => {
    const before = `export interface Options { verbose: boolean }
export declare function run(files: Array<string>, options: Options): string | number;`;
    const after = `export interface Options { verbose: boolean }
export type Settings = Options;
export declare function run(files: string[] | ReadonlySet<string>, options: Settings): string;`;
    expect(compare(before, after, 'text').changes).toHaveLength(1);
    expect(compare(before, after).changes).toEqual([]);
  });

  for (const [name, before, after] of cases) {
    it(`${name}: flagged by text, not by assignability`, () => {
      expect(compare(before, after, 'text').changes).toHaveLength(1);
      expect(compare(before, after).changes).toEqual([]);
    });
  }

  it('reports the same breaking changes as text when the change really is breaking', () => {
    const before = 'export function f(a: string | number): string { return String(a); }';
    const after = 'export function f(a: string): string | number { return a; }';
    expect(messages(before, after)).toEqual(messages(before, after, 'text'));
    expect(messages(before, after)).toEqual([
      'type of parameter a changed from string | number to string; return type changed from string to string | number',
    ]);
  });
});

describe('falls back to the text comparison', () => {
  it('when the old type no longer resolves in the new version', () => {
    expect(
      messages(
        'interface Old { x: number }\nexport function f(a: Old) {}',
        'interface New { x: number }\nexport function f(a: New) {}',
      ),
    ).toEqual(['type of parameter a changed from Old to New']);
  });

  it('when either type involves any', () => {
    expect(messages('export function f(a: any) {}', 'export function f(a: unknown) {}')).toEqual([
      'type of parameter a changed from any to unknown',
    ]);
    expect(messages('export function f(): string { return ""; }', 'export function f(): any { return 1; }')).toEqual([
      'return type changed from string to any',
    ]);
  });
});
