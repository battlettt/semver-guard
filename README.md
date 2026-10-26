# semver-guard

Catch breaking API changes in a TypeScript package **before** you release them as a minor or patch version.

```sh
semver-guard compare --from ./v1.4.0 --to ./v1.5.0
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
semver-guard compare --from <dir> --to <dir> [--format table|json]
semver-guard --help
semver-guard --version
```

| Option | Description |
| --- | --- |
| `--from <dir>` | Directory snapshot of the previous (released) version. |
| `--to <dir>` | Directory snapshot of the new version. |
| `--format table\|json` | Output format. `table` (default) is for humans; `json` is for scripts. |

Options can also be written as `--from=<dir>`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No breaking changes. |
| `1` | At least one breaking change was found. |
| `2` | Usage error (bad or missing arguments) or I/O error (directory missing, not a directory, or no `.ts` files in it). |

### Getting snapshots

In v1 both sides are plain directories. With git, a worktree is the easiest way to get the previous release next to your working copy:

```sh
git worktree add ../my-lib-v1.4.0 v1.4.0
npx semver-guard compare --from ../my-lib-v1.4.0/src --to ./src
git worktree remove ../my-lib-v1.4.0
```

Pointing at `src/` rather than the repository root keeps tests, scripts and examples out of the comparison (see [What gets scanned](#what-gets-scanned)).

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

### In CI

Because a breaking change exits with code 1, the command can gate a release job directly:

```yaml
- run: git worktree add ../previous "$(git describe --tags --abbrev=0)"
- run: npx semver-guard compare --from ../previous/src --to ./src
```

### As a library

```ts
import { extractApi, compareSurfaces, formatTable } from 'semver-guard';

const result = compareSurfaces(extractApi('old/src'), extractApi('new/src'));
if (result.changes.length > 0) console.log(formatTable(result));
```

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

Every module is treated as a possible entry point. When `index.ts` re-exports a declaration from `client.ts` (with `export { Client } from './client'`, `export * from './client'`, or by importing and exporting it again), a change to that declaration is reported once, at `client.ts`, and `reexportedBy` lists `index.ts`. If the re-export itself disappears from `index.ts`, that is reported separately as an `export-removed` for `index.ts`.

## What gets scanned

- Every `.ts`, `.mts` and `.cts` file under the directory, including `.d.ts` files, recursively.
- `node_modules` and any directory starting with `.` are skipped.
- Only modules (files with at least one `import` or `export`) contribute exports. Global script files are ignored.
- Both snapshots are type-checked with the same fixed settings (`strict: true`, ES2022, bundler module resolution), not the package's own `tsconfig.json`, so inferred types are computed the same way on both sides. Type errors in the snapshots do not stop the comparison.

## Current limitations

- **Directory snapshots only.** v1 has no git-ref support (`--from v1.4.0`). Check out the old version yourself, for example with `git worktree`, as shown above.
- **Every module counts as public.** semver-guard does not read `package.json` `exports`/`main`, so changing an `export`ed declaration in a module that consumers cannot actually reach through your entry point is still reported. Point `--from`/`--to` at the directory that holds your public modules, and move internals into non-exported declarations, to reduce noise. Because exports are keyed by file path, moving a declaration to another file is reported as a removal (unless the old path still re-exports it).
- **Textual type comparison.** Types are compared by their printed text, not by assignability. Safe widenings (a parameter accepting more types, a return type getting narrower) are reported as breaking, and `Array<string>` vs `string[]` counts as a change. Renaming a referenced type changes the text of every signature that uses it.
- **Parameter matching is positional.** Inserting an optional parameter in the middle is reported as changes to the parameters that follow it.
- **Not inspected yet:** `this` parameters, `implements` clauses, `declare module 'x'` / `declare global` augmentations, `export =` objects beyond their overall type, JSX (`.tsx`) files, and JavaScript files with JSDoc types.
- **No suppression mechanism.** There is no way to mark a reported change as intentional other than bumping the major version.

## Development

```sh
npm install      # install dependencies
npm run build    # compile src/ to dist/ with tsc
npm test         # run the vitest suite
```

Project layout:

| Path | Contents |
| --- | --- |
| `src/extract.ts` | Builds the exported API surface of a snapshot with the TypeScript compiler API. |
| `src/compare.ts` | The breaking-change rules. |
| `src/format.ts` | Table and JSON output. |
| `src/run.ts` / `src/cli.ts` | Argument parsing, exit codes, and the executable entry point. |
| `src/model.ts` | Types shared by the modules above. |
| `fixtures/before`, `fixtures/after` | Two versions of a small package used by the tests and the examples above. |
| `test/` | `fixtures.test.ts` (fixture packages), `rules.test.ts` (one test group per rule, using temporary snapshots), `cli.test.ts` (arguments, exit codes, output formats, and the built executable). |

The tests in `cli.test.ts` that run `dist/cli.js` as a separate process are skipped until `npm run build` has been run. CI always builds first.

## License

MIT
