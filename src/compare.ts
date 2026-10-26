import { checkTypeQueries, typeQueryKey, type TypeQuery, type Variance } from './compat.js';
import type {
  ApiSurface,
  BreakingChange,
  ChangeCode,
  ClassShape,
  CompareResult,
  DeclarationRef,
  EnumShape,
  ExportEntry,
  FunctionShape,
  InterfaceShape,
  Member,
  Shape,
  ShapeKind,
  Signature,
  TypeParam,
} from './model.js';

/**
 * Decides whether a type whose text changed is still compatible. Answers
 * `false` (report the change) when it cannot tell.
 */
type TypesCompatible = (query: TypeQuery) => boolean;

/** How the parameter and return types of a group of signatures may change. */
interface SignatureRules {
  params: Variance;
  /** Undefined: return types are not compared. */
  returns?: Variance;
  /** Parameter names are irrelevant to callers (component props are passed as JSX attributes). */
  ignoreParamNames?: boolean;
}

/** Exported functions, class methods and constructors: callers pass arguments and read results. */
const CALLABLE: SignatureRules = { params: 'contravariant', returns: 'covariant' };
/**
 * Interface methods: consumers also implement them, so a narrower return type
 * would break implementations. Wider parameters are fine, because TypeScript
 * checks method parameters bivariantly.
 */
const INTERFACE_METHOD: SignatureRules = { params: 'contravariant', returns: 'invariant' };
/** Interface call and construct signatures: implemented by consumers, and checked strictly. */
const INTERFACE_SIGNATURE: SignatureRules = { params: 'invariant', returns: 'invariant' };
/**
 * Components typed as `FC<Props>` or wrapped in `memo`/`forwardRef`: consumers
 * render them with JSX, so only the props (and the forwarded ref) matter. What
 * the component renders is not part of its API.
 */
const COMPONENT: SignatureRules = { params: 'contravariant', ignoreParamNames: true };

export interface CompareOptions {
  /**
   * How changed types in signatures and properties are compared:
   * `assignability` (the default) uses the type checker and allows changes
   * that cannot break consumers, such as a wider parameter type; `text`
   * reports every change to the printed type, as in version 0.1.
   */
  typeComparison?: 'assignability' | 'text';
}

type Emit = (
  code: ChangeCode,
  message: string,
  extra?: { member?: string; before?: string; after?: string },
) => void;

/**
 * Compares two API surfaces and returns every breaking change found when
 * moving from `before` to `after`. `labels` are the snapshot paths shown in
 * the report (typically the paths given on the command line).
 */
export function compareSurfaces(
  before: ApiSurface,
  after: ApiSurface,
  labels: { from: string; to: string } = { from: before.root, to: after.root },
  options: CompareOptions = {},
): CompareResult {
  if (options.typeComparison === 'text') return compareWith(before, after, labels, () => false);

  // First pass: collect every changed type that the checker could clear, with
  // the text answer ("changed"). Only build a program if there are any.
  const queries = new Map<string, TypeQuery>();
  const textResult = compareWith(before, after, labels, (query) => {
    queries.set(typeQueryKey(query), query);
    return false;
  });
  if (queries.size === 0) return textResult;
  const answers = checkTypeQueries(after.root, [...queries.values()]);
  return compareWith(before, after, labels, (query) => answers.get(typeQueryKey(query)) ?? false);
}

