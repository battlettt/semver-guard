import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { resolveEntryPoints, type EntryPoints } from './entrypoints.js';
import type {
  ApiSurface,
  ClassShape,
  DeclarationRef,
  EnumMember,
  EnumShape,
  ExportEntry,
  InterfaceShape,
  Member,
  Param,
  Shape,
  Signature,
  TypeParam,
} from './model.js';

/** Matches .ts, .mts and .cts files, including their .d.ts variants. */
const SOURCE_FILE = /\.[mc]?ts$/;
const IGNORED_DIRS = new Set(['node_modules']);

/**
 * Fixed compiler options used for both snapshots, so that inferred types are
 * computed the same way on each side of the comparison.
 */
export const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  types: [],
};

const TYPE_FORMAT =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

export class SnapshotError extends Error {}

/** Parsed standard library files, shared between programs because they never change. */
const libCache = new Map<string, ts.SourceFile>();

export function createHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const libDir = toPosix(path.dirname(host.getDefaultLibFileName(COMPILER_OPTIONS))) + '/';
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!toPosix(fileName).startsWith(libDir)) {
      return getSourceFile(fileName, languageVersion, onError, shouldCreate);
    }
    let cached = libCache.get(fileName);
    if (!cached) {
      cached = getSourceFile(fileName, languageVersion, onError, shouldCreate);
      if (cached) libCache.set(fileName, cached);
    }
    return cached;
  };
  return host;
}

/** Recursively lists TypeScript source files, skipping node_modules and dot-directories. */
export function findSourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

export interface ExtractOptions {
  /**
   * When true (the default), a `package.json` with `exports` or `main` in the
   * snapshot root limits the surface to what its entry points export. Set to
   * false to treat every module as public.
   */
  entryPoints?: boolean;
  /** How to name the snapshot in error messages. Defaults to `rootDir`. */
  label?: string;
}

/** Validates a snapshot directory and returns its real path. */
function snapshotRoot(rootDir: string, label = rootDir): string {
  let root: string;
  let stat: fs.Stats;
  try {
    // Resolve symlinks so module resolution and our root prefix agree.
    root = fs.realpathSync(path.resolve(rootDir));
    stat = fs.statSync(root);
  } catch {
    throw new SnapshotError(`directory not found: ${label}`);
  }
  if (!stat.isDirectory()) throw new SnapshotError(`not a directory: ${label}`);
  return root;
}

/**
 * Resolves the entry points declared in `<rootDir>/package.json` to source
 * files in the snapshot, or returns `undefined` if there is no package.json,
 * it has no `exports`/`main`, or none of its targets maps to a source file.
 */
export function findEntryPoints(rootDir: string): EntryPoints | undefined {
  const root = snapshotRoot(rootDir);
  const sources = new Set(findSourceFiles(root).map((f) => toPosix(path.relative(root, f))));
  return resolveEntryPoints(root, (rel) => sources.has(rel));
}

/**
 * Extracts the exported API surface of a snapshot: by default the exports of
 * its package.json entry points, or of every TypeScript module under
 * `rootDir` if there are none.
 */
