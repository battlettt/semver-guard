import { describe, expect, it } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi } from '../src/extract.js';
import { diff, makeSnapshot } from './helpers.js';

const messages = (before: Record<string, string>, after: Record<string, string>) =>
  diff(before, after).changes.map((c) => `${c.code} ${c.export}${c.member ? `#${c.member}` : ''}: ${c.message}`);

/** React is not installed in these snapshots: `FC`, `memo` and `forwardRef` are recognized by name. */
const IMPORTS = "import React, { memo, forwardRef, type FC, type FunctionComponent } from 'react';\n";
const tsx = (body: string) => ({ 'index.tsx': IMPORTS + body });

describe('components typed as React.FC<Props> / FunctionComponent<Props>', () => {
  const fc = (props: string, annotation = 'React.FC') =>
    tsx(`export const Badge: ${annotation}<${props}> = (props) => <span>{String(props)}</span>;\n`);

  it('are compared by their props, not as variable text', () => {
    const shape = extractApi(makeSnapshot(fc('{ label: string }'))).exports.find((e) => e.name === 'Badge')!.shapes[0];
    expect(shape).toMatchObject({
      kind: 'function',
      component: 'React.FC',
      signatures: [{ params: [{ name: 'props', type: '{ label: string; }' }], returnType: '' }],
    });
  });

  it('does not flag props that widen', () => {
    expect(messages(fc('{ label: string }'), fc('{ label: string | number; tone?: string }'))).toEqual([]);
    expect(messages(fc('{ label: string }', 'FC'), fc('{ label: string | number }', 'FunctionComponent'))).toEqual([]);
  });

  it('flags props that narrow', () => {
    expect(messages(fc('{ label: string | number }'), fc('{ label: string }'))).toEqual([
      'signature-changed Badge: type of parameter props changed from { label: string | number; } to { label: string; }',
    ]);
    expect(messages(fc('{ label: string }', 'FunctionComponent'), fc('{ label: string; tone: string }', 'FunctionComponent'))).toEqual([
      'signature-changed Badge: type of parameter props changed from { label: string; } to { label: string; tone: string; }',
    ]);
  });

  it('compares the members of a non-exported props type', () => {
    const withProps = (props: string) =>
      tsx(`type BadgeProps = ${props};\nexport const Badge: React.FC<BadgeProps> = ({ label }) => <span>{label}</span>;\n`);
    expect(messages(withProps('{ label: string }'), withProps('{ label: string; tone?: string }'))).toEqual([]);
    expect(messages(withProps('{ label: string }'), withProps('{ label: string; tone: string }'))).toEqual([
      'signature-changed Badge: type of parameter { label } (BadgeProps) changed from { label: string } to { label: string; tone: string }',
    ]);
  });

  it('can change to a plain function component and back without a report', () => {
    const plain = tsx('export function Badge({ label }: { label: string | number }) { return <span>{label}</span>; }\n');
    expect(messages(fc('{ label: string }'), plain)).toEqual([]);
    expect(messages(plain, fc('{ label: string | number }'))).toEqual([]);
    expect(messages(plain, fc('{ label: string }'))).toEqual([
      'signature-changed Badge: type of parameter props changed from { label: string | number; } to { label: string; }',
    ]);
  });
});

describe('components wrapped in memo(...) and forwardRef(...)', () => {
  it('flags a memo-wrapped component whose props narrow', () => {
    const memoized = (props: string) =>
      tsx(`type ListProps = ${props};\nexport const List = memo(function List({ items }: ListProps) { return <ul>{items.length}</ul>; });\n`);
    expect(messages(memoized('{ items: string[]; dense?: boolean }'), memoized('{ items: string[] }'))).toEqual([]);
    expect(messages(memoized('{ items: string[]; dense?: boolean }'), memoized('{ items: string[]; dense: boolean }'))).toEqual([
      'signature-changed List: type of parameter { items } (ListProps) changed from { items: string[]; dense?: boolean | undefined } to { items: string[]; dense: boolean }',
    ]);
  });

  it('does not flag a forwardRef-wrapped component whose props widen', () => {
    const forwarded = (props: string) =>
      tsx(`export const Input = forwardRef<HTMLInputElement, ${props}>((props, ref) => <input ref={ref} />);\n`);
    const shape = extractApi(makeSnapshot(forwarded("{ size: 'sm' }"))).exports.find((e) => e.name === 'Input')!.shapes[0];
    expect(shape).toMatchObject({
      kind: 'function',
      component: 'forwardRef',
      signatures: [{ params: [{ name: 'props', type: "{ size: 'sm'; }" }, { name: 'ref', type: 'HTMLInputElement', optional: true }] }],
    });
    expect(messages(forwarded("{ size: 'sm' }"), forwarded("{ size: 'sm' | 'lg'; label?: string }"))).toEqual([]);
    expect(messages(forwarded("{ size: 'sm' | 'lg' }"), forwarded("{ size: 'sm' }"))).toEqual([
      "signature-changed Input: type of parameter props changed from { size: 'sm' | 'lg'; } to { size: 'sm'; }",
    ]);
  });

  it('reads forwardRef props and ref from an annotated render function', () => {
    const render = (props: string, ref = 'HTMLInputElement') =>
      tsx(`export const Input = React.forwardRef((props: ${props}, ref: React.Ref<${ref}>) => <input ref={ref} />);\n`);
    expect(messages(render('{ value: string }'), render('{ value: string | number }'))).toEqual([]);
    // The ref target is compared by its text.
    expect(messages(render('{ value: string }'), render('{ value: string }', 'HTMLTextAreaElement'))).toEqual([
      'signature-changed Input: type of parameter ref changed from HTMLInputElement to HTMLTextAreaElement',
    ]);
  });

  it('reports a component that stops forwarding its ref, but not one that starts', () => {
    const plain = tsx('export const Input = (props: { value: string }) => <input />;\n');
    const forwarded = tsx('export const Input = forwardRef<HTMLInputElement, { value: string }>((props, ref) => <input ref={ref} />);\n');
    expect(messages(plain, forwarded)).toEqual([]);
    expect(messages(forwarded, plain)).toEqual(['signature-changed Input: parameter ref was removed']);
  });

  it('looks through memo(forwardRef(...)) and references to local components', () => {
    const nested = (props: string) =>
      tsx(`const Inner = forwardRef<HTMLDivElement, ${props}>((props, ref) => <div ref={ref} />);\nexport const Box = React.memo(Inner);\n`);
    const shape = extractApi(makeSnapshot(nested('{ pad: number }'))).exports.find((e) => e.name === 'Box')!.shapes[0];
    expect(shape).toMatchObject({ kind: 'function', component: 'memo(forwardRef)' });
    expect(messages(nested('{ pad: number }'), nested('{ pad: number | string }'))).toEqual([]);
    expect(messages(nested('{ pad: number | string }'), nested('{ pad: number }'))).toEqual([
      'signature-changed Box: type of parameter props changed from { pad: number | string; } to { pad: number; }',
    ]);
  });

  it('uses the type argument of memo<Props> and handles export default', () => {
    const typed = (props: string) =>
      tsx(`function Chip(props: any) { return <i />; }\nexport default memo<${props}>(Chip);\n`);
    expect(messages(typed('{ text: string }'), typed('{ text: string; icon?: string }'))).toEqual([]);
    expect(messages(typed('{ text: string; icon?: string }'), typed('{ text: string }'))).toEqual([]);
    expect(messages(typed('{ text: string }'), typed("{ text: 'a' }"))).toEqual([
      "signature-changed default: type of parameter props changed from { text: string; } to { text: 'a'; }",
    ]);
  });

  it('formats before/after with the component form', () => {
    const v1 = tsx('export const Tag = memo((props: { text: string }) => <b />);\n');
    const v2 = tsx("export const Tag = memo((props: { text: 'x' }) => <b />);\n");
    expect(diff(v1, v2).changes[0]).toMatchObject({
      before: 'memo (props: { text: string; })',
      after: "memo (props: { text: 'x'; })",
    });
  });

  it('falls back to text when the text comparison is requested', () => {
    const v1 = tsx('export const Tag = memo((props: { text: string }) => <b />);\n');
    const v2 = tsx('export const Tag = memo((props: { text: string | number }) => <b />);\n');
    const result = compareSurfaces(extractApi(makeSnapshot(v1)), extractApi(makeSnapshot(v2)), undefined, {
      typeComparison: 'text',
    });
    expect(result.changes.map((c) => c.message)).toEqual([
      'type of parameter props changed from { text: string; } to { text: string | number; }',
    ]);
  });

  it('leaves calls to other functions as variables', () => {
    const shape = extractApi(makeSnapshot(tsx('const wrap = (x: unknown) => x;\nexport const Thing = wrap(() => null);\n'))).exports.find(
      (e) => e.name === 'Thing',
    )!.shapes[0];
    expect(shape.kind).toBe('variable');
  });
});