function compareWith(
  before: ApiSurface,
  after: ApiSurface,
  labels: { from: string; to: string },
  types: TypesCompatible,
): CompareResult {
  const changes: BreakingChange[] = [];
  const beforeByKey = new Map(before.exports.map((e) => [entryKey(e), e]));
  const afterByKey = new Map(after.exports.map((e) => [entryKey(e), e]));
  const removed = new Set<string>();
  /** Declaration key -> modules whose shape changes were folded into that declaration's report. */
  const reexporters = new Map<string, string[]>();

  for (const old of before.exports) {
    if (hasRemovedParent(old, removed)) continue;
    const current = afterByKey.get(entryKey(old));
    const kind = old.shapes[0].kind;
    const emit: Emit = (code, message, extra = {}) => {
      changes.push({
        code,
        file: old.file,
        export: old.name,
        exportKind: kind,
        member: extra.member,
        message,
        before: extra.before,
        after: extra.after,
      });
    };

    if (!current) {
      removed.add(entryKey(old));
      emit('export-removed', `${describeKinds(old.shapes)} ${old.name} was removed`);
      continue;
    }

    // A re-export of a declaration that is compared at its own module (in both
    // versions) is reported once, at the declaration, listing this module.
    const origin = old.origin && originKey(old.origin);
    if (
      origin &&
      current.origin &&
      origin === originKey(current.origin) &&
      beforeByKey.has(origin) &&
      afterByKey.has(origin)
    ) {
      const list = reexporters.get(origin) ?? [];
      list.push(old.name === old.origin!.name ? old.file : `${old.file} (as ${old.name})`);
      reexporters.set(origin, list);
      continue;
    }
    compareEntry(old, current, emit, types);
  }

  for (const change of changes) {
    const via = reexporters.get(`${change.file}#${change.export}`);
    if (via && change.code !== 'export-removed') change.reexportedBy = [...via];
  }

  return {
    from: labels.from,
    to: labels.to,
    summary: {
      breaking: changes.length,
      filesBefore: before.files.length,
      filesAfter: after.files.length,
      exportsBefore: before.exports.length,
      exportsAfter: after.exports.length,
    },
    changes,
  };
}

function entryKey(entry: ExportEntry): string {
  return `${entry.file}#${entry.name}`;
}

function originKey(origin: { file: string; name: string }): string {
  return `${origin.file}#${origin.name}`;
}

/** A removed namespace is reported once, not once per nested export. */
function hasRemovedParent(entry: ExportEntry, removed: Set<string>): boolean {
  const parts = entry.name.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (removed.has(`${entry.file}#${parts.slice(0, i).join('.')}`)) return true;
  }
  return false;
}

function describeKinds(shapes: Shape[]): string {
  return shapes.map((s) => kindLabel(s.kind)).join(' + ');
}

function kindLabel(kind: ShapeKind): string {
  return kind === 'type' ? 'type alias' : kind === 'reexport' ? 're-export' : kind;
}

function compareEntry(old: ExportEntry, current: ExportEntry, emit: Emit, types: TypesCompatible): void {
  for (const oldShape of old.shapes) {
    const newShape = current.shapes.find((s) => s.kind === oldShape.kind);
    if (!newShape) {
      emit(
        'kind-changed',
        `${kindLabel(oldShape.kind)} ${old.name} is now a ${describeKinds(current.shapes)}`,
        { before: kindLabel(oldShape.kind), after: describeKinds(current.shapes) },
      );
      continue;
    }
    switch (oldShape.kind) {
      case 'function': {
        const next = newShape as typeof oldShape;
        const isComponent = oldShape.component !== undefined || next.component !== undefined;
        const reasons = signatureSetReasons(
          oldShape.signatures,
          next.signatures,
          types,
          isComponent ? COMPONENT : CALLABLE,
        );
        if (reasons.length > 0) {
          emit('signature-changed', reasons.join('; '), {
            before: formatFunction(oldShape),
            after: formatFunction(next),
          });
        }
        break;
      }
      case 'class':
        compareClass(oldShape, newShape as ClassShape, emit, types);
        break;
      case 'interface':
        compareInterface(oldShape, newShape as InterfaceShape, emit, types);
        break;
      case 'type': {
        const next = newShape as typeof oldShape;
        compareTypeParamsAndEmit(oldShape.typeParams, next.typeParams, emit);
        // Consumers both read and supply values of an alias type, and use it
        // in their own type-level code, so a changed target must be an
        // identical type (see `Variance`).
        if (!compatible(types, oldShape.type, next.type, next.declaration, 'type', 'identical')) {
          emit('type-changed', 'type alias declaration changed', {
            before: oldShape.type,
            after: next.type,
          });
        }
        break;
      }
      case 'enum':
        compareEnum(oldShape, newShape as EnumShape, emit);
        break;
      case 'variable': {
        const next = newShape as typeof oldShape;
        if (oldShape.type !== next.type) {
          emit('type-changed', 'type of exported variable changed', {
            before: oldShape.type,
            after: next.type,
          });
        }
        break;
      }
      case 'reexport': {
        const next = newShape as typeof oldShape;
        if (oldShape.target !== next.target) {
          emit('type-changed', 're-export target changed', {
            before: oldShape.target,
            after: next.target,
          });
        }
        break;
      }
      case 'namespace':
        // Namespace members are compared as their own dotted exports.
        break;
    }
  }
}

