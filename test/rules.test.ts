import { describe, expect, it } from 'vitest';
import { diff } from './helpers.js';

const codes = (before: string | Record<string, string>, after: string | Record<string, string>) =>
  diff(before, after).changes.map((c) => (c.member ? `${c.code} ${c.export}#${c.member}` : `${c.code} ${c.export}`));

describe('functions', () => {
  it('flags removed, renamed and retyped parameters and return type changes', () => {
    const r = diff(
      'export function f(a: string, b: number, c?: boolean): string { return a; }',
      'export function f(x: string, b: string): number { return 1; }',
    );
    expect(r.changes).toHaveLength(1);
    const msg = r.changes[0].message;
    expect(msg).toContain('parameter a was renamed to x');
    expect(msg).toContain('type of parameter b changed from number to string');
    expect(msg).toContain('parameter c was removed');
    expect(msg).toContain('return type changed from string to number');
  });

  it('flags an added required parameter and a parameter becoming required', () => {
    expect(diff('export function f(a: string) {}', 'export function f(a: string, b: number) {}').changes[0].message).toBe(
      'required parameter b was added',
    );
    expect(diff('export function f(a?: string) {}', 'export function f(a: string) {}').changes[0].message).toBe(
      'parameter a became required',
    );
  });

  it('allows added optional, defaulted and rest parameters, and required -> optional', () => {
    expect(codes('export function f(a: string) {}', 'export function f(a: string, b?: number, c = 1, ...d: string[]) {}')).toEqual([]);
    expect(codes('export function f(a: string) {}', 'export function f(a?: string) {}')).toEqual([]);
  });

  it('compares inferred return types', () => {
    expect(diff('export function f() { return 1; }', 'export function f() { return "x"; }').changes[0].message).toBe(
      'return type changed from number to string',
    );
    expect(codes('export function f() { const x = 1; return x + 1; }', 'export function f() { return 2 * 3; }')).toEqual([]);
  });

  it('treats arrow functions assigned to exported consts as functions', () => {
    expect(
      diff('export const add = (a: number, b: number) => a + b;', 'export const add = (a: number) => a;').changes[0].message,
    ).toBe('parameter b was removed');
  });

  it('requires every old overload to remain supported', () => {
    const before = `export function p(x: string): string;
      export function p(x: number): number;
      export function p(x: any) { return x; }`;
    expect(codes(before, before + '\n')).toEqual([]);
    const added = before.replace('export function p(x: any)', 'export function p(x: boolean): boolean;\nexport function p(x: any)');
    expect(codes(before, added)).toEqual([]);
    const removed = `export function p(x: string): string;
      export function p(x: any) { return x; }`;
    const r = diff(before, removed);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].message).toContain('overload (x: number): number is no longer supported');
  });

  it('flags type parameter changes but allows added defaulted type parameters', () => {
    expect(codes('export function id<T>(x: T): T { return x; }', 'export function id<T, U = T>(x: T): T { return x; }')).toEqual([]);
    expect(diff('export function id<T>(x: T): T { return x; }', 'export function id<T, U>(x: T): T { return x; }').changes[0].message).toBe(
      'required type parameter U was added',
    );
    expect(
      diff('export function id<T>(x: T): T { return x; }', 'export function id<T extends string>(x: T): T { return x; }').changes[0].message,
    ).toBe('constraint of type parameter T changed from (none) to string');
  });
});

