export { extractApi, findEntryPoints, findSourceFiles, SnapshotError, type ExtractOptions } from './extract.js';
export type { EntryPoints } from './entrypoints.js';
export { loadBaseline, parseBaseline, applyBaseline, matchesBaseline, BaselineError, type BaselineEntry, type BaselineResult } from './baseline.js';
export { findGitContext, materializeRef, GitError, type GitContext, type RefSnapshot } from './git.js';
export { compareSurfaces, formatSignature, formatTypeParams } from './compare.js';
export { formatJson, formatTable, type OutputFormat } from './format.js';
export { run, EXIT_OK, EXIT_BREAKING, EXIT_ERROR, type Io } from './run.js';
export type * from './model.js';
