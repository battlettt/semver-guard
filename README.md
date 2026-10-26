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
| `2` | Usage error (bad or missing arguments, a directory and a ref given for the same side, or refs given outside a git repository), I/O error (directory missing, not a directory, or no `.ts`/`.tsx` files in it), git error (unknown ref, or the current directory does not exist at that ref), or a missing or malformed baseline file. |

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
| `export` | yes | Must match the change's `export` (dotted for namespace members, `default` for default exports). May contain `*`, see [Wildcards](#wildcards). |
| `member` | no | Must match the change's `member`. May contain `*`. An entry **without** `member` only matches changes that have no member, so accepting `Client#disconnect` does not accept other changes to `Client`. |
| `file` | no | Must equal the change's `file` exactly (no wildcards). Omit it to match the change in any file (the example above accepts `legacyHelper` being removed from both `src/legacy.ts` and `src/index.ts`). |
| `reason` | no | Free-form note for reviewers. Ignored by the tool. |

#### Wildcards

`export` and `member` may contain `*` to accept a group of changes with one entry:

```json
{
  "accepted": [
    { "code": "member-removed", "export": "Button", "member": "on*", "reason": "event props moved to a single onEvent prop" },
    { "code": "export-removed", "export": "*", "reason": "2.0 drops the deprecated helpers" },
    { "code": "export-removed", "export": "Utils.*" }
  ]
}
```

The rules are exact:

- `*` matches any run of characters, including none. `on*` matches `on`, `onClick` and `onHover`; `*` matches everything.
- `*` matches every character, including `.`, so `Utils.*` matches every namespace member of `Utils` (`Utils.format`, `Utils.a.b`).
- `*` is the only wildcard. Every other character matches only itself: `?`, `[`, `]`, `{`, `}` and `\` have no special meaning (member keys such as `[string]` for an index signature or `()` for a call signature are written as they appear in the report).
- Each field is matched on its own; a pattern never crosses the export/member boundary. `export: "Button*"` matches the exports `Button` and `ButtonGroup`, not the members of `Button`. The rule about `member` still holds with wildcards: an entry without `member` matches only changes that have no member (so `export: "*"` alone accepts removed exports and other export-level changes of the given `code`, but no member changes), and `member: "*"` matches every change that has a member, but none without one.
- `code` is never a pattern (it must still be one of the known codes), and neither is `file`: a `*` in `file` is an error.
- `**` is an error (a single `*` already matches any run of characters, including `/` and `.`).
- Unknown fields are still rejected, so a misspelled `memebr` cannot silently widen an entry to the whole export.

Invalid patterns make the baseline file invalid: the tool exits with `2` before comparing anything. A wildcard entry that matches no change gets the same "did not match any reported change" warning as an exact entry.

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

semver-guard compares **declarations as written**. Types whose printed text is equal (after removing comments and collapsing whitespace) are always equal. When the type of a parameter, a return type, or the type of a class or interface property changes, the TypeScript type checker decides whether the change can break consumers, using the [compatibility rules](#type-compatibility-rules) below. When the target of a type alias changes, the checker decides whether the old and new targets are the same type (see [Type aliases](#type-aliases)). Everything else (exported variables, type parameter constraints and defaults, `extends` clauses) is compared by text. These rules err on the side of reporting a change.

### Type compatibility rules

A changed type is only reported if some consumer code that compiled against the old version could stop compiling. The type checker answers this by **assignability**, in the direction in which values flow:

| Position | Allowed change | Rule | Example that is **not** reported | Example that **is** reported |
| --- | --- | --- | --- | --- |
| Parameter of a function, class method or constructor, or of an interface method | Widening | The old type must be assignable to the new type, so every argument callers pass today is still accepted. | `f(a: string)` → `f(a: string \| number)`<br>`f(mode: 'light' \| 'dark')` → `f(mode: 'light' \| 'dark' \| 'system')` | `f(a: string \| number)` → `f(a: string)` |
| Return type of a function or class method, or the type of a `readonly` class property (including a getter without a setter) | Narrowing | The new type must be assignable to the old type, so every value callers receive is still something they handle. | `f(): string \| number` → `f(): string` | `f(): string` → `f(): string \| undefined` |
| Interface method return type; parameters and return type of interface call and construct signatures; writable class properties; interface properties | None | Assignable in both directions (equivalent types), because consumers both read these and supply them (object literals, `implements`, assignments). | `p: string[]` → `p: Array<string>` | `p: string` → `p: string \| number` |
| Target of an exported type alias | None | Assignable in both directions **and** identical to the checker. See [Type aliases](#type-aliases). | `type Names = Array<string>` → `type Names = string[]` | `type ID = string` → `type ID = string \| number`<br>`type ID = string` → `type ID = string & {}` |

Some changes that the text comparison of earlier versions reported are no longer reported, because the types are the same or compatible:

```ts
// before
export interface Options { verbose: boolean }
export declare function run(files: Array<string>, options: Options): string | number;