export function extractApi(rootDir: string, options: ExtractOptions = {}): ApiSurface {
  const root = snapshotRoot(rootDir, options.label);
  const files = findSourceFiles(root);
  if (files.length === 0) {
    throw new SnapshotError(`no TypeScript (.ts) files found under ${options.label ?? rootDir}`);
  }
  const relOf = (file: string) => toPosix(path.relative(root, file));
  const sources = new Set(files.map(relOf));
  const entryPoints =
    options.entryPoints === false ? undefined : resolveEntryPoints(root, (rel) => sources.has(rel));

  const host = createHost();
  const program = ts.createProgram({ rootNames: files, options: COMPILER_OPTIONS, host });
  const extractor = new Extractor(program.getTypeChecker(), root);
  const exports: ExportEntry[] = [];
  const relFiles: string[] = [];

  if (entryPoints) {
    const entryFiles = entryPoints.files.map((rel) => path.join(root, rel));
    const reachable = reachableFiles(program, entryFiles, new Set(files), host);
    for (const file of files) {
      if (reachable.has(file)) relFiles.push(relOf(file));
    }
    for (const file of entryFiles) {
      const sourceFile = program.getSourceFile(file);
      if (sourceFile) exports.push(...extractor.moduleExports(sourceFile, relOf(file)));
    }
  } else {
    for (const file of files) {
      const sourceFile = program.getSourceFile(file);
      if (!sourceFile) continue;
      const rel = relOf(file);
      relFiles.push(rel);
      exports.push(...extractor.moduleExports(sourceFile, rel));
    }
  }

  exports.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.name, b.name));
  const surface: ApiSurface = { root, files: relFiles, exports };
  if (entryPoints) surface.entryPoints = entryPoints.files;
  return surface;
}

/**
 * Follows imports, re-exports, `import()` types, `require` calls and
 * `/// <reference path>` directives from `entries`, and returns every scanned
 * source file (from `sources`) that is reached.
 */
function reachableFiles(
  program: ts.Program,
  entries: string[],
  sources: Set<string>,
  host: ts.CompilerHost,
): Set<string> {
  const byPosix = new Map([...sources].map((f) => [toPosix(f), f]));
  const reached = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const targets: string[] = [];
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ts.resolveModuleName(specifier, file, COMPILER_OPTIONS, host).resolvedModule;
      if (resolved) targets.push(resolved.resolvedFileName);
    }
    for (const ref of sourceFile.referencedFiles) {
      targets.push(path.resolve(path.dirname(file), ref.fileName));
    }
    for (const target of targets) {
      const source = byPosix.get(toPosix(path.resolve(target)));
      if (source && !reached.has(source)) queue.push(source);
    }
  }
  return reached;
}

/** Every module specifier used by a file. */
function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // `declare module './x'` augments that module.
      specifiers.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

class Extractor {
  private readonly printer = ts.createPrinter({
    removeComments: true,
    newLine: ts.NewLineKind.LineFeed,
  });
  private readonly rootPrefix: string;

  constructor(
    private readonly checker: ts.TypeChecker,
    root: string,
  ) {
    this.rootPrefix = toPosix(root) + '/';
  }

  moduleExports(sourceFile: ts.SourceFile, rel: string): ExportEntry[] {
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    // Script files (no import/export statements) do not have module exports.
    if (!moduleSymbol) return [];
    const entries: ExportEntry[] = [];
    for (const symbol of this.checker.getExportsOfModule(moduleSymbol)) {
      this.collect(rel, symbol.getName(), symbol, entries, new Set());
    }
    return entries;
  }

