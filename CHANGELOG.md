# Changelog

All notable changes to semver-guard are listed here. The project follows [Semantic Versioning](https://semver.org/).

Versions 1 and 2 were both published under the package version `0.1.0`. Version 3 is the first release under `0.2.0`.

## v6 (0.5.0): GitHub Action

### Added

- `action.yml`: a composite GitHub Action, so a workflow can run semver-guard in one step. Inputs: `from`, `to`, `from-ref`, `to-ref`, `baseline`, `format` (default `table`) and `working-directory` (default `.`, for a package in a monorepo). The step fails when breaking changes are found (exit code `1`) or on errors (exit code `2`), and passes otherwise.
- The action installs its dependencies and builds the CLI from source in its own checkout (`$GITHUB_ACTION_PATH`) on every run; no built `dist/` is committed.
- The step log shows the exact command that ran (`$ semver-guard compare --from-ref=... --to-ref=... --format=table`) followed by the report. A failure adds an error annotation (`6 breaking changes found. ...`, or the first line of the error), and the report is added to the job summary.
- Inputs are mapped to CLI arguments by `src/action.ts` (entry point `dist/action-cli.js`): values are trimmed, empty inputs are left out, each option is passed as `--name=value`, and a side with both or neither of its directory and ref inputs is rejected with the input names before the CLI runs. Inputs reach the step only through environment variables, never through `${{ inputs.* }}` inside a shell script.
- `examples/release-gate.yml`: a pull request workflow that compares the base branch with the head commit.

### Project

- `test/action.test.ts`: the input mapping, `runAction` against the fixtures and a temporary git repository, the built entry point, and checks that `action.yml` and the example parse and agree with the mapping module (207 tests).
- A CI job runs the action from the repository (`uses: ./`) and checks that it passes, fails on breaking changes, and fails on invalid inputs.
- `yaml` is a new dev dependency, used only by the tests.

## v5 (0.4.0): wildcard baselines and wrapped components

### Added

- Baseline entries may use `*` in `export` and `member`. `*` matches any run of characters (including none and including `.`); every other character is literal. Each field is matched separately, so a pattern never crosses the export/member boundary, and an entry without `member` still only matches changes without one. For example, `{ "code": "member-removed", "export": "Button", "member": "on*" }` accepts every removed `on*` member of `Button`, and `{ "code": "export-removed", "export": "*" }` accepts every removed export.
- Components typed as `React.FC<Props>`, `FC<Props>`, `FunctionComponent<Props>` or `React.FunctionComponent<Props>` are compared by their props with the parameter rule (widening allowed, narrowing reported), instead of by the text of the annotation.
- `memo(...)` and `forwardRef(...)` calls (also `React.memo`/`React.forwardRef`, nested `memo(forwardRef(...))`, references to a local component, and `export default memo(X)`) are unwrapped to find the inner component, whose props are compared the same way. Type arguments (`memo<Props>`, `forwardRef<Ref, Props>`) take precedence over the inner function's parameter. A `forwardRef` component's ref target is compared by text, and removing `forwardRef` is reported as `parameter ref was removed`.
- These forms are recognized by name; React's types do not have to be installed in the snapshot.
- `matchesPattern` is exported from the library entry point alongside the other baseline helpers.

### Changed

- For `FC`-typed and wrapped components, the return type and the name of the props parameter are not compared. Switching between these forms and a plain function component is not reported when the props stay compatible.
- `before`/`after` for these components show the form and the props, e.g. `memo (props: ListProps)`.
- A baseline `file` containing `*`, and an `export` or `member` containing `**`, are now errors (exit code `2`). Before, they were exact strings that could never match.

### Project

- `test/components.test.ts` and new wildcard tests in `test/baseline.test.ts` (175 tests).

## v4 (0.3.0): .tsx support and type alias identity

### Added

- `.tsx` files are scanned alongside `.ts`, `.mts` and `.cts`. Their exports count toward the public surface under the same rules, and `package.json` targets map to `.tsx` sources (`./dist/index.js` -> `src/index.tsx`, `./button.jsx` -> `button.tsx`, extensionless and directory targets try `.tsx` and `index.tsx`). JSX is type-checked with `jsx: react-jsx`.
- Function components need no special casing: props are the first parameter and follow the parameter rule (widening is allowed, narrowing is reported).
- A parameter annotated with a non-exported interface or object type alias of the same module (the usual `type Props = {...}`) is now compared by its members when its name is unchanged. Before, only the name was compared, so changes to such a type were never reported.

### Changed

- Changed type alias targets are compared with the type checker. A change is only allowed when the old and new targets are mutually assignable **and** identical to the checker: `Array<string>` -> `string[]` is no longer reported, while `string` -> `string | number` and `string` -> `string & {}` still are. Generic aliases, targets involving `any`, and old targets that no longer resolve fall back to the text comparison.
- The "no TypeScript files" error now reads `no TypeScript (.ts or .tsx) files found`.

### Project

- `fixtures/components-before` and `fixtures/components-after`: a small `.tsx` component package. CI runs the built CLI against it.
- `test/tsx.test.ts` and `test/alias.test.ts`.

## v3 (0.2.0): compatibility-aware comparison

### Changed

- Changed types in function, method and constructor signatures, and in class and interface properties, are now compared **by assignability** with the TypeScript type checker, not by their printed text. A change is only reported if it can break consumers:
  - A parameter type may widen (the old type must be assignable to the new one). For example, `string` to `string | number`, or adding a member to a union parameter, is no longer reported.
  - A return type, or the type of a `readonly` class property, may narrow (the new type must be assignable to the old one). For example, `string | number` to `string` is no longer reported.
  - Interface method return types, interface call and construct signatures, writable class properties and interface properties must keep an equivalent type (assignable in both directions), because consumers both read and supply them.
  - Equivalent spellings such as `Array<string>` and `string[]`, or a type alias that stands for the same type, are no longer reported.
- Where the checker cannot decide for a pair of types (the old type no longer resolves in the new version, either type involves `any`, the old type text cannot be inserted next to the new declaration, ...), that pair falls back to the text comparison from earlier versions and is reported if the text differs.
- `compareSurfaces` takes a fourth `options` argument. `{ typeComparison: 'text' }` restores the text-only comparison.

### Unchanged

- Parameter count rules: an added optional, defaulted or rest parameter is allowed; an added required parameter and a removed parameter are reported.
- Type aliases and exported variables are still compared by text.

### Project

- `test/compat.test.ts` covers the compatibility rules and compares them with the text comparison.
- CI runs the built CLI in ref mode (`--from-ref`/`--to-ref`) against a temporary git repository with two commits.

## v2 (0.1.0): git refs, baseline, entry points

### Added

- `--from-ref <ref>` and `--to-ref <ref>` compare git tags, branches or commits of the repository that contains the current directory. Each ref is extracted with `git archive` into a temporary snapshot. A directory on one side and a ref on the other is allowed; a directory and a ref for the same side is a usage error.
- `--baseline <file>`: a JSON file of accepted breaking changes. Matching changes are left out of the output and do not affect the exit code. Baseline entries that match nothing are listed as a warning on stderr. A missing or malformed baseline file exits with code 2.
- Entry-point-aware public surface: when a snapshot has a `package.json` with `exports`, `main`, `types` or `typings`, only what the entry modules export is compared, and modules not reachable from them are ignored. Moving a declaration to another file is no longer reported as long as the same entry point still exports it. Without usable entry points, every module counts as public, as in v1.

## v1 (0.1.0): initial release

### Added

- `semver-guard compare --from <dir> --to <dir> [--format table|json]` compares the exported API of the TypeScript sources in two directory snapshots.
- Breaking-change rules for exports, functions (parameters, overloads, return types, type parameters), classes, interfaces, type aliases, enums and re-exports, with types compared by their printed text.
- Table output for people and JSON output for scripts.
- Exit codes: `0` for no breaking changes, `1` for breaking changes, `2` for usage and I/O errors.
- Fixture packages, a vitest suite, and a GitHub Actions workflow for Node 20 and 22.