// after: not reported
export interface Options { verbose: boolean }
export type Settings = Options;
export declare function run(files: string[] | ReadonlySet<string>, options: Settings): string;
```

Interface method return types stay strict because a narrower return type breaks existing implementations that return the old, wider type. Interface method parameters may widen because TypeScript checks method parameters bivariantly, so existing implementations still compile.

**Non-exported parameter types.** A parameter annotated with the name of an interface or object type alias that is declared in the snapshot but **not exported** from its module (the usual `type Props = {...}` next to a component) is compared by its members, because the type is not compared anywhere else and its name alone would hide every change to it. The members are printed as an object type (`{ label: string; size?: number | undefined }`) and compared like any other parameter type, so adding an optional member or a union member is allowed, and adding a required member or removing a union member is reported:

```
signature-changed  Card  src/index.tsx  type of parameter { title, theme } (CardProps) changed from { title: string; theme?: Theme | undefined } to { title: string; theme: Theme }
```

This applies when the name is the same in both versions and refers to a top-level `interface` or `type` of the same module. Types that are exported are compared by their own rules where they are exported, and the signatures that mention them are only compared by name.

Each old overload only needs one compatible new signature, so merging `f(a: string)` and `f(a: number)` into a single `f(a: string | number)` is not reported.

The rules for the number of parameters do not change: an added optional, defaulted or rest parameter is allowed, an added required parameter and a removed parameter are reported.

**How it works.** For each changed type, semver-guard inserts the old type text next to the matching declaration in a copy of the new version (as an extra parameter, property, or, for a type alias, another type alias) and asks the type checker whether it is assignable to the new type. Names in the old type are therefore resolved in the new version's scope, including imports and type parameters. The snapshots on disk are not modified.

**Text fallback.** When the checker types are unavailable for a pair of types, semver-guard falls back to the text comparison for that pair and reports the change if the texts differ. This happens when:

- the old type refers to a name that no longer exists in the new version (for example, a type that was renamed or deleted), or has any other type error in the new version's scope,
- either type is or contains `any` (`any` is assignable in both directions, which would hide real changes),
- the declaration cannot hold the inserted old type: an arrow function written without parentheses (`x => x`), a type predicate return type (`x is string`), a signature that the checker synthesized without a declaration of its own, or a generic type alias (`type Box<T> = ...`, whose target mentions type parameters that only exist inside each version's declaration),
- the source file of the new declaration cannot be read.

The fallback is silent, like the entry-point fallback: the reported change looks the same as any other. Library users can turn off the checker entirely with `compareSurfaces(before, after, labels, { typeComparison: 'text' })`, which restores the text comparison of earlier versions.

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
| Parameter renamed | **yes** (names show up in editor hints and docs and are often relied on, so this rule is deliberately strict). Not reported for the props of `FC`-typed and `memo`/`forwardRef`-wrapped components, see [React components](#react-components-tsx). |
| Parameter type changed so that it no longer accepts everything it accepted before (narrowed or unrelated) | **yes** |
| Parameter type widened (e.g. `string` → `string \| number`, or a member added to a union) | no, see [compatibility rules](#type-compatibility-rules) |
| Optional or defaulted parameter became required | **yes** |
| Parameter became, or stopped being, a rest parameter | **yes** |
| New **required** parameter | **yes** |
| Return type changed (annotated or inferred) so that it can return something it could not before (widened or unrelated) | **yes** |
| Return type narrowed (e.g. `string \| number` → `string`) | no, except for interface methods and signatures, see [compatibility rules](#type-compatibility-rules) |
| Type parameter removed, constraint changed, or default changed or removed | **yes** |
| New type parameter **without** a default | **yes** |
| New **optional**, defaulted or rest parameter at the end | no |
| Required parameter became optional | no |
| New type parameter **with** a default | no |
| New overload added | no |
| Overload removed | **yes** |

### React components (`.tsx`)

`.tsx` files are scanned like `.ts` files: their exported functions, classes, interfaces, type aliases, enums and variables are part of the public surface, under the same rules. A function component is an exported function (or `const` arrow function) like any other, and its props are its first parameter, so props follow the parameter rule: they may **widen** and may not **narrow**.

```tsx
// 2.3.0
type ButtonProps = { label: string; variant: 'primary' | 'secondary' };
export function Button(props: ButtonProps) { /* ... */ }
interface CardProps { title: string; theme?: Theme }
export const Card = ({ title, theme }: CardProps) => /* ... */;
export function Tooltip({ text }: { text: string }) { /* ... */ }

