import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { COMPILER_OPTIONS, createHost, findSourceFiles } from './extract.js';
import type { DeclarationRef } from './model.js';

/**
 * Which direction of assignability keeps consumers compiling:
 *
 * - `contravariant` (parameters): the old type must be assignable to the new one,
 * - `covariant` (return types, read-only properties): the new type must be
 *   assignable to the old one,
 * - `invariant` (types that consumers both read and supply): both.
 * - `identical` (type alias targets): both, and the checker must also consider
 *   the two types identical. `string` and `string & {}` are assignable to
 *   each other but are not identical (they reduce differently in unions and
 *   conditional types); `Array<string>` and `string[]` are identical.
 */
export type Variance = 'contravariant' | 'covariant' | 'invariant' | 'identical';

/** A type whose text changed between versions, and where the new one is declared. */
export interface TypeQuery {
  /** Type text in the old version. */
  before: string;
  /** Type text in the new version. */
  after: string;
  /** Declaration in the new version that the type belongs to. */
  declaration: DeclarationRef;
  /** A parameter index, the return type of a signature, or the type of a property or index signature. */
  position: number | 'return' | 'type';
  variance: Variance;
}

export function typeQueryKey(query: TypeQuery): string {
  const { file, pos, end, kind } = query.declaration;
  return JSON.stringify([query.before, query.after, file, pos, end, kind, query.position, query.variance]);
}

/** Name of the probe declarations inserted into the new version. */
const PROBE = '__semverGuardOld';
const PROBE_NAME = new RegExp(`^${PROBE}(\\d+)$`);
/** Name of the identity test inserted next to a type alias probe. */
const IDENTITY_PROBE = '__semverGuardSame';
/** Name of the alias holding the new type, inserted after the old one for component props. */
const NEW_PROBE = '__semverGuardNew';

interface Probe {
  id: number;
  key: string;
  query: TypeQuery;
  /** Start and end of the inserted old type text in the modified file. */
  span?: { start: number; end: number };
  /** Start and end of the inserted new type text, for probes that insert both (component props). */
  afterSpan?: { start: number; end: number };
}

interface Insertion {
  at: number;
  text: string;
  probe: Probe;
  /** Offset of the old type text inside `text`. */
  typeOffset: number;
  /** Offset of the new type text inside `text`, when it is inserted too. */
  afterOffset?: number;
}

/**
 * Decides, with the type checker, which changed types are still compatible.
 *
 * The old type text is inserted next to the matching declaration in a copy of
 * the new version (as an extra parameter or property named `__semverGuardOld<n>`),
 * so names in it resolve in the new version's scope, including imports and
 * type parameters. The checker then compares that type with the new one by
 * assignability, in the direction given by the query's variance.
 *
 * Returns the answer for each query key. A query without an answer could not
 * be checked (missing file, old text that does not resolve in the new
 * version, a type involving `any`, ...); the caller falls back to comparing
 * the type texts.
 */