describe('exports', () => {
  it('flags a removed export and a kind change', () => {
    expect(codes('export const a = 1; export function b() {}', 'export const a = 1;')).toEqual(['export-removed b']);
    expect(codes('export class A {}', 'export interface A {}')).toEqual(['kind-changed A']);
  });

  it('does not flag new exports or new files', () => {
    expect(codes({ 'a.ts': 'export const a = 1;' }, { 'a.ts': 'export const a = 1; export const b = 2;', 'b.ts': 'export type B = string;' })).toEqual([]);
  });

  it('flags all exports of a deleted module', () => {
    expect(codes({ 'a.ts': 'export const a = 1;', 'b.ts': 'export const b = 2;' }, { 'a.ts': 'export const a = 1;' })).toEqual([
      'export-removed b',
    ]);
  });

  it('ignores non-exported declarations entirely', () => {
    expect(codes('function helper(a: string) {}\nclass Internal { x = 1 }\nexport const v = 1;', 'function helper() {}\nexport const v = 1;')).toEqual([]);
  });

  it('flags changed variable types', () => {
    expect(diff('export let limit: number = 1;', 'export let limit: string = "1";').changes[0]).toMatchObject({
      code: 'type-changed',
      before: 'number',
      after: 'string',
    });
  });

  it('handles default exports and local aliases', () => {
    expect(codes('export default function main(a: string) {}', 'export default function main(a: string) {}')).toEqual([]);
    expect(codes('export default function main(a: string) {}', 'export default function main() {}')).toEqual(['signature-changed default']);
    expect(codes('function x() {}\nexport { x as y };', 'function x() {}\nexport { x as z };')).toEqual(['export-removed y']);
  });

  it('reports a namespace removal once and compares namespace members', () => {
    const ns = 'export namespace Util { export function a(x: string) {} export const b = 1; }';
    expect(codes(ns, 'export const other = 1;')).toEqual(['export-removed Util']);
    expect(codes(ns, 'export namespace Util { export function a(x: number) {} }')).toEqual([
      'signature-changed Util.a',
      'export-removed Util.b',
    ]);
  });

  it('reports re-exported declaration changes once, at the declaration', () => {
    const r = diff(
      { 'impl.ts': 'export function f(a: string) {}', 'index.ts': "export { f } from './impl';\nexport * from './impl';" },
      { 'impl.ts': 'export function f(a: number) {}', 'index.ts': "export { f } from './impl';\nexport * from './impl';" },
    );
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ file: 'impl.ts', export: 'f', reexportedBy: ['index.ts'] });
  });

  it('flags a re-export that disappears from an entry point', () => {
    expect(
      codes(
        { 'impl.ts': 'export function f() {}', 'index.ts': "export { f } from './impl';" },
        { 'impl.ts': 'export function f() {}', 'index.ts': 'export const version = 1;' },
      ),
    ).toEqual(['export-removed f']);
  });
});

describe('classes', () => {
  const base = `export class Box<T> {
    static create(): Box<string> { return new Box('x'); }
    readonly value: T;
    label?: string;
    private secret = 1;
    #hidden = 2;
    protected size = 0;
    constructor(value: T, public tag: string) { this.value = value; }
    get length(): number { return 1; }
    open(mode: 'r' | 'w'): void {}
  }`;

  it('extracts public and protected members only', () => {
    expect(codes(base, base.replace('private secret = 1;', 'private secret = "changed";').replace('#hidden = 2;', ''))).toEqual([]);
  });

  it('flags removed, retyped and narrowed members', () => {
    expect(codes(base, base.replace("open(mode: 'r' | 'w'): void {}", ''))).toEqual(['member-removed Box#open']);
    expect(codes(base, base.replace('static create()', 'static make()'))).toEqual(['member-removed Box#static create']);
    expect(codes(base, base.replace('protected size = 0;', 'private size = 0;'))).toEqual(['member-removed Box#size']);
    // A parameter property is both a constructor parameter and a property.
    expect(codes(base, base.replace('public tag: string', 'public tag: number'))).toEqual([
      'signature-changed Box#constructor',
      'member-changed Box#tag',
    ]);
    expect(codes(base, base.replace('label?: string;', 'protected label?: string;'))).toEqual(['member-changed Box#label']);
    expect(codes(base, base.replace('label?: string;', 'readonly label?: string;'))).toEqual(['member-changed Box#label']);
    expect(codes(base, base.replace("open(mode: 'r' | 'w')", "open(mode: 'r')"))).toEqual(['member-changed Box#open']);
  });

  it('treats getter-only accessors as readonly properties', () => {
    expect(codes(base, base.replace('get length(): number { return 1; }', 'length = 1;'))).toEqual([]);
    expect(codes(base, base.replace('get length(): number { return 1; }', 'get length(): string { return ""; }'))).toEqual([
      'member-changed Box#length',
    ]);
  });

  it('allows added members but flags added abstract members', () => {
    expect(codes(base, base.replace('#hidden = 2;', 'extra = 3;\nhelp(): void {}'))).toEqual([]);
    expect(codes('export abstract class S { abstract a(): void; }', 'export abstract class S { abstract a(): void; abstract b(): void; }')).toEqual([
      'member-added S#b',
    ]);
  });

  it('flags constructor changes', () => {
    expect(codes(base, base.replace('constructor(value: T, public tag: string)', 'constructor(value: T, public tag: string, extra: number)'))).toEqual([
      'signature-changed Box#constructor',
    ]);
    expect(codes('export class A {}', 'export class A { constructor(x: number) {} }')).toEqual(['signature-changed A#constructor']);
    expect(codes('export class A {}', 'export class A { private constructor() {} }')).toEqual(['modifier-changed A#constructor']);
  });

  it('flags abstract, base class and type parameter changes', () => {
    expect(codes('export class A {}', 'export abstract class A {}')).toEqual(['modifier-changed A']);
    expect(codes('class B {}\nexport class A extends B {}', 'export class A {}')).toEqual(['heritage-changed A']);
    expect(codes('export class A<T> { x?: T }', 'export class A<T, U> { x?: T }')).toEqual(['type-parameters-changed A', 'signature-changed A#constructor']);
  });
});