  private collect(
    file: string,
    name: string,
    exported: ts.Symbol,
    out: ExportEntry[],
    visiting: Set<ts.Symbol>,
  ): void {
    const target =
      exported.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported;
    const declarations = target.declarations ?? [];

    if (declarations.length === 0) {
      out.push({ file, name, shapes: [{ kind: 'reexport', target: describeAlias(exported) }] });
      return;
    }

    const shapes: Shape[] = [];
    const functions = declarations.filter(ts.isFunctionDeclaration);
    const classes = declarations.filter(ts.isClassDeclaration);
    const interfaces = declarations.filter(ts.isInterfaceDeclaration);
    const aliases = declarations.filter(ts.isTypeAliasDeclaration);
    const enums = declarations.filter(ts.isEnumDeclaration);
    const variables = declarations.filter(ts.isVariableDeclaration);
    const assignments = declarations.filter(ts.isExportAssignment);
    const namespaces = declarations.filter(
      (d) => ts.isSourceFile(d) || (ts.isModuleDeclaration(d) && !ts.isStringLiteral(d.name)),
    );

    if (functions.length > 0) {
      shapes.push({ kind: 'function', signatures: this.callSignatures(target, functions[0]) });
    }
    if (classes.length > 0) shapes.push(this.classShape(classes[0], target));
    if (interfaces.length > 0) shapes.push(this.interfaceShape(interfaces));
    if (aliases.length > 0) {
      const alias = aliases[0];
      shapes.push({
        kind: 'type',
        typeParams: this.typeParams(alias.typeParameters),
        type: this.nodeText(alias.type),
      });
    }
    if (enums.length > 0) shapes.push(this.enumShape(enums));
    if (variables.length > 0) shapes.push(this.variableShape(variables[0], target));
    if (assignments.length > 0 && variables.length === 0) {
      shapes.push(this.expressionShape(assignments[0].expression));
    }
    if (namespaces.length > 0) shapes.push({ kind: 'namespace' });

    if (shapes.length === 0) {
      // Uncommon declaration forms (e.g. `export import x = require(...)`): fall
      // back to the type the checker reports for the symbol.
      if (target.flags & ts.SymbolFlags.Value) {
        shapes.push({ kind: 'variable', type: this.typeString(this.checker.getTypeOfSymbol(target)) });
      } else {
        shapes.push({
          kind: 'type',
          typeParams: [],
          type: this.typeString(this.checker.getDeclaredTypeOfSymbol(target)),
        });
      }
    }

    const entry: ExportEntry = { file, name, shapes };
    const origin = this.origin(target);
    if (origin && (origin.file !== file || origin.name !== name)) entry.origin = origin;
    out.push(entry);

    if (namespaces.length > 0 && !visiting.has(target)) {
      visiting.add(target);
      for (const member of this.checker.getExportsOfModule(target)) {
        this.collect(file, `${name}.${member.getName()}`, member, out, visiting);
      }
      visiting.delete(target);
    }
  }

  /**
   * Where a re-exported declaration (via `export { x } from`, `export *` or an
   * import that is exported again) is declared, if that is inside the snapshot.
   */
  private origin(target: ts.Symbol): ExportEntry['origin'] {
    if (target.flags & ts.SymbolFlags.Module) return undefined;
    const fileName = target.declarations?.[0]?.getSourceFile().fileName;
    if (!fileName || !fileName.startsWith(this.rootPrefix)) return undefined;
    return { file: fileName.slice(this.rootPrefix.length), name: target.getName() };
  }

  private variableShape(decl: ts.VariableDeclaration, symbol: ts.Symbol): Shape {
    if (!decl.type && decl.initializer && isFunctionExpressionLike(decl.initializer)) {
      return { kind: 'function', signatures: this.callSignatures(symbol, decl) };
    }
    return {
      kind: 'variable',
      type: decl.type
        ? this.nodeText(decl.type)
        : this.typeString(this.checker.getTypeOfSymbolAtLocation(symbol, decl), decl),
    };
  }

  private expressionShape(expression: ts.Expression): Shape {
    const type = this.checker.getTypeAtLocation(expression);
    if (isFunctionExpressionLike(expression)) {
      return {
        kind: 'function',
        signatures: type.getCallSignatures().map((s) => this.signature(s)),
      };
    }
    return { kind: 'variable', type: this.typeString(type, expression) };
  }

  private callSignatures(symbol: ts.Symbol, location: ts.Node): Signature[] {
    const type = this.checker.getTypeOfSymbolAtLocation(symbol, location);
    return type.getCallSignatures().map((s) => this.signature(s));
  }