export function checkTypeQueries(root: string, queries: TypeQuery[]): Map<string, boolean> {
  const answers = new Map<string, boolean>();
  const byFile = new Map<string, Probe[]>();
  queries.forEach((query, id) => {
    const probes = byFile.get(query.declaration.file) ?? [];
    probes.push({ id, key: typeQueryKey(query), query });
    byFile.set(query.declaration.file, probes);
  });

  const modified = new Map<string, string>();
  const probesByFile = new Map<string, Probe[]>();
  for (const [file, probes] of byFile) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const original = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const insertions: Insertion[] = [];
    for (const probe of probes) {
      const insertion = planInsertion(original, probe);
      if (insertion) insertions.push(insertion);
    }
    if (insertions.length === 0) continue;
    insertions.sort((a, b) => a.at - b.at);
    let result = '';
    let last = 0;
    for (const insertion of insertions) {
      result += text.slice(last, insertion.at);
      const start = result.length + insertion.typeOffset;
      insertion.probe.span = { start, end: start + insertion.probe.query.before.length };
      if (insertion.afterOffset !== undefined) {
        const afterStart = result.length + insertion.afterOffset;
        insertion.probe.afterSpan = { start: afterStart, end: afterStart + insertion.probe.query.after.length };
      }
      result += insertion.text;
      last = insertion.at;
    }
    result += text.slice(last);
    modified.set(file, result);
    probesByFile.set(file, insertions.map((i) => i.probe));
  }
  if (modified.size === 0) return answers;

  const host = createHost();
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = modified.get(fileName) ?? modified.get(path.resolve(fileName));
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return getSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  let rootNames: string[];
  try {
    rootNames = [...new Set([...findSourceFiles(root), ...modified.keys()])];
  } catch {
    return answers;
  }
  const program = ts.createProgram({ rootNames, options: COMPILER_OPTIONS, host });
  const checker = program.getTypeChecker();
  const rootPrefix = toPosix(root) + '/';
  const isLocal = (sourceFile: ts.SourceFile): boolean => {
    const name = toPosix(sourceFile.fileName);
    return name.startsWith(rootPrefix) && !name.includes('/node_modules/');
  };

  for (const [file, probes] of probesByFile) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const inSpan = (d: ts.Diagnostic, span: { start: number; end: number }) =>
      d.start !== undefined && d.start < span.end && d.start + (d.length ?? 0) > span.start;
    // A probe that does not parse cleanly may have shifted the parse of the
    // rest of the file, so nothing in it can be trusted.
    const syntactic = program.getSyntacticDiagnostics(sourceFile);
    const spans = (p: Probe) => (p.afterSpan ? [p.span!, p.afterSpan] : [p.span!]);
    if (probes.some((p) => spans(p).some((span) => syntactic.some((d) => inSpan(d, span))))) continue;
    const semantic = program.getSemanticDiagnostics(sourceFile);
    const nodes = probeNodes(sourceFile);

    for (const probe of probes) {
      const node = nodes.get(probe.id);
      if (!node?.type || node.type.getStart() !== probe.span!.start || node.type.end !== probe.span!.end) continue;
      // Unresolved names and other errors in the old type (e.g. a type that no
      // longer exists): leave the decision to the text comparison.
      if (spans(probe).some((span) => semantic.some((d) => inSpan(d, span)))) continue;
      const oldType = checker.getTypeFromTypeNode(node.type);
      const newType = targetType(checker, node, probe.query);
      if (!newType) continue;
      // `any` is assignable in both directions, which would hide real changes.
      if (containsAny(checker, oldType, isLocal) || containsAny(checker, newType, isLocal)) continue;
      const widens = () => checker.isTypeAssignableTo(oldType, newType);
      const narrows = () => checker.isTypeAssignableTo(newType, oldType);
      const variance = probe.query.variance;
      if (variance === 'identical') {
        const same = identityProbe(node, probe.id);
        if (!same) continue;
        answers.set(probe.key, widens() && narrows() && checker.getTypeFromTypeNode(same.type) === checker.getTrueType());
        continue;
      }
      answers.set(
        probe.key,
        variance === 'contravariant' ? widens() : variance === 'covariant' ? narrows() : widens() && narrows(),
      );
    }
  }
  return answers;
}

