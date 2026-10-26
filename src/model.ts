/**
 * Data model for an extracted API surface and for the changes found when
 * comparing two surfaces.
 */

export interface TypeParam {
  name: string;
  constraint?: string;
  default?: string;
}

export interface Param {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
  /**
   * Members of the parameter's type, e.g. `{ label: string; size?: number }`,
   * when it is annotated with a reference to an object type that is declared
   * in the snapshot but not exported from its module (such as the `Props` of
   * a component). Such a type is compared nowhere else, so its name alone
   * would hide changes to it.
   */
  structure?: string;
}

/**
 * Where a declaration sits in a snapshot source file. Used to look up its
 * types with the type checker when two versions are compared.
 */
export interface DeclarationRef {
  /** Absolute file name as seen by the compiler. */
  file: string;
  pos: number;
  end: number;
  /** `ts.SyntaxKind` of the declaration node. */
  kind: number;
}

export interface Signature {
  typeParams: TypeParam[];
  params: Param[];
  returnType: string;
  /** The declaration this signature comes from, when it has one. */
  declaration?: DeclarationRef;
}

export type MemberKind = 'property' | 'method' | 'call' | 'construct' | 'index';

export interface Member {
  /** Stable key used to match members across versions, e.g. `static create` or `[key: string]`. */
  key: string;
  name: string;
  kind: MemberKind;
  optional: boolean;
  readonly: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  visibility: 'public' | 'protected';
  /** Type of a property or index signature. */
  type?: string;
  /** Signatures of a method, call or construct signature. */
  signatures?: Signature[];
  /** Declaration of a property or index signature (the getter for accessor pairs). */
  declaration?: DeclarationRef;
}

export interface FunctionShape {
  kind: 'function';
  signatures: Signature[];
  /**
   * Set for a React component that is not a plain function: a variable
   * annotated as `FC<Props>`/`FunctionComponent<Props>`, or a `memo(...)` or
   * `forwardRef(...)` call. Describes the form, e.g. `React.FC`, `memo` or
   * `memo(forwardRef)`. Its single signature lists the props (and, for
   * `forwardRef`, the optional ref) as parameters; its return type is empty
   * and not compared.
   */
  component?: string;
}

export interface ClassShape {
  kind: 'class';
  isAbstract: boolean;
  typeParams: TypeParam[];
  extends?: string;
  constructorVisibility: 'public' | 'protected' | 'private';
  constructors: Signature[];
  members: Member[];
}

export interface InterfaceShape {
  kind: 'interface';
  typeParams: TypeParam[];
  extends: string[];
  members: Member[];
}

export interface TypeAliasShape {
  kind: 'type';
  typeParams: TypeParam[];
  type: string;
  /** The alias declaration, used to compare a changed target with the type checker. */
  declaration?: DeclarationRef;
}

export interface EnumMember {
  name: string;
  /** Constant value if it can be determined statically, otherwise the initializer text. */
  value?: string;
}

export interface EnumShape {
  kind: 'enum';
  isConst: boolean;
  members: EnumMember[];
}

export interface VariableShape {
  kind: 'variable';
  type: string;
}

export interface NamespaceShape {
  kind: 'namespace';
}

export interface ReexportShape {
  kind: 'reexport';
  /** Description of the re-export target that could not be resolved inside the snapshot. */
  target: string;
}

export type Shape =
  | FunctionShape
  | ClassShape
  | InterfaceShape
  | TypeAliasShape
  | EnumShape
  | VariableShape
  | NamespaceShape
  | ReexportShape;

export type ShapeKind = Shape['kind'];

export interface ExportEntry {
  /** Path of the declaring module relative to the snapshot root, using `/` separators. */
  file: string;
  /** Exported name. Namespace members use dotted names such as `Utils.format`. */
  name: string;
  /**
   * One shape per declaration kind. Most exports have exactly one; declaration
   * merging (e.g. a function and a namespace with the same name) yields several.
   */
  shapes: Shape[];
  /**
   * Set when this export re-exports a declaration that is itself exported
   * from another module (or under another name) inside the snapshot.
   */
  origin?: { file: string; name: string };
}

export interface ApiSurface {
  root: string;
  /**
   * Modules that make up the surface. With entry points, these are the
   * modules reachable from them; otherwise every source file.
   */
  files: string[];
  exports: ExportEntry[];
  /**
   * Entry modules resolved from `package.json` (`exports`, or `main`/`types`),
   * relative to the root. When set, `exports` only lists what these modules
   * export. Absent when every module counts as public (the fallback).
   */
  entryPoints?: string[];
}

export type ChangeCode =
  | 'export-removed'
  | 'kind-changed'
  | 'signature-changed'
  | 'type-changed'
  | 'type-parameters-changed'
  | 'heritage-changed'
  | 'modifier-changed'
  | 'member-removed'
  | 'member-changed'
  | 'member-added'
  | 'enum-member-removed'
  | 'enum-member-changed';

export interface BreakingChange {
  code: ChangeCode;
  /** Module path relative to the snapshot root. */
  file: string;
  /** Exported name, e.g. `Client` or `Utils.format`. */
  export: string;
  /** Declaration kind of the export in the old version. */
  exportKind: ShapeKind;
  /** Member name for class, interface and enum member changes. */
  member?: string;
  message: string;
  before?: string;
  after?: string;
  /** Other modules that re-export this declaration and are affected by the same change. */
  reexportedBy?: string[];
}

export interface CompareResult {
  from: string;
  to: string;
  summary: {
    breaking: number;
    filesBefore: number;
    filesAfter: number;
    exportsBefore: number;
    exportsAfter: number;
    /** Changes suppressed by a baseline file. Only present when a baseline was used. */
    accepted?: number;
  };
  changes: BreakingChange[];
}