  private classShape(decl: ts.ClassDeclaration, symbol: ts.Symbol): ClassShape {
    const extendsClause = decl.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const ctorDecls = decl.members.filter(ts.isConstructorDeclaration);
    let constructorVisibility: ClassShape['constructorVisibility'] = 'public';
    if (ctorDecls.length > 0 && ctorDecls.every((c) => hasModifier(c, ts.SyntaxKind.PrivateKeyword))) {
      constructorVisibility = 'private';
    } else if (
      ctorDecls.length > 0 &&
      ctorDecls.every((c) => hasModifier(c, ts.SyntaxKind.ProtectedKeyword))
    ) {
      constructorVisibility = 'protected';
    }
    const staticType = this.checker.getTypeOfSymbolAtLocation(symbol, decl);

    return {
      kind: 'class',
      isAbstract: hasModifier(decl, ts.SyntaxKind.AbstractKeyword),
      typeParams: this.typeParams(decl.typeParameters),
      extends: extendsClause ? this.nodeText(extendsClause.types[0]) : undefined,
      constructorVisibility,
      constructors: staticType.getConstructSignatures().map((s) => this.signature(s)),
      members: this.members(decl.members, true),
    };
  }

  private interfaceShape(decls: ts.InterfaceDeclaration[]): InterfaceShape {
    const heritage: string[] = [];
    const elements: ts.TypeElement[] = [];
    for (const decl of decls) {
      for (const clause of decl.heritageClauses ?? []) {
        for (const t of clause.types) heritage.push(this.nodeText(t));
      }
      elements.push(...decl.members);
    }
    return {
      kind: 'interface',
      typeParams: this.typeParams(decls[0].typeParameters),
      extends: heritage,
      members: this.members(elements, false),
    };
  }

  private enumShape(decls: ts.EnumDeclaration[]): EnumShape {
    const members: EnumMember[] = [];
    for (const decl of decls) {
      for (const member of decl.members) {
        const constant = this.checker.getConstantValue(member);
        let value: string | undefined;
        if (typeof constant === 'string') value = JSON.stringify(constant);
        else if (typeof constant === 'number') value = String(constant);
        else if (member.initializer) value = this.nodeText(member.initializer);
        members.push({ name: memberName(member.name, this), value });
      }
    }
    return {
      kind: 'enum',
      isConst: decls.some((d) => hasModifier(d, ts.SyntaxKind.ConstKeyword)),
      members,
    };
  }

  /** Builds the public/protected members of a class or interface body. */
  private members(elements: readonly (ts.ClassElement | ts.TypeElement)[], isClass: boolean): Member[] {
    interface Group {
      name: string;
      isStatic: boolean;
      visibility: Member['visibility'];
      decls: (ts.ClassElement | ts.TypeElement)[];
    }
    const groups = new Map<string, Group>();
    const result: Member[] = [];
    const addToGroup = (key: string, group: Omit<Group, 'decls'>, decl: ts.ClassElement | ts.TypeElement) => {
      const existing = groups.get(key);
      if (existing) existing.decls.push(decl);
      else groups.set(key, { ...group, decls: [decl] });
    };

    for (const element of elements) {
      if (ts.isConstructorDeclaration(element)) {
        result.push(...this.parameterProperties(element));
        continue;
      }
      if (hasModifier(element, ts.SyntaxKind.PrivateKeyword)) continue;
      if (element.name && ts.isPrivateIdentifier(element.name)) continue;
      const visibility = hasModifier(element, ts.SyntaxKind.ProtectedKeyword) ? 'protected' : 'public';
      const isStatic = hasModifier(element, ts.SyntaxKind.StaticKeyword);
      const prefix = isStatic ? 'static ' : '';

      if (ts.isIndexSignatureDeclaration(element)) {
        const keyType = element.parameters[0]?.type;
        const key = `${prefix}[${keyType ? this.nodeText(keyType) : 'unknown'}]`;
        result.push({
          key,
          name: key,
          kind: 'index',
          optional: false,
          readonly: hasModifier(element, ts.SyntaxKind.ReadonlyKeyword),
          isStatic,
          isAbstract: false,
          visibility,
          type: this.nodeText(element.type),
          declaration: declarationRef(element),
        });
        continue;
      }
      if (ts.isCallSignatureDeclaration(element) || ts.isConstructSignatureDeclaration(element)) {
        const key = ts.isCallSignatureDeclaration(element) ? '()' : 'new()';
        addToGroup(key, { name: key, isStatic: false, visibility }, element);
        continue;
      }
      if (!element.name) continue;
      const name = memberName(element.name, this);
      addToGroup(prefix + name, { name, isStatic, visibility }, element);
    }

    for (const [key, group] of groups) {
      result.push(this.memberFromGroup(key, group.name, group.isStatic, group.visibility, group.decls, isClass));
    }
    return result.sort((a, b) => compareStrings(a.key, b.key));
  }

