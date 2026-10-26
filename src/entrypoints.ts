import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

/** Entry modules of a package, resolved from its `package.json`. */
export interface EntryPoints {
  /** Which `package.json` field the entry points came from. */
  field: 'exports' | 'main';
  /** Source files the targets map to, relative to the snapshot root with `/` separators. */
  files: string[];
  /** Targets that could not be mapped to a source file (including `*` patterns). */
  unresolved: string[];
}

/** Output directories commonly mapped back to `src` when no tsconfig says otherwise. */
const COMMON_OUT_DIRS = ['dist', 'lib', 'build', 'out'];
/** Targets that are not code, such as `"./package.json": "./package.json"`. */
const NON_CODE = /\.(json|css|scss|wasm|node|map|txt|md)$/i;
/** TypeScript source paths, as opposed to compiled `.js`/`.jsx` targets. */
const TS_SOURCE = /\.(?:[mc]?ts|tsx)$/;

/**
 * Reads `<root>/package.json` and maps every target of its `exports` field (or,
 * without `exports`, its `main`, `types` and `typings` fields) to a TypeScript
 * source file under `root`. `isSourceFile` decides which relative paths count
 * as scanned source files.
 *
 * Returns `undefined` (meaning: treat every module as public) when there is no
 * readable `package.json`, it has none of these fields, or no target maps to a
 * source file.
 */
export function resolveEntryPoints(root: string, isSourceFile: (rel: string) => boolean): EntryPoints | undefined {
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    pkg = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  let field: EntryPoints['field'];
  const targets: string[] = [];
  if (pkg.exports !== undefined && pkg.exports !== null) {
    field = 'exports';
    collectTargets(pkg.exports, targets);
  } else {
    field = 'main';
    for (const key of ['main', 'types', 'typings']) {
      if (typeof pkg[key] === 'string') targets.push(pkg[key] as string);
    }
  }
  const codeTargets = [...new Set(targets)].filter((t) => !NON_CODE.test(t));
  if (codeTargets.length === 0) return undefined;

  const outDirs = outDirMappings(root);
  const files = new Set<string>();
  const unresolved: string[] = [];
  for (const target of codeTargets) {
    const source = target.includes('*') ? undefined : mapTarget(target, outDirs, isSourceFile);
    if (source) files.add(source);
    else unresolved.push(target);
  }
  if (files.size === 0) return undefined;
  return { field, files: [...files].sort(), unresolved };
}

/** Collects the string targets of an `exports` value: subpath maps, condition maps and fallback arrays. */
function collectTargets(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectTargets(item, out);
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectTargets(item, out);
  }
}

/** `[outDir, rootDir]` pairs, relative to the snapshot root, tried when a target points at compiled output. */
function outDirMappings(root: string): [string, string][] {
  const mappings: [string, string][] = [];
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const options = (config.config as { compilerOptions?: { outDir?: unknown; rootDir?: unknown } } | undefined)
    ?.compilerOptions;
  if (options && typeof options.outDir === 'string') {
    const outDir = normalize(options.outDir);
    if (typeof options.rootDir === 'string') mappings.push([outDir, normalize(options.rootDir)]);
    else mappings.push([outDir, 'src'], [outDir, '']);
  }
  for (const dir of COMMON_OUT_DIRS) mappings.push([dir, 'src'], [dir, '']);
  return mappings;
}

/** Maps a package.json target such as `./dist/index.js` to a source file such as `src/index.ts`. */
function mapTarget(
  target: string,
  outDirs: [string, string][],
  isSourceFile: (rel: string) => boolean,
): string | undefined {
  const rel = normalize(target);
  if (rel === '' || rel.startsWith('../')) return undefined;

  // Same-directory sources first, then sources mapped out of a build
  // directory, and only then declaration files next to the target.
  const sources = sourceCandidates(rel);
  const candidates = [...sources];
  for (const [outDir, rootDir] of outDirs) {
    const prefix = outDir === '' ? '' : `${outDir}/`;
    if (prefix !== '' && !rel.startsWith(prefix)) continue;
    const mapped = joinRel(rootDir, rel.slice(prefix.length));
    candidates.push(...sourceCandidates(mapped));
  }
  candidates.push(...declarationCandidates(rel));
  return candidates.find((candidate) => isSourceFile(candidate));
}

/** Non-declaration TypeScript files (including `.tsx`) that a (possibly compiled) path corresponds to. */
function sourceCandidates(rel: string): string[] {
  const stem = stripDeclaration(rel);
  if (stem !== undefined) {
    return stem.ext === '.ts' ? [`${stem.base}.ts`, `${stem.base}.tsx`] : [`${stem.base}${stem.ext}`];
  }
  if (TS_SOURCE.test(rel)) return [rel];
  const js = /^(.*)\.([mc]?)js(x?)$/.exec(rel);
  if (js) {
    if (js[2] !== '') return [`${js[1]}.${js[2]}ts`];
    // `tsc` compiles .tsx to .js (or .jsx with `jsx: preserve`).
    return js[3] === 'x' ? [`${js[1]}.tsx`, `${js[1]}.ts`] : [`${js[1]}.ts`, `${js[1]}.tsx`];
  }
  // Extensionless or directory targets.
  return [`${rel}.ts`, `${rel}.tsx`, `${rel}.mts`, `${rel}.cts`, joinRel(rel, 'index.ts'), joinRel(rel, 'index.tsx')];
}

function declarationCandidates(rel: string): string[] {
  if (stripDeclaration(rel) !== undefined) return [rel];
  const js = /^(.*)\.([mc]?)jsx?$/.exec(rel);
  if (js) return [`${js[1]}.d.${js[2]}ts`];
  if (TS_SOURCE.test(rel)) return [];
  return [`${rel}.d.ts`, joinRel(rel, 'index.d.ts')];
}

/** `x.d.ts` -> `{ base: 'x', ext: '.ts' }`; undefined if `rel` is not a declaration file. */
function stripDeclaration(rel: string): { base: string; ext: string } | undefined {
  const match = /^(.*)\.d(\.[mc]?ts)$/.exec(rel);
  return match ? { base: match[1], ext: match[2] } : undefined;
}

function normalize(p: string): string {
  const posix = path.posix.normalize(p.replace(/\\/g, '/'));
  return posix === '.' ? '' : posix.replace(/^\.\//, '').replace(/\/+$/, '');
}

function joinRel(dir: string, rel: string): string {
  return dir === '' ? rel : `${dir}/${rel}`;
}