function compareClass(old: ClassShape, current: ClassShape, emit: Emit, types: TypesCompatible): void {
  if (!old.isAbstract && current.isAbstract) {
    emit('modifier-changed', 'class became abstract and can no longer be instantiated', {
      before: 'class',
      after: 'abstract class',
    });
  }
  compareTypeParamsAndEmit(old.typeParams, current.typeParams, emit);
  if (old.extends !== undefined && old.extends !== current.extends) {
    emit(
      'heritage-changed',
      current.extends === undefined
        ? `no longer extends ${old.extends}`
        : `base class changed from ${old.extends} to ${current.extends}`,
      { before: old.extends, after: current.extends },
    );
  }

  const rank = { public: 0, protected: 1, private: 2 };
  if (rank[current.constructorVisibility] > rank[old.constructorVisibility]) {
    emit(
      'modifier-changed',
      `constructor visibility reduced from ${old.constructorVisibility} to ${current.constructorVisibility}`,
      { member: 'constructor', before: old.constructorVisibility, after: current.constructorVisibility },
    );
  } else if (old.constructorVisibility !== 'private') {
    const reasons = signatureSetReasons(
      old.constructors.map(withoutReturnType),
      current.constructors.map(withoutReturnType),
      types,
      CALLABLE,
    );
    if (reasons.length > 0) {
      emit('signature-changed', reasons.join('; '), {
        member: 'constructor',
        before: old.constructors.map(formatConstructor).join(' | '),
        after: current.constructors.map(formatConstructor).join(' | '),
      });
    }
  }

  compareMembers(old.members, current.members, 'class', emit, types);
}

function compareInterface(old: InterfaceShape, current: InterfaceShape, emit: Emit, types: TypesCompatible): void {
  compareTypeParamsAndEmit(old.typeParams, current.typeParams, emit);
  for (const base of old.extends) {
    if (!current.extends.includes(base)) {
      emit('heritage-changed', `no longer extends ${base}`, {
        before: old.extends.join(', '),
        after: current.extends.join(', ') || '(none)',
      });
    }
  }
  compareMembers(old.members, current.members, 'interface', emit, types);
}

function compareEnum(old: EnumShape, current: EnumShape, emit: Emit): void {
  if (!old.isConst && current.isConst) {
    emit('modifier-changed', 'enum became a const enum and no longer exists at runtime', {
      before: 'enum',
      after: 'const enum',
    });
  }
  const values = new Map(current.members.map((m) => [m.name, m]));
  for (const member of old.members) {
    const next = values.get(member.name);
    if (!next) {
      emit('enum-member-removed', `enum member ${member.name} was removed`, {
        member: member.name,
        before: member.value,
      });
    } else if (member.value !== undefined && next.value !== undefined && member.value !== next.value) {
      emit('enum-member-changed', `value of enum member ${member.name} changed`, {
        member: member.name,
        before: member.value,
        after: next.value,
      });
    }
  }
}

function compareMembers(
  oldMembers: Member[],
  newMembers: Member[],
  owner: 'class' | 'interface',
  emit: Emit,
  types: TypesCompatible,
): void {
  const byKey = new Map(newMembers.map((m) => [m.key, m]));
  const oldKeys = new Set(oldMembers.map((m) => m.key));

  for (const member of oldMembers) {
    const next = byKey.get(member.key);
    if (!next) {
      emit('member-removed', `${memberLabel(member)} was removed`, {
        member: member.key,
        before: formatMember(member),
      });
      continue;
    }
    const reasons = memberReasons(member, next, owner, types);
    if (reasons.length > 0) {
      emit('member-changed', reasons.join('; '), {
        member: member.key,
        before: formatMember(member),
        after: formatMember(next),
      });
    }
  }

  for (const member of newMembers) {
    if (oldKeys.has(member.key)) continue;
    if (owner === 'interface') {
      const required =
        member.kind === 'call' ||
        member.kind === 'construct' ||
        member.kind === 'index' ||
        !member.optional;
      if (required) {
        emit(
          'member-added',
          `required ${memberLabel(member)} was added; existing implementations and object literals of this interface no longer type-check`,
          { member: member.key, after: formatMember(member) },
        );
      }
    } else if (member.isAbstract) {
      emit(
        'member-added',
        `abstract ${memberLabel(member)} was added; existing subclasses must now implement it`,
        { member: member.key, after: formatMember(member) },
      );
    }
  }
}

