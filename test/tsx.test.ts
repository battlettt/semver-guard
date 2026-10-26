import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi, findEntryPoints } from '../src/extract.js';
import { diff, FIXTURES, makeSnapshot } from './helpers.js';

const messages = (before: Record<string, string>, after: Record<string, string>) =>
  diff(before, after).changes.map((c) => `${c.code} ${c.export}${c.member ? `#${c.member}` : ''}: ${c.message}`);

/** A minimal `react/jsx-runtime`, so JSX expressions have a real type instead of `any`. */
const JSX_RUNTIME = {
  'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '19.0.0', types: 'index.d.ts' }),
  'node_modules/react/index.d.ts': 'export {};\n',
  'node_modules/react/jsx-runtime.d.ts': `export namespace JSX {
  interface Element { readonly type: unknown; readonly props: unknown }
  interface IntrinsicElements { [name: string]: Record<string, unknown> }
}
export declare function jsx(type: unknown, props: unknown): JSX.Element;
export declare function jsxs(type: unknown, props: unknown): JSX.Element;
`,
};

describe('fixture component packages (components-before -> components-after)', () => {
  const result = compareSurfaces(
    extractApi(path.join(FIXTURES, 'components-before')),
    extractApi(path.join(FIXTURES, 'components-after')),
    { from: 'fixtures/components-before', to: 'fixtures/components-after' },
  );

  it('resolves a .tsx entry module from package.json', () => {
    expect(findEntryPoints(path.join(FIXTURES, 'components-before'))?.files).toEqual(['src/index.tsx']);
    expect(result.summary).toMatchObject({ filesBefore: 5, filesAfter: 4, exportsBefore: 4, exportsAfter: 3 });
  });

  it('reports exactly the narrowed props and the removed component', () => {
    expect(result.changes.map((c) => `${c.code} ${c.file} ${c.export}`)).toEqual([
      'signature-changed src/index.tsx Card',
      'export-removed src/index.tsx Tooltip',
    ]);
    expect(result.changes[0].message).toBe(
      'type of parameter { title, theme } (CardProps) changed from { title: string; theme?: Theme | undefined } to { title: string; theme: Theme }',
    );
  });

  it('does not flag widened Button props or the rewritten internal icons module', () => {
    expect(result.changes.filter((c) => c.export === 'Button' || c.file.includes('icons'))).toEqual([]);
  });
});

describe('.tsx files', () => {
  it('are scanned, and their exports count toward the public surface like .ts', () => {
    const surface = extractApi(
      makeSnapshot({
        'Button.tsx': `export interface ButtonProps { label: string }
export type Size = 'sm' | 'lg';
export enum Tone { Neutral, Danger }
export function Button(props: ButtonProps) { return <button>{props.label}</button>; }
`,
      }),
    );
    expect(surface.files).toEqual(['Button.tsx']);
    expect(surface.exports.map((e) => `${e.name}:${e.shapes[0].kind}`)).toEqual([
      'Button:function',
      'ButtonProps:interface',
      'Size:type',
      'Tone:enum',
    ]);
  });

  it('flag interface, type alias and enum changes in .tsx files with the usual rules', () => {
    expect(
      messages(
        { 'ui.tsx': "export interface Theme { color: string; spacing: number }\nexport type Size = 'sm' | 'lg';\n" },
        { 'ui.tsx': "export interface Theme { color: string }\nexport type Size = 'sm';\n" },
      ),
    ).toEqual([
      'type-changed Size: type alias declaration changed',
      'member-removed Theme#spacing: property spacing was removed',
    ]);
  });

  it('can import from .ts files and be imported by them', () => {
    const v1 = {
      'package.json': JSON.stringify({ name: 'ui', exports: './dist/index.js' }),
      'src/index.ts': "export { Badge } from './Badge';\n",
      'src/Badge.tsx': "import type { Tone } from './tone';\nexport function Badge(props: { tone: Tone }) { return <b>{props.tone}</b>; }\n",
      'src/tone.ts': "export type Tone = 'info' | 'warn';\n",
    };
    expect(messages(v1, v1)).toEqual([]);
    expect(
      messages(v1, {
        ...v1,
        'src/Badge.tsx': "import type { Tone } from './tone';\nexport function Badge(props: { tone: Tone; count: number }) { return <b>{props.tone}</b>; }\n",
      }),
    ).toEqual([
      'signature-changed Badge: type of parameter props changed from { tone: Tone; } to { tone: Tone; count: number; }',
    ]);
  });

  it('map .js, .jsx and extensionless package.json targets to .tsx sources', () => {
    const files = (exports: unknown) => ({
      'package.json': JSON.stringify({ name: 'ui', exports }),
      'src/index.tsx': 'export const version = 1;\n',
      'src/widgets/index.tsx': 'export const widgets = 1;\n',
      'src/legacy.tsx': 'export const legacy = 1;\n',
    });
    const entry = (exports: unknown) => findEntryPoints(makeSnapshot(files(exports)))?.files;
    expect(entry({ '.': './dist/index.js' })).toEqual(['src/index.tsx']);
    expect(entry({ '.': './dist/legacy.jsx' })).toEqual(['src/legacy.tsx']);
    expect(entry({ '.': './dist/index.d.ts' })).toEqual(['src/index.tsx']);
    expect(entry({ './widgets': './src/widgets' })).toEqual(['src/widgets/index.tsx']);
  });
});

describe('component props follow the parameter rules', () => {
  const component = (props: string, body = '<div />') => ({
    'index.tsx': `export function Panel(props: ${props}) { return ${body}; }\n`,
  });

  it('does not flag inline props that widen', () => {
    expect(
      messages(
        component("{ mode: 'light' | 'dark' }"),
        component("{ mode: 'light' | 'dark' | 'system'; title?: string }"),
      ),
    ).toEqual([]);
  });

  it('flags inline props that narrow', () => {
    expect(messages(component("{ mode: 'light' | 'dark' }"), component("{ mode: 'light' }"))).toEqual([
      "signature-changed Panel: type of parameter props changed from { mode: 'light' | 'dark'; } to { mode: 'light'; }",
    ]);
    expect(messages(component('{ title?: string }'), component('{ title: string }'))).toEqual([
      'signature-changed Panel: type of parameter props changed from { title?: string; } to { title: string; }',
    ]);
  });

  it('compares the members of a non-exported props type, not just its name', () => {
    const withProps = (props: string) => ({
      'index.tsx': `type PanelProps = ${props};\nexport const Panel = (props: PanelProps) => <div>{String(props)}</div>;\n`,
    });
    // Widening: a union gains a member and an optional prop is added.
    expect(
      messages(
        withProps("{ mode: 'light' | 'dark' }"),
        withProps("{ mode: 'light' | 'dark' | 'system'; title?: string }"),
      ),
    ).toEqual([]);
    // Narrowing: a union loses a member.
    expect(messages(withProps("{ mode: 'light' | 'dark' }"), withProps("{ mode: 'light' }"))).toEqual([
      'signature-changed Panel: type of parameter props (PanelProps) changed from { mode: "light" | "dark" } to { mode: "light" }',
    ]);
  });

  it('compares a non-exported props interface, including heritage', () => {
    const withProps = (body: string) => ({
      'index.tsx': `interface BaseProps { id: string }\ninterface PanelProps extends BaseProps ${body}\nexport function Panel(props: PanelProps) { return <div id={props.id} />; }\n`,
    });
    expect(messages(withProps('{ title: string }'), withProps('{ title: string; footer?: string }'))).toEqual([]);
    expect(messages(withProps('{ title: string }'), withProps('{ title: string; footer: string }'))).toEqual([
      'signature-changed Panel: type of parameter props (PanelProps) changed from { title: string; id: string } to { title: string; footer: string; id: string }',
    ]);
  });

  it('leaves exported props types to their own rules', () => {
    // The interface is public, so its new required member is reported on the
    // interface; the component signature (props: PanelProps) did not change.
    expect(
      messages(
        { 'index.tsx': 'export interface PanelProps { title: string }\nexport function Panel(props: PanelProps) { return <div />; }\n' },
        { 'index.tsx': 'export interface PanelProps { title: string; footer: string }\nexport function Panel(props: PanelProps) { return <div />; }\n' },
      ),
    ).toEqual([
      'member-added PanelProps#footer: required property footer was added; existing implementations and object literals of this interface no longer type-check',
    ]);
  });

  it('flags a removed component and ignores changes to .tsx code that is not exported', () => {
    const v1 = {
      'index.tsx': 'function Row(props: { cells: string[] }) { return <tr />; }\nexport function Table(props: { rows: string[][] }) { return <table>{props.rows.map((r) => <Row cells={r} />)}</table>; }\nexport function Caption() { return <caption />; }\n',
    };
    const internalChange = {
      'index.tsx': 'function Row(props: { cells: number[]; striped: boolean }) { return <tr />; }\nexport function Table(props: { rows: string[][] }) { return <table>{props.rows.map((r) => <Row cells={r.map(Number)} striped />)}</table>; }\nexport function Caption() { return <caption />; }\n',
    };
    expect(messages(v1, internalChange)).toEqual([]);
    const removed = { 'index.tsx': v1['index.tsx'].replace('export function Caption() { return <caption />; }\n', '') };
    expect(messages(v1, removed)).toEqual(['export-removed Caption: function Caption was removed']);
  });

  it('uses the JSX element type when React types are installed', () => {
    const v1 = { ...JSX_RUNTIME, 'index.tsx': 'export function Tag(props: { text: string }) { return <span>{props.text}</span>; }\n' };
    const surface = extractApi(makeSnapshot(v1));
    const tag = surface.exports.find((e) => e.name === 'Tag')!.shapes[0];
    expect(tag.kind === 'function' && tag.signatures[0].returnType).toBe('JSX.Element');

    const widened = { ...v1, 'index.tsx': 'export function Tag(props: { text: string | number }) { return <span>{props.text}</span>; }\n' };
    const narrowed = { ...v1, 'index.tsx': "export function Tag(props: { text: 'a' }) { return <span>{props.text}</span>; }\n" };
    expect(messages(v1, widened)).toEqual([]);
    expect(messages(v1, narrowed)).toEqual([
      "signature-changed Tag: type of parameter props changed from { text: string; } to { text: 'a'; }",
    ]);
  });
});