// 2.4.0
type ButtonProps = { label: string; variant: 'primary' | 'secondary' | 'ghost'; icon?: string }; // widened: not reported
export function Button(props: ButtonProps) { /* ... */ }
interface CardProps { title: string; theme: Theme }                                            // narrowed: reported
export const Card = ({ title, theme }: CardProps) => /* ... */;
// Tooltip deleted                                                                              // removed: reported
```

```
$ semver-guard compare --from fixtures/components-before --to fixtures/components-after
semver-guard: fixtures/components-before -> fixtures/components-after (4 exports in 5 files checked)

CHANGE             EXPORT   FILE           DETAILS
signature-changed  Card     src/index.tsx  type of parameter { title, theme } (CardProps) changed from { title: string; theme?: Theme | undefined } to { title: string; theme: Theme }
                                           before: ({ title, theme }: CardProps): any
                                           after:  ({ title, theme }: CardProps): any
export-removed     Tooltip  src/index.tsx  function Tooltip was removed

2 breaking changes found. Releasing this as a minor or patch version would break consumers; bump the major version.
```

The same package also rewrites the non-exported `className` helper in `Button.tsx` and changes the signature of `iconFor` in `icons.tsx`, a module that `Button.tsx` imports but the entry point does not export. Neither is reported.

Props types are compared where they are written:

- **Inline** (`props: { label: string }`): compared as the parameter type.
- **Not exported** (`type Props = ...` or `interface Props` in the same module): compared by members, see [Non-exported parameter types](#type-compatibility-rules).
- **Exported** (`export interface ButtonProps`): reported on the props type itself, by the [interface](#interfaces) or [type alias](#type-aliases) rules, which are stricter than the parameter rule because consumers also read and implement exported types. For example, a new optional prop is fine, but widening a union-typed prop of an exported interface is reported.

#### `React.FC`, `memo` and `forwardRef`

Components that are not plain functions are compared by their props too, with the same parameter rule (widening allowed, narrowing reported):

| Form | Props come from |
| --- | --- |
| `export const Button: React.FC<ButtonProps> = (props) => ...` (also `FC<P>`, `FunctionComponent<P>`, `React.FunctionComponent<P>`) | The type argument `ButtonProps`. `FC` with no type argument has props `{}`. |
| `export const List = memo(function List(props: ListProps) { ... })` (also `React.memo`, arrow functions) | The inner function's first parameter. |
| `export const Box = memo(Inner)` / `export default memo(Inner)` | `Inner`, followed to its declaration in the snapshot: a function, an `FC`-typed constant, or another `memo`/`forwardRef` call. |
| `memo<ChipProps>(Chip)` | The type argument, which takes precedence over the inner function. |
| `export const Input = forwardRef<HTMLInputElement, InputProps>((props, ref) => ...)` (also `React.forwardRef`) | The second type argument; without type arguments, the render function's first parameter. |

A `forwardRef` component also has a `ref`, compared like an extra optional parameter: its target type (`HTMLInputElement`, taken from the first type argument or from a render parameter typed `Ref<T>`/`ForwardedRef<T>`) is compared **by text**, and a component that stops forwarding its ref (`forwardRef(...)` replaced by a plain function) is reported as `parameter ref was removed`. Starting to forward a ref is not reported.

```tsx
// 1.0.0
export const Badge: React.FC<{ label: string }> = ({ label }) => <span>{label}</span>;
export const Input = forwardRef<HTMLInputElement, { size: 'sm' | 'lg' }>((props, ref) => <input ref={ref} />);