describe('interfaces', () => {
  it('flags removed and changed members', () => {
    const before = 'export interface I { a: string; b?: number; m(x: string): void; readonly [key: string]: unknown; }';
    expect(codes(before, 'export interface I { b?: number; m(x: string): void; readonly [key: string]: unknown; }')).toEqual(['member-removed I#a']);
    expect(codes(before, before.replace('a: string', 'a: number'))).toEqual(['member-changed I#a']);
    expect(codes(before, before.replace('a: string', 'a?: string'))).toEqual(['member-changed I#a']);
    expect(codes(before, before.replace('b?: number', 'b: number'))).toEqual(['member-changed I#b']);
    expect(codes(before, before.replace('m(x: string)', 'm(x: string, y: string)'))).toEqual(['member-changed I#m']);
    expect(codes(before, before.replace('[key: string]: unknown', '[key: string]: string'))).toEqual(['member-changed I#[string]']);
  });

  it('allows added optional members but flags added required members', () => {
    const before = 'export interface I { a: string }';
    expect(codes(before, 'export interface I { a: string; b?: number; c?(): void }')).toEqual([]);
    expect(codes(before, 'export interface I { a: string; b: number }')).toEqual(['member-added I#b']);
  });

  it('merges declarations and flags removed base interfaces', () => {
    const before = 'interface Base { x: number }\nexport interface I extends Base { a: string }\nexport interface I { b: string }';
    expect(codes(before, before)).toEqual([]);
    expect(codes(before, 'interface Base { x: number }\nexport interface I extends Base { a: string }')).toEqual(['member-removed I#b']);
    expect(codes(before, 'export interface I { a: string }\nexport interface I { b: string }')).toEqual(['heritage-changed I']);
  });

  it('compares call and construct signatures', () => {
    const before = 'export interface Fn { (x: string): number; new (x: string): object }';
    expect(codes(before, before)).toEqual([]);
    expect(codes(before, 'export interface Fn { (x: number): number; new (x: string): object }')).toEqual(['member-changed Fn#()']);
  });
});

describe('type aliases', () => {
  it('flags any change to the declaration, ignoring formatting and comments', () => {
    expect(codes('export type T = { a: string; b: number };', 'export type T = {\n  a: string; // the a\n  b: number;\n};')).toEqual([]);
    expect(codes('export type T = string | number;', 'export type T = string;')).toEqual(['type-changed T']);
    expect(codes('export type Box<T> = { v: T };', 'export type Box<T, U> = { v: T };')).toEqual(['type-parameters-changed Box']);
  });
});

describe('enums', () => {
  it('flags removed members and changed values, allows appended members', () => {
    const before = 'export enum E { A, B, C = "c" }';
    expect(codes(before, 'export enum E { A, B, C = "c", D = "d" }')).toEqual([]);
    expect(codes(before, 'export enum E { A, C = "c" }')).toEqual(['enum-member-removed E#B']);
    expect(codes(before, 'export enum E { A, B, C = "see" }')).toEqual(['enum-member-changed E#C']);
  });

  it('detects implicit value shifts when a member is inserted', () => {
    const r = diff('export enum E { A, B }', 'export enum E { A, X, B }');
    expect(r.changes).toMatchObject([{ code: 'enum-member-changed', member: 'B', before: '1', after: '2' }]);
  });

  it('flags an enum becoming a const enum', () => {
    expect(codes('export enum E { A }', 'export const enum E { A }')).toEqual(['modifier-changed E']);
  });
});