/** Plans the insertion of the probe for one query, or returns undefined if that is not possible. */
function planInsertion(sourceFile: ts.SourceFile, probe: Probe): Insertion | undefined {
  const { query } = probe;
  if (!isTypeText(query.before)) return undefined;
  const decl = findNode(sourceFile, query.declaration);
  if (!decl) return undefined;
  if (ts.isVariableDeclaration(decl) || ts.isExportAssignment(decl)) return componentInsertion(sourceFile, decl, probe);
  const name = `${PROBE}${probe.id}`;
  const param = (at: number, prefix: string, suffix: string): Insertion => ({
    at,
    text: `${prefix}${name}: ${query.before}${suffix}`,
    typeOffset: prefix.length + name.length + 2,
    probe,
  });

  if (query.position === 'type') {
    if (ts.isTypeAliasDeclaration(decl)) return aliasInsertion(sourceFile, decl, probe);
    if (ts.isParameter(decl)) return param(decl.getStart(sourceFile), '', ', ');
    if (
      ts.isPropertyDeclaration(decl) ||
      ts.isPropertySignature(decl) ||
      ts.isGetAccessorDeclaration(decl) ||
      ts.isSetAccessorDeclaration(decl) ||
      ts.isIndexSignatureDeclaration(decl)
    ) {
      return param(decl.getStart(sourceFile), '', ';\n');
    }
    return undefined;
  }

  if (!isSignatureDeclaration(decl)) return undefined;
  // Arrow functions written without parentheses (`x => x`) have nowhere to add a parameter.
  if (sourceFile.text[decl.parameters.pos - 1] !== '(') return undefined;
  const params = decl.parameters.filter((p) => !isThisParameter(p));
  const thisParam = decl.parameters.find(isThisParameter);
  if (query.position === 'return') {
    if (decl.type && ts.isTypePredicateNode(decl.type)) return undefined;
    if (params.length > 0) return param(params[0].getStart(sourceFile), '', ', ');
    if (thisParam) return param(thisParam.end, ', ', '');
    return param(decl.parameters.pos, '', '');
  }
  const target = params[query.position];
  return target ? param(target.getStart(sourceFile), '', ', ') : undefined;
}

/**
 * Inserts, in front of a type alias, the old target as another alias, and an
 * alias that is `true` only if the checker considers the old and new targets
 * identical. The identity test compares two generic functions that differ
 * only in their conditional types, which the checker relates by type identity:
 *
 * ```ts
 * type __semverGuardOld0 = string;
 * type __semverGuardSame0 = (<T>() => T extends __semverGuardOld0 ? 1 : 2) extends (<T>() => T extends ID ? 1 : 2) ? true : false;
 * export type ID = string | number;
 * ```
 *
 * Generic aliases are not supported: their targets mention type parameters
 * that only exist inside each declaration.
 */
function aliasInsertion(sourceFile: ts.SourceFile, decl: ts.TypeAliasDeclaration, probe: Probe): Insertion | undefined {
  if (decl.typeParameters?.length || !(ts.isSourceFile(decl.parent) || ts.isModuleBlock(decl.parent))) return undefined;
  const name = `${PROBE}${probe.id}`;
  const prefix = `type ${name} = `;
  const test = (target: string) => `(<__semverGuardT>() => __semverGuardT extends ${target} ? 1 : 2)`;
  return {
    at: decl.getStart(sourceFile),
    text:
      `${prefix}${probe.query.before};\n` +
      `type ${IDENTITY_PROBE}${probe.id} = ${test(name)} extends ${test(decl.name.text)} ? true : false;\n`,
    typeOffset: prefix.length,
    probe,
  };
}

/**
 * For the props of a component typed as `FC<Props>` or wrapped in
 * `memo`/`forwardRef`, which has no parameter of its own to put a probe next
 * to: inserts both the old and the new props type as aliases in front of the
 * statement that declares the component, so both resolve in its scope.
 *
 * ```ts
 * type __semverGuardOld0 = { label: string };
 * type __semverGuardNew0 = { label: string | number };
 * export const Button = memo((props: { label: string | number }) => ...);
 * ```
 *
 * Only the props (parameter 0) are checked; the ref of a `forwardRef`
 * component is compared by its text.
 */
function componentInsertion(
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration | ts.ExportAssignment,
  probe: Probe,
): Insertion | undefined {
  if (probe.query.position !== 0 || !isTypeText(probe.query.after)) return undefined;
  let statement: ts.Node = decl;
  while (!ts.isSourceFile(statement.parent) && !ts.isModuleBlock(statement.parent)) {
    statement = statement.parent;
    if (!statement.parent) return undefined;
  }
  const prefix = `type ${PROBE}${probe.id} = `;
  const middle = `;\ntype ${NEW_PROBE}${probe.id} = `;
  return {
    at: statement.getStart(sourceFile),
    text: `${prefix}${probe.query.before}${middle}${probe.query.after};\n`,
    typeOffset: prefix.length,
    afterOffset: prefix.length + probe.query.before.length + middle.length,
    probe,
  };
}

