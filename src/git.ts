import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A git command failed, or a ref or path could not be found. */
export class GitError extends Error {}

/** The repository that contains a directory, and where that directory sits inside it. */
export interface GitContext {
  /** Directory the command runs in. */
  cwd: string;
  /** Root of the repository's work tree; git commands run here. */
  toplevel: string;
  /** Path of `cwd` relative to the repository root, with `/` separators and no trailing slash (`''` at the root). */
  prefix: string;
}

/** A git ref extracted into a temporary directory. */
export interface RefSnapshot {
  /** Directory to compare: the extracted counterpart of the directory the command ran in. */
  dir: string;
  /** Full commit SHA the ref resolved to. */
  commit: string;
  /** Deletes the temporary directory. */
  cleanup: () => void;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

/**
 * Returns the git repository that contains `cwd`, or `undefined` if `cwd` is
 * not inside a git work tree (or git is not installed).
 */
export function findGitContext(cwd: string): GitContext | undefined {
  const inside = git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== 'true') return undefined;
  const toplevel = git(['rev-parse', '--show-toplevel'], cwd);
  const prefix = git(['rev-parse', '--show-prefix'], cwd);
  if (toplevel.status !== 0 || prefix.status !== 0) return undefined;
  return { cwd, toplevel: toplevel.stdout.trim(), prefix: prefix.stdout.trim().replace(/\/+$/, '') };
}

/**
 * Extracts the tree of `ref` into a fresh temporary directory with
 * `git archive`, and returns the directory that corresponds to `context.cwd`
 * (so running inside `packages/lib` compares `packages/lib` at that ref).
 *
 * If `context.cwd` has a `node_modules` directory, it is linked into the
 * snapshot so that imports of dependencies resolve to the same types as in
 * the working copy.
 */
export function materializeRef(ref: string, context: GitContext): RefSnapshot {
  if (ref.startsWith('-')) throw new GitError(`invalid git ref: ${ref}`);
  // Run from the work tree root: from a subdirectory, `git archive` only
  // archives that subdirectory of the tree-ish.
  const repo = context.toplevel;
  const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
  if (resolved.status !== 0 || resolved.stdout.trim() === '') {
    throw new GitError(`unknown git ref: ${ref} (not a tag, branch or commit in this repository)`);
  }
  const commit = resolved.stdout.trim();
  const treeish = context.prefix === '' ? commit : `${commit}:${context.prefix}`;
  if (context.prefix !== '' && git(['cat-file', '-e', treeish], repo).status !== 0) {
    throw new GitError(`directory ${context.prefix} does not exist at ${ref}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-guard-ref-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const archive = path.join(tmp, 'snapshot.tar');
    const dir = path.join(tmp, 'snapshot');
    fs.mkdirSync(dir);
    const archived = git(['archive', '--format=tar', `--output=${archive}`, treeish], repo);
    if (archived.status !== 0) {
      throw new GitError(`git archive failed for ${ref}: ${archived.stderr.trim() || 'unknown error'}`);
    }
    const extracted = spawnSync('tar', ['-xf', archive, '-C', dir], { encoding: 'utf8' });
    if (extracted.error || extracted.status !== 0) {
      throw new GitError(
        `could not extract ${ref}: ${extracted.error?.message ?? (extracted.stderr.trim() || 'tar failed')}`,
      );
    }
    fs.rmSync(archive);

    const nodeModules = path.join(context.cwd, 'node_modules');
    const link = path.join(dir, 'node_modules');
    if (fs.existsSync(nodeModules) && !fs.existsSync(link)) {
      fs.symlinkSync(nodeModules, link, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return { dir, commit, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
