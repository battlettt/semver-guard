import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { compareSurfaces } from '../src/compare.js';
import { extractApi } from '../src/extract.js';
import type { CompareResult } from '../src/model.js';

const created: string[] = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes `files` (relative path -> contents) into a fresh temporary directory. */
export function makeSnapshot(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-guard-'));
  created.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

/** Compares two single-file snapshots (`index.ts`) or two file maps. */
export function diff(
  before: string | Record<string, string>,
  after: string | Record<string, string>,
): CompareResult {
  const toFiles = (v: string | Record<string, string>) => (typeof v === 'string' ? { 'index.ts': v } : v);
  return compareSurfaces(extractApi(makeSnapshot(toFiles(before))), extractApi(makeSnapshot(toFiles(after))), {
    from: 'before',
    to: 'after',
  });
}

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
