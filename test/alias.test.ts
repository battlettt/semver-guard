import { describe, expect, it } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi } from '../src/extract.js';
import { makeSnapshot } from './helpers.js';

const messages = (before: string, after: string, typeComparison: 'assignability' | 'text' = 'assignability', file = 'index.ts') =>
  compareSurfaces(
    extractApi(makeSnapshot({ [file]: before })),
    extractApi(makeSnapshot({ [file]: after })),
    { from: 'before', to: 'after' },
    { typeComparison },
  ).changes.map((c) => `${c.code} ${c.export}: ${c.before} -> ${c.after}`);

describe('type alias targets are compared by type identity', () => {
  // Widening an alias widens every signature that uses it: a function that
  // takes an ID is fine, but every place that *returns* or *exposes* an ID now
  // hands callers values they did not expect (a number where code calls
  // id.toUpperCase()). Consumers also use the alias in their own types, where
  // any change of meaning can break them. So a changed target is only allowed
  // when it is the same type.
  it('flags an alias target widened to a supertype', () => {
    expect(messages('export type ID = string;', 'export type ID = string | number;')).toEqual([
      'type-changed ID: string -> string | number',
    ]);
    expect(
      messages("export type Mode = 'light' | 'dark';", "export type Mode = 'light' | 'dark' | 'system';"),
    ).toEqual(["type-changed Mode: 'light' | 'dark' -> 'light' | 'dark' | 'system'"]);
  });

  it('flags an alias target narrowed to a subtype or changed to an unrelated type', () => {
    expect(messages('export type ID = string | number;', 'export type ID = string;')).toEqual([
      'type-changed ID: string | number -> string',
    ]);
    expect(messages('export type ID = string;', 'export type ID = number;')).toEqual([
      'type-changed ID: string -> number',
    ]);
  });

  it('does not flag an equivalent spelling of the same type', () => {
    expect(messages('export type Names = Array<string>;', 'export type Names = string[];')).toEqual([]);
    expect(messages("export type Mode = 'light' | 'dark';", "export type Mode = 'dark' | 'light';")).toEqual([]);
    expect(
      messages(
        'export type Point = { x: number; y: number };',
        'export type Point = { y: number; x: number };',
      ),
    ).toEqual([]);
    expect(
      messages(
        'interface Options { verbose: boolean }\nexport type Settings = Options;',
        'interface Options { verbose: boolean }\nexport type Settings = { verbose: boolean };',
      ),
    ).toEqual([]);
    expect(
      messages('export type Lookup = Record<string, number>;', 'export type Lookup = { [key: string]: number };'),
    ).toEqual([]);
  });

  it('flags string -> string & {}: mutually assignable, but not the same type', () => {
    // `'a' | ID` reduces to `string` with the old alias but keeps `'a'` with
    // the new one, so conditional and mapped types over ID can change result.
    expect(messages('export type ID = string;', 'export type ID = string & {};')).toEqual([
      'type-changed ID: string -> string & {}',
    ]);
  });

  it('flags an intersection replaced by the equivalent object type (identity is structural, not by members)', () => {
    expect(
      messages(
        'export type Both = { a: string } & { b: number };',
        'export type Both = { a: string; b: number };',
      ),
    ).toEqual(['type-changed Both: { a: string; } & { b: number; } -> { a: string; b: number; }']);
  });

  it('reports a widened alias once, not in every signature that mentions it', () => {
    const before = 'export type ID = string;\nexport function get(id: ID): ID { return id; }\nexport interface User { id: ID }';
    const after = 'export type ID = string | number;\nexport function get(id: ID): ID { return id; }\nexport interface User { id: ID }';
    expect(messages(before, after)).toEqual(['type-changed ID: string -> string | number']);
  });

  it('works for aliases inside namespaces and in .tsx files', () => {
    expect(
      messages(
        'export namespace Api { export type Names = Array<string>; }',
        'export namespace Api { export type Names = string[]; }',
      ),
    ).toEqual([]);
    expect(messages('export type Names = Array<string>;', 'export type Names = string[];', 'assignability', 'index.tsx')).toEqual([]);
    expect(messages('export type ID = string;', 'export type ID = string | number;', 'assignability', 'index.tsx')).toEqual([
      'type-changed ID: string -> string | number',
    ]);
  });

  it('resolves names in the old target in the new version', () => {
    const before = "import type { Base } from './base.js';\nexport type Wrapped = Array<Base>;";
    const after = "import type { Base } from './base.js';\nexport type Wrapped = Base[];";
    const files = (index: string) => ({ 'index.ts': index, 'base.ts': 'export interface Base { id: string }' });
    const result = compareSurfaces(extractApi(makeSnapshot(files(before))), extractApi(makeSnapshot(files(after))));
    expect(result.changes).toEqual([]);
  });
});

describe('type alias targets fall back to the text comparison', () => {
  it('for generic aliases', () => {
    expect(messages('export type Box<T> = Array<T>;', 'export type Box<T> = T[];')).toEqual([
      'type-changed Box: Array<T> -> T[]',
    ]);
  });

  it('when the old target no longer resolves in the new version', () => {
    expect(
      messages(
        'interface Old { x: number }\nexport type Shape = Old;',
        'interface New { x: number }\nexport type Shape = New;',
      ),
    ).toEqual(['type-changed Shape: Old -> New']);
  });

  it('when either target involves any', () => {
    expect(messages('export type Value = any;', 'export type Value = unknown;')).toEqual([
      'type-changed Value: any -> unknown',
    ]);
  });

  it('with typeComparison: text', () => {
    expect(messages('export type Names = Array<string>;', 'export type Names = string[];', 'text')).toEqual([
      'type-changed Names: Array<string> -> string[]',
    ]);
  });
});