  private memberFromGroup(
    key: string,
    name: string,
    isStatic: boolean,
    visibility: Member['visibility'],
    decls: (ts.ClassElement | ts.TypeElement)[],
    isClass: boolean,
  ): Member {
    const first = decls[0];
    const base = {
      key,
      name,
      isStatic,
      visibility,
      optional: decls.some((d) => 'questionToken' in d && d.questionToken !== undefined),
      isAbstract: isClass && decls.some((d) => hasModifier(d, ts.SyntaxKind.AbstractKeyword)),
    };

    if (ts.isCallSignatureDeclaration(first) || ts.isConstructSignatureDeclaration(first)) {
      return {
        ...base,
        kind: ts.isCallSignatureDeclaration(first) ? 'call' : 'construct',
        readonly: false,
        signatures: this.declarationSignatures(decls as ts.SignatureDeclaration[]),
      };
    }

    const methods = decls.filter(
      (d): d is ts.MethodDeclaration | ts.MethodSignature =>
        ts.isMethodDeclaration(d) || ts.isMethodSignature(d),
    );
    if (methods.length > 0) {
      return {
        ...base,
        kind: 'method',
        readonly: false,
        signatures: this.declarationSignatures(methods),
      };
    }

    const accessors = decls.filter(
      (d): d is ts.AccessorDeclaration => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d),
    );
    if (accessors.length > 0) {
      const getter = accessors.find(ts.isGetAccessorDeclaration);
      const setter = accessors.find(ts.isSetAccessorDeclaration);
      const annotation = getter?.type ?? setter?.parameters[0]?.type;
      return {
        ...base,
        kind: 'property',
        readonly: !setter,
        type: annotation ? this.nodeText(annotation) : this.declarationType(first),
        declaration: declarationRef(getter ?? first),
      };
    }