// 1.1.0
export const Badge: React.FC<{ label: string | number }> = ({ label }) => <span>{label}</span>; // widened: not reported
export const Input = forwardRef<HTMLInputElement, { size: 'sm' }>((props, ref) => <input ref={ref} />);  // narrowed: reported
```

For these components, the report's `exportKind` is `function`, and `before`/`after` show the form and the props, e.g. `forwardRef (props: { size: 'sm' | 'lg'; }, ref?: HTMLInputElement)`. What they render (the return type) is not compared, and neither is the name of the props parameter, so switching between these forms and plain function components (`React.FC` -> `function Badge({ label }: Props)`, adding `memo`) is not reported as long as the props are compatible.

**Recognized by name, React not required.** `FC`, `FunctionComponent`, `memo` and `forwardRef` are recognized by their names (unqualified, or as the last part of a qualified name such as `React.FC`), not by resolving them to React's declarations. This keeps the comparison working in snapshots without React's types in `node_modules`, which is common for git-ref snapshots and minimal fixtures, and keeps the result the same whether or not they are installed. The flip side is that a function of your own called `memo` or `forwardRef`, or a type called `FC`, whose first argument or type argument is a component, is treated the same way. The props types themselves are still compared with the type checker: types that need React to resolve (for example a prop typed `React.ReactNode` without React installed) fall back to the text comparison.

JSX is type-checked with the automatic runtime (`jsx: react-jsx`, importing `react/jsx-runtime`). If the snapshot has React's types in `node_modules`, component return types are `JSX.Element` (or whatever the runtime declares); without them, JSX expressions are typed as `any` and return types print as `any` on both sides, which does not affect the props comparison.

### Classes

Public and protected members are part of the API (protected members matter to subclasses). `private` and `#private` members are ignored.

| Change | Breaking? | Code |
| --- | --- | --- |
| Public/protected member removed, renamed, or made `private` | **yes** | `member-removed` |
| Member type or method signature changed (rules above; a `readonly` property may narrow, a writable one must keep an equivalent type) | **yes** | `member-changed` |
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
| Member type or method signature changed (property types must stay equivalent; method parameters may widen; return types must stay equivalent) | **yes** | `member-changed` |
| Optional member became required, or required member became optional | **yes** | `member-changed` |
| Member became `readonly` | **yes** | `member-changed` |
| New **required** member, call signature, construct signature or index signature | **yes** (existing implementations no longer type-check) | `member-added` |
| A base interface removed from `extends` | **yes** | `heritage-changed` |
| Type parameters changed (rules above) | **yes** | `type-parameters-changed` |
| New **optional** property or method | no | |

Declaration-merged interfaces are compared as one interface.

### Type aliases

When the target of an exported type alias changes, the change is only allowed if the old and new targets are **the same type**: assignable to each other in both directions, *and* identical to the type checker.

| Change | Breaking? | Code |
| --- | --- | --- |
| Target widened (`type ID = string` → `string \| number`, a member added to a union) | **yes** | `type-changed` |
| Target narrowed or changed to an unrelated type | **yes** | `type-changed` |
| Target changed to a mutually assignable but not identical type (`string` → `string & {}`, `{ a: A } & { b: B }` → `{ a: A; b: B }`) | **yes** | `type-changed` |
| Target respelled as an identical type (`Array<string>` → `string[]`, `'a' \| 'b'` → `'b' \| 'a'`, reordered object members, `Record<string, number>` → `{ [key: string]: number }`, an interface → an object type with the same members) | no | |
| Type parameters changed (rules above) | **yes** | `type-parameters-changed` |
| Formatting or comment changes only | no | |

```ts
// before                         // after                                 reported?
export type ID = string;          export type ID = string | number;        // yes
export type Names = Array<string>; export type Names = string[];           // no
export type Tag = string;         export type Tag = string & {};           // yes
```

**Why widening is reported.** A wider parameter type is safe because callers only *supply* values. An alias is different: it is used in every position at once. Widening `ID` widens every signature and property that mentions it, so any function that returns an `ID`, or object that exposes one, can now hand callers a value they did not expect (a `number` where they call `id.toUpperCase()`), and consumers who use `ID` in their own declarations and type-level code see it change meaning. The signatures that mention the alias are not reported again; the change is reported once, on the alias.

**Why identity, not just mutual assignability.** `string` and `string & {}` accept exactly the same values, but they are different types: `'a' | string` reduces to `string`, while `'a' | (string & {})` keeps `'a'` (this is why the second form is used to keep editor suggestions), so conditional types, mapped types and unions over the alias can produce different results. semver-guard therefore requires the checker's own identity relation, the one TypeScript uses for `T extends X ? ...` comparisons. It is tested with a generic-function comparison inserted next to the alias:

```ts
type __semverGuardOld0 = string;
type __semverGuardSame0 = (<T>() => T extends __semverGuardOld0 ? 1 : 2) extends (<T>() => T extends ID ? 1 : 2) ? true : false;
```

Identity is structural for object types (member order and an interface vs. a type literal with the same members do not matter), but it does not merge intersections, so `{ a: A } & { b: B }` → `{ a: A; b: B }` is reported even though the two are interchangeable for most code. This errs on the side of reporting.

Generic aliases (`type Box<T> = ...`), targets that are or contain `any`, and old targets that refer to names that no longer exist fall back to the text comparison (see [Text fallback](#type-compatibility-rules)). Aliases referenced inside signatures and properties are not expanded there: those positions compare the alias name, and a change to the alias's target is reported on the alias.

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
2. Each target is mapped to a TypeScript source in the snapshot. Targets usually point at compiled output, so semver-guard tries, in order: a `.ts`/`.tsx`/`.mts`/`.cts` file at the same path (`./index.js` -> `index.ts`, or `index.tsx` if there is no `index.ts`; `./button.jsx` -> `button.tsx`); the same path moved from the build directory to the source directory, using `outDir` and `rootDir` from `tsconfig.json` when present and otherwise `dist`, `lib`, `build` or `out` -> `src` or the root (`./dist/index.js` -> `src/index.ts`); and finally a declaration file next to the target (`./types/index.js` -> `types/index.d.ts`). Extensionless and directory targets also try `.tsx`, `index.ts` and `index.tsx`.
3. The exports of the resolved entry modules are compared, following re-exports (`export *`, `export { x } from`, `export * as ns from`, imports that are exported again) into any module they reach. Modules **not reachable** from an entry point through imports, re-exports, `import()` types, `require` or `/// <reference path>` are ignored, so internal helpers, tests and scripts in the same directory can change freely.

Because exports are keyed by the entry module, **moving a declaration to another file is not a breaking change** as long as the same entry point still exports it. Removing it from the entry point is still reported, as `export-removed` at the entry module.

**Fallback.** When there is no `package.json`, it is not valid JSON, it has no `exports`/`main`/`types`/`typings`, or none of its targets can be mapped to a source file, every module counts as public, exactly as in version 1. The fallback is silent: there is no verbose mode, and the table and JSON formats are unchanged. With entry points, the header's file count includes only the modules reachable from them, and library users can check `ApiSurface.entryPoints` or call `findEntryPoints(dir)`. Entry points are only used when **both** snapshots have them; if one side falls back (for example, the new version adds an `exports` field), both sides use every module, so the comparison stays like for like.

Targets that cannot be mapped are skipped as long as at least one target resolves.

## What gets scanned

- Every `.ts`, `.tsx`, `.mts` and `.cts` file under the directory, including `.d.ts` files, recursively. `.js`, `.jsx` and other files are ignored.
- `node_modules` and any directory starting with `.` are skipped.
- Only modules (files with at least one `import` or `export`) contribute exports. Global script files are ignored.
- With `package.json` entry points, only the entry modules contribute exports, and only modules reachable from them are counted (see above). All files are still type-checked together.
- Both snapshots are type-checked with the same fixed settings (`strict: true`, ES2022, bundler module resolution, `jsx: react-jsx`), not the package's own `tsconfig.json`, so inferred types are computed the same way on both sides. Type errors in the snapshots do not stop the comparison.

## Current limitations

- **Entry-point limits.** Subpath patterns (`"./features/*": "./dist/features/*.js"`) are not expanded; if they are the only targets, the snapshot falls back to every module. Entry modules are keyed by their source file path, not by their subpath, so moving an entry module itself (changing `"."` from `src/index.ts` to `src/main.ts`) is reported as removing everything it exported. `typesVersions` and `imports` (`#internal`) are not read. Inferred types that the compiler can only print as `import("src/x").Foo` change text when `Foo` moves to another file. In the fallback mode (no usable entry points) every module counts as public, as before, and moving a declaration between files is still reported as a removal.
- **Git refs.** Refs come from the repository that contains the current directory, and the compared directory is the current directory at each ref (a different subdirectory per side is not supported; use a worktree and `--from <dir>` for that). Dependencies are taken from the current `node_modules` for both refs. Submodule and Git LFS contents are not included.
- **Text comparison outside signatures, properties and aliases.** Exported variable types, type parameter constraints and defaults, `extends` clauses and generic type alias targets are still compared by text, so widening a variable type is reported, and `Array<string>` vs `string[]` counts as a change there. Changed types inside signatures, properties and aliases also fall back to text when the checker cannot decide (see [Text fallback](#type-compatibility-rules)); in particular, renaming a referenced type (so that the old name no longer exists) is still reported in every signature that uses it.
- **Alias identity is strict.** Mutually assignable but not identical targets are reported, including an intersection replaced by the equivalent single object type (see [Type aliases](#type-aliases)).
- **Non-exported types are only expanded one level, and only as parameter types.** A non-exported `Props` type used directly as a parameter is compared by its members; a non-exported type used as a return type, a property type, or nested inside another type (`props: Props[]`, `Partial<Props>`, a member of `Props` whose type is another non-exported type) is still compared by name, so changes to its members are not seen. Renaming a non-exported parameter type is reported (the old name no longer resolves), even if its members are unchanged. Props declared in another module and imported count as exported from that module and are compared there (in the fallback mode) or not at all (with entry points, if the entry point does not export them).
- **Component typing styles.** `FC`/`FunctionComponent` annotations and `memo`/`forwardRef` wrappers are recognized by name (see [React components](#react-components-tsx)); other annotations (`ComponentType<P>`, `VFC<P>`, `ExoticComponent<P>`) and other wrappers (`lazy`, `styled(...)`, higher-order components of your own) are compared as exported variables, by text. A `forwardRef` ref target is compared by text, and a wrapped component whose props type is declared in another module and is not in scope where the component is exported falls back to the text comparison. Wrapping or unwrapping a component in `memo`, or switching between `FC` and a plain function, is not reported, although code that calls the component as a plain function (not through JSX) breaks when `memo` or `forwardRef` is added. A `const` whose initializer is cast (`memo(Inner) as typeof Inner`) is compared by the cast type. Class components are compared as classes. `defaultProps`, `propTypes` and the element types a component renders are not inspected.
- **Compatibility is checked per position.** Each changed parameter or return type is checked on its own, within the overload it belongs to. Type parameter constraints and defaults are still compared by text, so widening a constraint (`T extends string` → `T extends string | number`) is reported.
- **Parameter matching is positional.** Inserting an optional parameter in the middle is reported as changes to the parameters that follow it.
- **Not inspected yet:** `this` parameters, `implements` clauses, `declare module 'x'` / `declare global` augmentations, `export =` objects beyond their overall type, and JavaScript (`.js`/`.jsx`) files with JSDoc types.
- **Baseline matching.** Entries match on `code`, `export`, `member` and optionally `file`. Only `export` and `member` accept `*` wildcards; `file` and `code` are exact, and there are no character classes, alternatives or negations. An accepted change stays accepted even if it changes again in a different way under the same code (for example, a second, different signature change to an accepted function), and a wildcard entry also accepts future changes that happen to match it.

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
| `src/compat.ts` | Assignability checks for changed types, with the type checker. |
| `src/format.ts` | Table and JSON output. |
| `src/run.ts` / `src/cli.ts` | Argument parsing, exit codes, and the executable entry point. |
| `src/model.ts` | Types shared by the modules above. |
| `fixtures/before`, `fixtures/after` | Two versions of a small package used by the tests and the examples above. |
| `fixtures/components-before`, `fixtures/components-after` | Two versions of a small `.tsx` component package (widened props, narrowed props, a removed component, internal changes). |
| `test/` | `fixtures.test.ts` (fixture packages), `rules.test.ts` (one test group per rule, using temporary snapshots), `cli.test.ts` (arguments, exit codes, output formats, and the built executable), `git.test.ts` (ref inputs against temporary git repositories; skipped if `git` is not installed), `baseline.test.ts` (`--baseline`, including wildcard entries), `entrypoints.test.ts` (package.json entry points and the fallback), `compat.test.ts` (type compatibility rules, compared with the text comparison, and the text fallback), `tsx.test.ts` (`.tsx` files, component props and the component fixtures), `components.test.ts` (`React.FC`-typed, `memo` and `forwardRef` components), `alias.test.ts` (type alias identity and its fallback). |

The tests in `cli.test.ts` that run `dist/cli.js` as a separate process are skipped until `npm run build` has been run. CI always builds first.

## License

MIT