function memberReasons(
  old: Member,
  current: Member,
  owner: 'class' | 'interface',
  types: TypesCompatible,
): string[] {
  if (old.kind !== current.kind) return [`changed from ${old.kind} to ${current.kind}`];
  const reasons: string[] = [];
  if (old.visibility === 'public' && current.visibility === 'protected') {
    reasons.push('visibility reduced from public to protected');
  }
  if (!old.optional && current.optional) reasons.push('became optional');
  if (owner === 'interface' && old.optional && !current.optional) reasons.push('became required');
  if (!old.readonly && current.readonly) reasons.push('became readonly');
  if (owner === 'class' && !old.isAbstract && current.isAbstract) reasons.push('became abstract');
  // Consumers of a class only read a readonly property, so it may narrow.
  // Writable properties and interface properties (which consumers also
  // supply, in object literals and implementations) must keep an equivalent type.
  const propertyVariance: Variance = owner === 'class' && old.readonly ? 'covariant' : 'invariant';
  if (
    old.type !== undefined &&
    current.type !== undefined &&
    !compatible(types, old.type, current.type, current.declaration, 'type', propertyVariance)
  ) {
    reasons.push(`type changed from ${old.type} to ${current.type}`);
  }
  if (old.signatures && current.signatures) {
    const rules =
      owner === 'class' ? CALLABLE : current.kind === 'method' ? INTERFACE_METHOD : INTERFACE_SIGNATURE;
    reasons.push(...signatureSetReasons(old.signatures, current.signatures, types, rules));
  }
  return reasons;
}

/**
 * Every old signature (overload) must still be satisfied by at least one new
 * signature. Returns the reasons for the first overload that is not.
 */
function signatureSetReasons(
  oldSigs: Signature[],
  newSigs: Signature[],
  types: TypesCompatible,
  rules: SignatureRules,
): string[] {
  const reasons: string[] = [];
  for (const old of oldSigs) {
    if (newSigs.length === 0) {
      reasons.push(`signature ${formatSignature(old)} was removed`);
      continue;
    }
    let best: string[] | undefined;
    for (const candidate of newSigs) {
      const r = signatureReasons(old, candidate, types, rules);
      if (best === undefined || r.length < best.length) best = r;
      if (r.length === 0) break;
    }
    if (best && best.length > 0) {
      if (oldSigs.length > 1 || newSigs.length > 1) {
        reasons.push(`overload ${formatSignature(old)} is no longer supported (${best.join(', ')})`);
      } else {
        reasons.push(...best);
      }
    }
  }
  return reasons;
}

function signatureReasons(
  old: Signature,
  current: Signature,
  types: TypesCompatible,
  rules: SignatureRules,
): string[] {
  const reasons = typeParamReasons(old.typeParams, current.typeParams);

  old.params.forEach((param, i) => {
    const next = current.params[i];
    if (!next) {
      reasons.push(`${param.rest ? 'rest parameter' : 'parameter'} ${param.name} was removed`);
      return;
    }
    if (!rules.ignoreParamNames && param.name !== next.name) reasons.push(`parameter ${param.name} was renamed to ${next.name}`);
    if (!compatible(types, param.type, next.type, current.declaration, i, rules.params)) {
      reasons.push(`type of parameter ${next.name} changed from ${param.type} to ${next.type}`);
    } else if (
      param.type === next.type &&
      param.structure !== undefined &&
      next.structure !== undefined &&
      !compatible(types, param.structure, next.structure, current.declaration, i, rules.params)
    ) {
      // Same name, but it refers to a non-exported type whose members changed.
      reasons.push(
        `type of parameter ${next.name} (${next.type}) changed from ${param.structure} to ${next.structure}`,
      );
    }
    if (param.optional && !next.optional && !next.rest) {
      reasons.push(`parameter ${next.name} became required`);
    }
    if (param.rest !== next.rest) {
      reasons.push(
        next.rest
          ? `parameter ${next.name} became a rest parameter`
          : `parameter ${next.name} is no longer a rest parameter`,
      );
    }
  });
  for (const added of current.params.slice(old.params.length)) {
    if (!added.optional && !added.rest) reasons.push(`required parameter ${added.name} was added`);
  }

  if (
    rules.returns !== undefined &&
    !compatible(types, old.returnType, current.returnType, current.declaration, 'return', rules.returns)
  ) {
    reasons.push(`return type changed from ${old.returnType} to ${current.returnType}`);
  }
  return reasons;
}