/** The new type inserted right after a component props probe. */
function pairedNewType(probe: ts.TypeAliasDeclaration): ts.TypeAliasDeclaration | undefined {
  const statements = (probe.parent as ts.SourceFile | ts.ModuleBlock).statements;
  const next = statements[statements.indexOf(probe) + 1];
  const expected = probe.name.text.replace(PROBE, NEW_PROBE);
  return next && ts.isTypeAliasDeclaration(next) && next.name.text === expected ? next : undefined;
}

/** The identity test inserted after a type alias probe. */
function identityProbe(probe: ProbeNode, id: number): ts.TypeAliasDeclaration | undefined {
  if (!ts.isTypeAliasDeclaration(probe)) return undefined;
  const statements = (probe.parent as ts.SourceFile | ts.ModuleBlock).statements;
  const next = statements[statements.indexOf(probe) + 1];
  return next && ts.isTypeAliasDeclaration(next) && next.name.text === `${IDENTITY_PROBE}${id}` ? next : undefined;
}

/** The type of the new declaration that a probe was inserted in front of. */
function targetType(checker: ts.TypeChecker, probe: ProbeNode, query: TypeQuery): ts.Type | undefined {
  const fromAnnotation = (node: ts.TypeNode | undefined, decl: ts.Declaration) =>
    node ? checker.getTypeFromTypeNode(node) : declarationType(checker, decl);

  if (ts.isTypeAliasDeclaration(probe)) {
    const paired = pairedNewType(probe);
    if (paired) return checker.getTypeFromTypeNode(paired.type);
    // The old target alias, the identity test, then the new alias.
    const statements = (probe.parent as ts.SourceFile | ts.ModuleBlock).statements;
    const target = statements[statements.indexOf(probe) + 2];
    if (!target || !ts.isTypeAliasDeclaration(target) || isProbe(target)) return undefined;
    return checker.getTypeFromTypeNode(target.type);
  }

  if (query.position === 'return') {
    const decl = probe.parent;
    if (!isSignatureDeclaration(decl)) return undefined;
    if (decl.type) return ts.isTypePredicateNode(decl.type) ? undefined : checker.getTypeFromTypeNode(decl.type);
    const signature = checker.getSignatureFromDeclaration(decl);
    return signature && checker.getReturnTypeOfSignature(signature);
  }

  const siblings: readonly ts.Node[] | undefined = ts.isParameter(probe)
    ? (probe.parent as ts.SignatureDeclaration).parameters
    : ts.isClassLike(probe.parent) || ts.isInterfaceDeclaration(probe.parent)
      ? probe.parent.members
      : undefined;
  // Several probes can be inserted before the same declaration (a parameter
  // property is both a constructor parameter and a property): skip the others.
  const target = siblings?.slice(siblings.indexOf(probe) + 1).find((node) => !isProbe(node));
  if (!target) return undefined;
  // A property probe must sit right before the declaration it was planned for.
  if (query.position === 'type' && target.kind !== query.declaration.kind) return undefined;

  if (ts.isParameter(target)) return fromAnnotation(target.type, target);
  if (ts.isPropertyDeclaration(target) || ts.isPropertySignature(target)) return fromAnnotation(target.type, target);
  if (ts.isIndexSignatureDeclaration(target)) return checker.getTypeFromTypeNode(target.type);
  if (ts.isGetAccessorDeclaration(target)) return fromAnnotation(target.type, target);
  if (ts.isSetAccessorDeclaration(target)) {
    const value = target.parameters[0];
    return value ? fromAnnotation(value.type, value) : undefined;
  }
  return undefined;
}