    const property = first as ts.PropertyDeclaration | ts.PropertySignature;
    return {
      ...base,
      kind: 'property',
      readonly: hasModifier(property, ts.SyntaxKind.ReadonlyKeyword),
      type: property.type
        ? this.nodeText(property.type)
        : isClass
          ? this.declarationType(property)
          : 'any',
      declaration: declarationRef(property),
    };
  }

  /** `constructor(public readonly x: T)` declares a property `x`. */
  private parameterProperties(ctor: ts.ConstructorDeclaration): Member[] {
    const members: Member[] = [];
    for (const param of ctor.parameters) {
      if (!ts.isParameterPropertyDeclaration(param, ctor)) continue;
      if (hasModifier(param, ts.SyntaxKind.PrivateKeyword)) continue;
      const name = this.nodeText(param.name);
      members.push({
        key: name,
        name,
        kind: 'property',
        optional: param.questionToken !== undefined,
        readonly: hasModifier(param, ts.SyntaxKind.ReadonlyKeyword),
        isStatic: false,
        isAbstract: false,
        visibility: hasModifier(param, ts.SyntaxKind.ProtectedKeyword) ? 'protected' : 'public',
        type: param.type ? this.nodeText(param.type) : this.declarationType(param),
        declaration: declarationRef(param),
      });
    }
    return members;
  }

  /** Signatures of overloaded declarations, excluding the implementation when overloads exist. */
  private declarationSignatures(decls: ts.SignatureDeclaration[]): Signature[] {
    const overloads = decls.filter((d) => !('body' in d) || d.body === undefined);
    const used = overloads.length > 0 ? overloads : decls;
    const signatures: Signature[] = [];
    for (const decl of used) {
      const signature = this.checker.getSignatureFromDeclaration(decl);
      if (signature) signatures.push(this.signature(signature));
    }
    return signatures;
  }

  private declarationType(decl: ts.Declaration): string {
    const name = ts.getNameOfDeclaration(decl);
    const symbol = name ? this.checker.getSymbolAtLocation(name) : undefined;
    const type = symbol
      ? this.checker.getTypeOfSymbolAtLocation(symbol, decl)
      : this.checker.getTypeAtLocation(decl);
    return this.typeString(type, decl);
  }

  private signature(signature: ts.Signature): Signature {
    const decl = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
    const typeParams: TypeParam[] = (signature.getTypeParameters() ?? []).map((tp) => {
      const tpDecl = tp.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
      return tpDecl ? this.typeParam(tpDecl) : { name: tp.symbol?.getName() ?? 'T' };
    });
    const params: Param[] = signature.getParameters().map((symbol) => {
      const paramDecl =
        symbol.valueDeclaration && ts.isParameter(symbol.valueDeclaration)
          ? symbol.valueDeclaration
          : undefined;
      if (!paramDecl) {
        return {
          name: symbol.getName(),
          type: this.typeString(this.checker.getTypeOfSymbol(symbol), decl),
          optional: false,
          rest: false,
        };
      }
      return {
        name: this.nodeText(paramDecl.name),
        type: paramDecl.type
          ? this.nodeText(paramDecl.type)
          : this.typeString(this.checker.getTypeOfSymbolAtLocation(symbol, paramDecl), paramDecl),
        optional:
          paramDecl.questionToken !== undefined ||
          paramDecl.initializer !== undefined ||
          this.checker.isOptionalParameter(paramDecl),
        rest: paramDecl.dotDotDotToken !== undefined,
      };
    });
    const returnType =
      decl?.type !== undefined
        ? this.nodeText(decl.type)
        : this.typeString(this.checker.getReturnTypeOfSignature(signature), decl);
    const result: Signature = { typeParams, params, returnType };
    if (decl) result.declaration = declarationRef(decl);
    return result;
  }

  private typeParams(decls: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): TypeParam[] {
    return (decls ?? []).map((d) => this.typeParam(d));
  }

  private typeParam(decl: ts.TypeParameterDeclaration): TypeParam {
    const result: TypeParam = { name: decl.name.text };
    if (decl.constraint) result.constraint = this.nodeText(decl.constraint);
    if (decl.default) result.default = this.nodeText(decl.default);
    return result;
  }

  /** Prints a syntax node with comments removed and whitespace collapsed. */
  nodeText(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    return normalizeWhitespace(this.printer.printNode(ts.EmitHint.Unspecified, node, sourceFile));
  }

  private typeString(type: ts.Type, enclosing?: ts.Node): string {
    const text = this.checker.typeToString(type, enclosing, TYPE_FORMAT);
    // Types from other modules may print as import("/abs/path/to/root/x").Foo;
    // strip the snapshot root so both sides compare equal.
    return normalizeWhitespace(text.split(this.rootPrefix).join(''));
  }
}

function declarationRef(node: ts.Node): DeclarationRef {
  return { file: node.getSourceFile().fileName, pos: node.pos, end: node.end, kind: node.kind };
}

function memberName(name: ts.PropertyName, extractor: Extractor): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return extractor.nodeText(name);
}

function describeAlias(symbol: ts.Symbol): string {
  const decl = symbol.declarations?.[0];
  if (!decl) return symbol.getName();
  let node: ts.Node | undefined = decl;
  while (node && !ts.isExportDeclaration(node) && !ts.isImportDeclaration(node)) node = node.parent;
  const specifier =
    node && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? ` from "${node.moduleSpecifier.text}"`
      : '';
  return `${normalizeWhitespace(decl.getText())}${specifier}`;
}

function isFunctionExpressionLike(node: ts.Expression): boolean {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return ts.isArrowFunction(expr) || ts.isFunctionExpression(expr);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
