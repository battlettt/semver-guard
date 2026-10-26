import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi } from '../src/extract.js';
import { FIXTURES } from './helpers.js';

const before = extractApi(path.join(FIXTURES, 'before'));
const after = extractApi(path.join(FIXTURES, 'after'));
const result = compareSurfaces(before, after, { from: 'fixtures/before', to: 'fixtures/after' });
const find = (exportName: string, member?: string) =>
  result.changes.filter((c) => c.export === exportName && (member === undefined || c.member === member));

describe('fixture packages (before -> after)', () => {
  it('flags a removed export', () => {
    const changes = find('legacyHelper');
    expect(changes.map((c) => [c.file, c.code])).toEqual([
      ['src/index.ts', 'export-removed'],
      ['src/legacy.ts', 'export-removed'],
    ]);
    expect(changes[0].exportKind).toBe('function');
  });

  it('flags a changed function signature', () => {
    const [change, ...others] = find('formatDate');
    expect(others).toEqual([]);
    expect(change.code).toBe('signature-changed');
    expect(change.file).toBe('src/format.ts');
    expect(change.message).toContain('parameter locale was renamed to options');
    expect(change.message).toContain('type of parameter options changed from string to FormatOptions');
    expect(change.before).toBe('(date: Date, locale: string): string');
    expect(change.after).toBe('(date: Date, options: FormatOptions): string');
    expect(change.reexportedBy).toEqual(['src/index.ts']);
  });

  it('flags a removed class member', () => {
    const changes = find('Client', 'disconnect');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      code: 'member-removed',
      file: 'src/client.ts',
      exportKind: 'class',
      before: 'disconnect(): void',
      reexportedBy: ['src/index.ts'],
    });
  });

  it('flags a removed interface member and a changed type alias', () => {
    expect(find('ClientOptions', 'timeoutMs').map((c) => c.code)).toEqual(['member-removed']);
    expect(find('RequestMethod')).toMatchObject([
      { code: 'type-changed', before: "'GET' | 'POST' | 'PUT' | 'DELETE'", after: "'GET' | 'POST' | 'PUT'" },
    ]);
  });

  it('does not flag newly added exports or members', () => {
    expect(after.exports.some((e) => e.name === 'parseDuration')).toBe(true);
    expect(after.exports.some((e) => e.name === 'FormatOptions')).toBe(true);
    expect(find('parseDuration')).toEqual([]);
    expect(find('FormatOptions')).toEqual([]);
    expect(find('Client', 'ping')).toEqual([]);
    expect(find('ClientOptions', 'userAgent')).toEqual([]);
    expect(find('LogLevel')).toEqual([]);
  });

  it('does not flag an added optional parameter', () => {
    expect(find('greet')).toEqual([]);
  });

  it('does not flag changes to non-exported internals', () => {
    // buildUrl, pad and Client's private fields all changed between versions.
    expect(before.exports.some((e) => e.name === 'buildUrl' || e.name === 'pad')).toBe(false);
    expect(result.changes.some((c) => /buildUrl|pad|connected|connectCount/.test(JSON.stringify(c)))).toBe(false);
    expect(find('formatTime')).toEqual([]);
    expect(find('Client', 'connect')).toEqual([]);
  });

  it('reports exactly the expected set of breaking changes', () => {
    expect(result.changes.map((c) => `${c.file} ${c.code} ${c.export}${c.member ? '#' + c.member : ''}`)).toEqual([
      'src/client.ts member-removed Client#disconnect',
      'src/client.ts member-removed ClientOptions#timeoutMs',
      'src/client.ts type-changed RequestMethod',
      'src/format.ts signature-changed formatDate',
      'src/index.ts export-removed legacyHelper',
      'src/legacy.ts export-removed legacyHelper',
    ]);
    expect(result.summary).toEqual({
      breaking: 6,
      filesBefore: 4,
      filesAfter: 4,
      exportsBefore: before.exports.length,
      exportsAfter: after.exports.length,
    });
  });

  it('finds no breaking changes when a snapshot is compared with itself', () => {
    expect(compareSurfaces(before, extractApi(path.join(FIXTURES, 'before'))).changes).toEqual([]);
    expect(compareSurfaces(after, extractApi(path.join(FIXTURES, 'after'))).changes).toEqual([]);
  });
});