function declarationType(checker: ts.TypeChecker, decl: ts.Declaration): ts.Type {
  const name = ts.getNameOfDeclaration(decl);
  const symbol = name && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
  return symbol ? checker.getTypeOfSymbolAtLocation(symbol, decl) : checker.getTypeAtLocation(decl);
}

/**
 * Whether a type is or contains `any`: directly, in a union or intersection,
 * in type arguments, or in the members of object types declared in the
 * snapshot itself. Members of standard library and dependency types are not
 * searched (many of them mention `any` somewhere).
 */
function containsAny(
  checker: ts.TypeChecker,
  type: ts.Type,
  isLocal: (sourceFile: ts.SourceFile) => boolean,
): boolean {
  const seen = new Set<ts.Type>();
  const visit = (t: ts.Type, depth: number): boolean => {
    if (t.flags & ts.TypeFlags.Any) return true;
    if (depth > 10 || seen.has(t)) return false;
    seen.add(t);
    if (t.aliasTypeArguments?.some((a) => visit(a, depth + 1))) return true;
    if (t.isUnionOrIntersection()) return t.types.some((u) => visit(u, depth + 1));
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    const objectType = t as ts.ObjectType;
    if (objectType.objectFlags & ts.ObjectFlags.Reference) {
      if (checker.getTypeArguments(t as ts.TypeReference).some((a) => visit(a, depth + 1))) return true;
    }
    const declarations = t.getSymbol()?.declarations ?? [];
    if (declarations.length === 0 || !declarations.every((d) => isLocal(d.getSourceFile()))) return false;
    for (const property of checker.getPropertiesOfType(t)) {
      if (visit(checker.getTypeOfSymbol(property), depth + 1)) return true;
    }
    for (const signature of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
      for (const parameter of signature.getParameters()) {
        if (visit(checker.getTypeOfSymbol(parameter), depth + 1)) return true;
      }
      if (visit(checker.getReturnTypeOfSignature(signature), depth + 1)) return true;
    }
    return checker.getIndexInfosOfType(t).some((info) => visit(info.type, depth + 1));
  };
  return visit(type, 0);
}

type ProbeNode = (ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature | ts.TypeAliasDeclaration) & {
  type?: ts.TypeNode;
};

function isProbe(node: ts.Node): boolean {
  const name = ts.getNameOfDeclaration(node as ts.Declaration);
  return name !== undefined && ts.isIdentifier(name) && PROBE_NAME.test(name.text);
}

/** Probe declarations in a modified file, by probe id. */
function probeNodes(sourceFile: ts.SourceFile): Map<number, ProbeNode> {
  const nodes = new Map<number, ProbeNode>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const match = PROBE_NAME.exec(node.name.text);
      if (match) nodes.set(Number(match[1]), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

function findNode(sourceFile: ts.SourceFile, ref: DeclarationRef): ts.Node | undefined {
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (node.pos === ref.pos && node.end === ref.end && node.kind === ref.kind) return node;
    if (node.pos > ref.pos || node.end < ref.end) return undefined;
    return ts.forEachChild(node, visit);
  };
  return ts.forEachChild(sourceFile, visit);
}

/** Whether `text` parses as exactly one type, so it can be inserted as a type annotation. */
function isTypeText(text: string): boolean {
  if (text.includes(PROBE)) return false;
  const prefix = 'type __T = ';
  const sourceFile = ts.createSourceFile('probe.ts', `${prefix}${text};`, ts.ScriptTarget.ES2022, true);
  const [statement] = sourceFile.statements;
  return (
    sourceFile.statements.length === 1 &&
    ts.isTypeAliasDeclaration(statement) &&
    statement.type.getStart(sourceFile) === prefix.length &&
    statement.type.end === prefix.length + text.length &&
    statement.end === sourceFile.text.length
  );
}

function isSignatureDeclaration(node: ts.Node): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isThisParameter(param: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(param.name) && param.name.text === 'this';
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
