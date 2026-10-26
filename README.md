# semver-guard

Catch breaking API changes in a TypeScript package **before** you release them as a minor or patch version.

```sh
semver-guard compare --from ./v1.4.0 --to ./v1.5.0
# or straight from git
semver-guard compare --from-ref v1.4.0 --to-ref HEAD
```

## The problem

[Semantic versioning](https://semver.org) only works if maintainers know whether a release breaks the public API. In practice that is easy to get wrong:

- an export gets renamed during a refactor,
- a parameter changes from `string` to an options object,
- a "dead" class method is deleted,
- a union type loses a member,
- an enum member is inserted in the middle and silently shifts every value after it.

Each of these compiles fine in the library itself, passes the library's own tests, and goes out as `1.5.0`. Then every downstream project with `"^1.4.0"` in its `package.json` picks up the release on its next install and breaks. Downstream users lose trust in the version range and start pinning exact versions, and the maintainer has to ship a revert or a quick `2.0.0`.

semver-guard compares the exported API surface of two snapshots of your source and lists every change that would break a consumer, so you can either bump the major version or restore compatibility before publishing.

## Installation

Requires Node.js 20 or newer.

```sh
npm install --save-dev semver-guard
# or run it without installing
npx semver-guard compare --from <old> --to <new>
```

From a clone of this repository:

```sh
npm install
npm run build
node dist/cli.js compare --from fixtures/before --to fixtures/after
```

The only runtime dependency is the TypeScript compiler (`typescript` 6.0.x, pinned because TypeScript 7 no longer ships the JavaScript compiler API). semver-guard uses its own copy, so your project can use any TypeScript version.

## Usage

```
semver-guard compare --from <dir> --to <dir> [--format table|json] [--baseline <file>]
semver-guard compare --from-ref <ref> --to-ref <ref> [--format table|json] [--baseline <file>]
semver-guard --help
semver-guard --version
```

| Option | Description |
| --- | --- |
| `--from <dir>` | Directory snapshot of the previous (released) version. |
| `--to <dir>` | Directory snapshot of the new version. |
| `--from-ref <ref>` | Git tag, branch or commit of the previous version (instead of `--from`). See [Comparing git refs](#comparing-git-refs). |
| `--to-ref <ref>` | Git tag, branch or commit of the new version (instead of `--to`). |
| `--baseline <file>` | JSON file of breaking changes you have already accepted; they are not reported. See [Accepting changes with a baseline](#accepting-changes-with-a-baseline). |
| `--format table\|json` | Output format. `table` (default) is for humans; `json` is for scripts. |

Each side needs exactly one of a directory or a ref: `--from` with `--from-ref` (or `--to` with `--to-ref`) is a usage error, but `--from-ref v1.4.0 --to ./` (a ref on one side, a directory on the other) is fine. Options can also be written as `--from=<dir>`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No breaking changes. |
| `1` | At least one breaking change was found. |
| `2` | Usage error (bad or missing arguments, a directory and a ref given for the same side, or refs given outside a git repository), I/O error (directory missing, not a directory, or no `.ts` files in it), git error (unknown ref, or the current directory does not exist at that ref), or a missing or malformed baseline file. |

Changes suppressed by a baseline do not count: if every reported change is accepted, the exit code is `0`.

### Comparing git refs

Inside a git repository, either side can be a ref instead of a directory:

```sh
# the last release tag against the current commit
npx semver-guard compare --from-ref v1.4.0 --to-ref HEAD

# a branch against a commit SHA
npx semver-guard compare --from-ref main --to-ref 3f2c1ab

# the last release against your uncommitted working copy
npx semver-guard compare --from-ref v1.4.0 --to .
```

Each ref is resolved in the repository that contains the current directory and extracted with `git archive` into a temporary directory, which is deleted afterwards; your working tree, index and branches are not touched. The snapshot is the **current directory** at that ref, so run the command from the package directory (in a monorepo, `cd packages/my-lib` first, and `packages/my-lib` at each ref is compared). Labels in the output are the refs as you typed them.

Details:

- A ref is anything `git rev-parse` accepts that names a commit: tags, branches, SHAs, `HEAD~1`, `origin/main`.
- Only committed files are included. `git archive` honours `export-ignore` in `.gitattributes`, and does not include submodule contents or Git LFS file contents.
- If the current directory has a `node_modules` directory, it is linked into each temporary snapshot, so imported dependency types resolve the same way on both sides. Both refs therefore see the dependencies installed **now**, not the versions locked at each ref.
- `git` must be on the `PATH`, and so must `tar` (built into Linux, macOS and Windows 10 and later).

### Getting directory snapshots

Without git refs, both sides are plain directories. A worktree is an easy way to get the previous release next to your working copy:

```sh
git worktree add ../my-lib-v1.4.0 v1.4.0
npx semver-guard compare --from ../my-lib-v1.4.0 --to .
git worktree remove ../my-lib-v1.4.0
```

If your package has a `package.json` with `exports` or `main`, point at the package directory: only what its entry points export is compared (see [Entry points and the public surface](#entry-points-and-the-public-surface)). Otherwise, point at `src/` rather than the repository root, which keeps tests, scripts and examples out of the comparison (see [What gets scanned](#what-gets-scanned)).

### Example: table output

This is the output for the fixture packages in this repository (`fixtures/before` is version 1.4.0 and `fixtures/after` is a proposed 1.5.0):

```
$ semver-guard compare --from fixtures/before --to fixtures/after
semver-guard: fixtures/before -> fixtures/after (14 exports in 4 files checked)

CHANGE             EXPORT                   FILE           DETAILS
member-removed     Client#disconnect        src/client.ts  method disconnect was removed
                                                           before: disconnect(): void
                                                           also re-exported by: src/index.ts
member-removed     ClientOptions#timeoutMs  src/client.ts  property timeoutMs was removed
                                                           before: timeoutMs: number
                                                           also re-exported by: src/index.ts
type-changed       RequestMethod            src/client.ts  type alias declaration changed
                                                           before: 'GET' | 'POST' | 'PUT' | 'DELETE'
                                                           after:  'GET' | 'POST' | 'PUT'
signature-changed  formatDate               src/format.ts  parameter locale was renamed to options; type of parameter options changed from string to FormatOptions
                                                           before: (date: Date, locale: string): string
                                                           after:  (date: Date, options: FormatOptions): string
                                                           also re-exported by: src/index.ts
export-removed     legacyHelper             src/index.ts   function legacyHelper was removed
export-removed     legacyHelper             src/legacy.ts  function legacyHelper was removed

6 breaking changes found. Releasing this as a minor or patch version would break consumers; bump the major version.
$ echo $?
1
```

The same release also adds `parseDuration`, `FormatOptions`, `Client#ping`, an optional `ClientOptions#userAgent`, an optional `greet` parameter and a trailing `LogLevel.Fatal` member, and it rewrites the internal helpers `buildUrl` and `pad`. None of these are reported because none of them break consumers.

When nothing breaks:

```
$ semver-guard compare --from fixtures/after --to fixtures/after
semver-guard: fixtures/after -> fixtures/after (16 exports in 4 files checked)

No breaking changes found.
```

### Example: JSON output

```
$ semver-guard compare --from fixtures/before --to fixtures/after --format json
{
  "from": "fixtures/before",
  "to": "fixtures/after",
  "summary": {
    "breaking": 6,
    "filesBefore": 4,
    "filesAfter": 4,
    "exportsBefore": 14,
    "exportsAfter": 16
  },
  "changes": [
    {
      "code": "member-removed",
      "file": "src/client.ts",
      "export": "Client",
      "exportKind": "class",
      "member": "disconnect",
      "message": "method disconnect was removed",
      "before": "disconnect(): void",
      "reexportedBy": [
        "src/index.ts"
      ]
    },
    ...
  ]
}
```

With `--baseline`, `summary.breaking` counts only the changes still reported, and `summary` gains an `accepted` field with the number of suppressed changes. Without `--baseline` there is no `accepted` field.

Each entry in `changes` has these fields:

| Field | Always present | Description |
| --- | --- | --- |
| `code` | yes | Change category (see the rules below). |
| `file` | yes | Module path relative to the snapshot root, with `/` separators. |
| `export` | yes | Exported name. Namespace members are dotted (`Util.format`); default exports are `default`. |
| `exportKind` | yes | `function`, `class`, `interface`, `type`, `enum`, `variable`, `namespace` or `reexport` (the kind in the old version). |
| `message` | yes | Human-readable explanation. Several reasons are joined with `; `. |
| `member` | no | Class, interface or enum member. Static members are prefixed with `static `, index signatures look like `[string]`, call signatures are `()`, construct signatures are `new()`, and the class constructor is `constructor`. |
| `before` / `after` | no | The old and new declaration text, where it helps. |
| `reexportedBy` | no | Other modules that re-export this declaration and break in the same way. |

### Accepting changes with a baseline

When a breaking change is intentional (for example, you are preparing a major release), list it in a baseline file and pass `--baseline`:

```sh
npx semver-guard compare --from-ref v1.4.0 --to-ref HEAD --baseline semver-baseline.json
```

```json
{
  "accepted": [
    {
      "code": "signature-changed",
      "file": "src/format.ts",
      "export": "formatDate",
      "reason": "2.0 takes an options object instead of a locale string"
    },
    { "code": "member-removed", "file": "src/client.ts", "export": "Client", "member": "disconnect" },
    { "code": "export-removed", "export": "legacyHelper" }
  ]
}
```

Each entry identifies a change with the same fields as the [JSON output](#example-json-output):

| Field | Required | Matching |
| --- | --- | --- |
| `code` | yes | Must equal the change's `code`, and must be one of the codes listed under [Breaking-change rules](#breaking-change-rules). |
| `export` | yes | Must equal the change's `export` (dotted for namespace members, `default` for default exports). |
| `member` | no | Must equal the change's `member`. An entry **without** `member` only matches changes that have no member, so accepting `Client#disconnect` does not accept other changes to `Client`. |
| `file` | no | Must equal the change's `file`. Omit it to match the change in any file (the example above accepts `legacyHelper` being removed from both `src/legacy.ts` and `src/index.ts`). |
| `reason` | no | Free-form note for reviewers. Ignored by the tool. |

The other fields of a JSON report entry (`exportKind`, `message`, `before`, `after`, `reexportedBy`) are allowed and ignored, so you can paste entries from a report. A whole saved report also works as a baseline (its `changes` are all accepted), which is the quickest way to accept everything currently reported:

```sh
npx semver-guard compare --from-ref v1.4.0 --to-ref HEAD --format json > semver-baseline.json
```

Matching changes are removed from the table and the JSON output and do not affect the exit code. An entry that matches no reported change is not an error, but prints a warning on stderr so stale entries get cleaned up. With the example baseline above plus a stale entry for `Client#close`, the fixture comparison reports only the two changes that were not accepted:

```
$ semver-guard compare --from fixtures/before --to fixtures/after --baseline semver-baseline.json
semver-guard: warning: baseline entry member-removed Client#close in src/client.ts did not match any reported change (remove it from semver-baseline.json)
semver-guard: fixtures/before -> fixtures/after (14 exports in 4 files checked)

CHANGE          EXPORT                   FILE           DETAILS
member-removed  ClientOptions#timeoutMs  src/client.ts  property timeoutMs was removed
                                                        before: timeoutMs: number
                                                        also re-exported by: src/index.ts
type-changed    RequestMethod            src/client.ts  type alias declaration changed
                                                        before: 'GET' | 'POST' | 'PUT' | 'DELETE'
                                                        after:  'GET' | 'POST' | 'PUT'

2 breaking changes found. Releasing this as a minor or patch version would break consumers; bump the major version.
4 accepted breaking changes were suppressed by the baseline.
$ echo $?
1
```

Once the remaining changes are accepted too, the output says `No breaking changes found.` and the exit code is `0`.

A missing file, invalid JSON, an unknown field (to catch typos such as `memeber`), an unknown `code`, or a missing `code`/`export` is an error with exit code 2.

### In CI

Because a breaking change exits with code 1, the command can gate a release job directly. Fetch tags and history first so the ref can be resolved:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx semver-guard compare --from-ref "$(git describe --tags --abbrev=0)" --to-ref HEAD
```

### As a library

```ts
import { extractApi, compareSurfaces, formatTable, loadBaseline, applyBaseline } from 'semver-guard';

const result = compareSurfaces(extractApi('old'), extractApi('new'));
const { result: filtered, unused } = applyBaseline(result, loadBaseline('semver-baseline.json'));
if (filtered.changes.length > 0) console.log(formatTable(filtered));
```

`extractApi(dir, { entryPoints: false })` ignores `package.json` and treats every module as public. Unlike the CLI, `extractApi` decides about entry points per snapshot; use `findEntryPoints(dir)` on both sides if you want the CLI's both-or-neither rule.

## Breaking-change rules

semver-guard compares **declarations as written**, using the TypeScript type checker only to fill in types that are not annotated (inferred return types, inferred variable and property types). Two types are considered equal when their printed text is equal, after removing comments and collapsing whitespace. It does not check whether a new type is assignable to the old one, so widening a parameter from `string` to `string | number` is reported even though it is safe for callers. These rules err on the side of reporting a change.

### Exports

| Change | Breaking? | Code |
| --- | --- | --- |
| Export removed (including deleting the module that declared it) | **yes** | `export-removed` |
| Export changes kind (e.g. class → interface, function → variable) | **yes** | `kind-changed` |
| Exported variable/constant type changed | **yes** | `type-changed` |
| Unresolvable re-export (`export { x } from 'pkg'` with `pkg` not in the snapshot) now points somewhere else | **yes** | `type-changed` |
| New export or new module | no | |
| Any change to declarations that are not exported | no | |

A removed namespace is reported once, not once per member.

### Functions (also methods, constructors, call/construct signatures, and `const f = (...) => ...`)

Every signature (overload) of the old version must still exist in the new version. Within a signature, parameters are matched by position:

| Change | Breaking? |
| --- | --- |
| Parameter removed | **yes** |
| Parameter renamed | **yes** (names show up in editor hints and docs and are often relied on, so this rule is deliberately strict) |
| Parameter type changed | **yes** |
| Optional or defaulted parameter became required | **yes** |
| Parameter became, or stopped being, a rest parameter | **yes** |
| New **required** parameter | **yes** |
| Return type changed (annotated or inferred) | **yes** |
| Type parameter removed, constraint changed, or default changed or removed | **yes** |
| New type parameter **without** a default | **yes** |
| New **optional**, defaulted or rest parameter at the end | no |
| Required parameter became optional | no |
| New type parameter **with** a default | no |
| New overload added | no |
| Overload removed | **yes** |

### Classes

Public and protected members are part of the API (protected members matter to subclasses). `private` and `#private` members are ignored.

| Change | Breaking? | Code |
| --- | --- | --- |
| Public/protected member removed, renamed, or made `private` | **yes** | `member-removed` |
| Member type or method signature changed (rules above) | **yes** | `member-changed` |
| Member became optional, `readonly` or `abstract`, or visibility reduced from public to protected | **yes** | `member-changed` |
| Member changed from property to method or vice versa | **yes** | `member-changed` |
| Constructor signature changed (rules above, including inherited constructors) | **yes** | `signature-changed` |
| Constructor became `protected` or `private` | **yes** | `modifier-changed` |
| Class became `abstract` | **yes** | `modifier-changed` |
| `extends` clause removed or changed | **yes** | `heritage-changed` |
| Class type parameters changed (rules above) | **yes** | `type-parameters-changed` |
| New abstract member | **yes** (existing subclasses must implement it) | `member-added` |
| New non-abstract member | no | |
| Member stopped being `readonly`, or visibility widened from protected to public | no | |
| Property replaced by a getter/setter pair of the same type | no (a getter without a setter counts as a `readonly` property) | |

Constructor parameter properties (`constructor(public name: string)`) count as both a constructor parameter and a property. Static and instance members are matched separately: `static create` and `create` are different members.

### Interfaces

Interfaces are both *read* by consumers and *implemented* by consumers (object literals, `implements` clauses), so the rules work in both directions:

| Change | Breaking? | Code |
| --- | --- | --- |
| Member removed | **yes** | `member-removed` |
| Member type or method signature changed | **yes** | `member-changed` |
| Optional member became required, or required member became optional | **yes** | `member-changed` |
| Member became `readonly` | **yes** | `member-changed` |
| New **required** member, call signature, construct signature or index signature | **yes** (existing implementations no longer type-check) | `member-added` |
| A base interface removed from `extends` | **yes** | `heritage-changed` |
| Type parameters changed (rules above) | **yes** | `type-parameters-changed` |
| New **optional** property or method | no | |

Declaration-merged interfaces are compared as one interface.

### Type aliases

| Change | Breaking? | Code |
| --- | --- | --- |
| Any change to the aliased type text | **yes** | `type-changed` |
| Type parameters changed (rules above) | **yes** | `type-parameters-changed` |
| Formatting or comment changes only | no | |

### Enums

| Change | Breaking? | Code |
| --- | --- | --- |
| Member removed | **yes** | `enum-member-removed` |
| Member value changed, including implicit numeric values that shift because a member was inserted before them | **yes** | `enum-member-changed` |
| Regular `enum` became a `const enum` | **yes** | `modifier-changed` |
| New member that leaves existing values unchanged (e.g. appended at the end) | no | |

### Re-exports

When every module counts as public (no usable `package.json` entry points, see below), every module is treated as a possible entry point. When `index.ts` re-exports a declaration from `client.ts` (with `export { Client } from './client'`, `export * from './client'`, or by importing and exporting it again), a change to that declaration is reported once, at `client.ts`, and `reexportedBy` lists `index.ts`. If the re-export itself disappears from `index.ts`, that is reported separately as an `export-removed` for `index.ts`.

With entry points, only entry modules are compared, so a change to a re-exported declaration is reported at the entry module that exports it (with `reexportedBy` listing other entry modules that re-export it from that one).

## Entry points and the public surface

If the snapshot directory contains a `package.json` with an `exports` or `main` field, the public surface is **what the entry modules export**, and nothing else:

1. Every target in `exports` is an entry point: the `"."` entry, every subpath (`"./utils"`), every condition (`types`, `import`, `require`, `default`, ...), and every item of a fallback array. Non-code targets such as `"./package.json"` are skipped. Without `exports`, `main`, `types` and `typings` are used (as in Node.js, `main` is ignored when `exports` is present).
2. Each target is mapped to a TypeScript source in the snapshot. Targets usually point at compiled output, so semver-guard tries, in order: a `.ts`/`.mts`/`.cts` file at the same path (`./index.js` -> `index.ts`); the same path moved from the build directory to the source directory, using `outDir` and `rootDir` from `tsconfig.json` when present and otherwise `dist`, `lib`, `build` or `out` -> `src` or the root (`./dist/index.js` -> `src/index.ts`); and finally a declaration file next to the target (`./types/index.js` -> `types/index.d.ts`). Extensionless and directory targets also try `index.ts`.
3. The exports of the resolved entry modules are compared, following re-exports (`export *`, `export { x } from`, `export * as ns from`, imports that are exported again) into any module they reach. Modules **not reachable** from an entry point through imports, re-exports, `import()` types, `require` or `/// <reference path>` are ignored, so internal helpers, tests and scripts in the same directory can change freely.

Because exports are keyed by the entry module, **moving a declaration to another file is not a breaking change** as long as the same entry point still exports it. Removing it from the entry point is still reported, as `export-removed` at the entry module.

**Fallback.** When there is no `package.json`, it is not valid JSON, it has no `exports`/`main`/`types`/`typings`, or none of its targets can be mapped to a source file, every module counts as public, exactly as in version 1. The fallback is silent: there is no verbose mode, and the table and JSON formats are unchanged. With entry points, the header's file count includes only the modules reachable from them, and library users can check `ApiSurface.entryPoints` or call `findEntryPoints(dir)`. Entry points are only used when **both** snapshots have them; if one side falls back (for example, the new version adds an `exports` field), both sides use every module, so the comparison stays like for like.

Targets that cannot be mapped are skipped as long as at least one target resolves.

## What gets scanned

- Every `.ts`, `.mts` and `.cts` file under the directory, including `.d.ts` files, recursively.
- `node_modules` and any directory starting with `.` are skipped.
- Only modules (files with at least one `import` or `export`) contribute exports. Global script files are ignored.
- With `package.json` entry points, only the entry modules contribute exports, and only modules reachable from them are counted (see above). All files are still type-checked together.
- Both snapshots are type-checked with the same fixed settings (`strict: true`, ES2022, bundler module resolution), not the package's own `tsconfig.json`, so inferred types are computed the same way on both sides. Type errors in the snapshots do not stop the comparison.

## Current limitations

- **Entry-point limits.** Subpath patterns (`"./features/*": "./dist/features/*.js"`) are not expanded; if they are the only targets, the snapshot falls back to every module. Entry modules are keyed by their source file path, not by their subpath, so moving an entry module itself (changing `"."` from `src/index.ts` to `src/main.ts`) is reported as removing everything it exported. `typesVersions` and `imports` (`#internal`) are not read. Inferred types that the compiler can only print as `import("src/x").Foo` change text when `Foo` moves to another file. In the fallback mode (no usable entry points) every module counts as public, as before, and moving a declaration between files is still reported as a removal.
- **Git refs.** Refs come from the repository that contains the current directory, and the compared directory is the current directory at each ref (a different subdirectory per side is not supported; use a worktree and `--from <dir>` for that). Dependencies are taken from the current `node_modules` for both refs. Submodule and Git LFS contents are not included.
- **Textual type comparison.** Types are compared by their printed text, not by assignability. Safe widenings (a parameter accepting more types, a return type getting narrower) are reported as breaking, and `Array<string>` vs `string[]` counts as a change. Renaming a referenced type changes the text of every signature that uses it.
- **Parameter matching is positional.** Inserting an optional parameter in the middle is reported as changes to the parameters that follow it.
- **Not inspected yet:** `this` parameters, `implements` clauses, `declare module 'x'` / `declare global` augmentations, `export =` objects beyond their overall type, JSX (`.tsx`) files, and JavaScript files with JSDoc types.
- **Baseline matching is exact.** Entries match on `code`, `export`, `member` and optionally `file`; there are no wildcards or patterns, and an accepted change stays accepted even if it changes again in a different way under the same code (for example, a second, different signature change to an accepted function).

## Development

```sh
npm install      # install dependencies
npm run build    # compile src/ to dist/ with tsc
npm test         # run the vitest suite
```

Project layout:

| Path | Contents |
| --- | --- |
| `src/extract.ts` | Builds the exported API surface of a snapshot with the TypeScript compiler API, including entry-module reachability. |
| `src/entrypoints.ts` | Reads `package.json` `exports`/`main` and maps the targets to source files. |
| `src/git.ts` | Resolves git refs and extracts them into temporary snapshots with `git archive`. |
| `src/baseline.ts` | Loads and validates baseline files and suppresses accepted changes. |
| `src/compare.ts` | The breaking-change rules. |
| `src/format.ts` | Table and JSON output. |
| `src/run.ts` / `src/cli.ts` | Argument parsing, exit codes, and the executable entry point. |
| `src/model.ts` | Types shared by the modules above. |
| `fixtures/before`, `fixtures/after` | Two versions of a small package used by the tests and the examples above. |
| `test/` | `fixtures.test.ts` (fixture packages), `rules.test.ts` (one test group per rule, using temporary snapshots), `cli.test.ts` (arguments, exit codes, output formats, and the built executable), `git.test.ts` (ref inputs against temporary git repositories; skipped if `git` is not installed), `baseline.test.ts` (`--baseline`), `entrypoints.test.ts` (package.json entry points and the fallback). |

The tests in `cli.test.ts` that run `dist/cli.js` as a separate process are skipped until `npm run build` has been run. CI always builds first.

## License

MIT