/** Equal texts are compatible; otherwise ask the checker, if the new declaration is known. */
function compatible(
  types: TypesCompatible,
  before: string,
  after: string,
  declaration: DeclarationRef | undefined,
  position: TypeQuery['position'],
  variance: Variance,
): boolean {
  if (before === after) return true;
  if (!declaration) return false;
  return types({ before, after, declaration, position, variance });
}

function typeParamReasons(old: TypeParam[], current: TypeParam[]): string[] {
  const reasons: string[] = [];
  old.forEach((param, i) => {
    const next = current[i];
    if (!next) {
      reasons.push(`type parameter ${param.name} was removed`);
      return;
    }
    if (param.constraint !== next.constraint) {
      reasons.push(
        `constraint of type parameter ${next.name} changed from ${param.constraint ?? '(none)'} to ${next.constraint ?? '(none)'}`,
      );
    }
    if (param.default !== undefined && param.default !== next.default) {
      reasons.push(
        `default of type parameter ${next.name} changed from ${param.default} to ${next.default ?? '(none)'}`,
      );
    }
  });
  for (const added of current.slice(old.length)) {
    if (added.default === undefined) reasons.push(`required type parameter ${added.name} was added`);
  }
  return reasons;
}

function compareTypeParamsAndEmit(old: TypeParam[], current: TypeParam[], emit: Emit): void {
  const reasons = typeParamReasons(old, current);
  if (reasons.length > 0) {
    emit('type-parameters-changed', reasons.join('; '), {
      before: formatTypeParams(old) || '(none)',
      after: formatTypeParams(current) || '(none)',
    });
  }
}

function withoutReturnType(signature: Signature): Signature {
  return { ...signature, returnType: '' };
}

function memberLabel(member: Member): string {
  switch (member.kind) {
    case 'call':
      return 'call signature';
    case 'construct':
      return 'construct signature';
    case 'index':
      return `index signature ${member.key}`;
    default:
      return `${member.kind} ${member.key}`;
  }
}

export function formatTypeParams(params: TypeParam[]): string {
  if (params.length === 0) return '';
  const parts = params.map(
    (p) =>
      p.name +
      (p.constraint !== undefined ? ` extends ${p.constraint}` : '') +
      (p.default !== undefined ? ` = ${p.default}` : ''),
  );
  return `<${parts.join(', ')}>`;
}

function formatParams(signature: Signature): string {
  const params = signature.params.map(
    (p) => `${p.rest ? '...' : ''}${p.name}${p.optional && !p.rest ? '?' : ''}: ${p.type}`,
  );
  return `(${params.join(', ')})`;
}

export function formatSignature(signature: Signature): string {
  return `${formatTypeParams(signature.typeParams)}${formatParams(signature)}: ${signature.returnType}`;
}

/** `(a: string): void`, or `memo (props: Props)` for a wrapped or `FC`-typed component. */
function formatFunction(shape: FunctionShape): string {
  if (shape.component === undefined) return shape.signatures.map(formatSignature).join(' | ');
  return shape.signatures.map((s) => `${shape.component} ${formatParams(s)}`).join(' | ');
}

function formatConstructor(signature: Signature): string {
  return `new ${formatParams(signature)}`;
}

function formatMember(member: Member): string {
  const modifiers = [
    member.visibility === 'protected' ? 'protected' : '',
    member.isStatic ? 'static' : '',
    member.isAbstract ? 'abstract' : '',
    member.readonly ? 'readonly' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const prefix = modifiers ? `${modifiers} ` : '';
  const optional = member.optional ? '?' : '';
  switch (member.kind) {
    case 'property':
      return `${prefix}${member.name}${optional}: ${member.type}`;
    case 'index':
      return `${prefix}${member.name}: ${member.type}`;
    case 'call':
      return (member.signatures ?? []).map(formatSignature).join(' | ');
    case 'construct':
      return (member.signatures ?? []).map((s) => `new ${formatSignature(s)}`).join(' | ');
    case 'method':
      return (member.signatures ?? [])
        .map((s) => `${prefix}${member.name}${optional}${formatSignature(s)}`)
        .join(' | ');
  }
}
