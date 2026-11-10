import { byCodeUnits, SECTIONS, type McpSnapshot, type SectionName, type SnapshotTool } from './snapshot.js';

/**
 * Two snapshots compared, every change classified by fixed rules (the first that matches), so the same change always gets
 * the same class and a test can say why. A change no rule knows is not dropped and not called safe: it is
 * `informational` with `unclassified: true`, and the summary counts those apart.
 *
 * A description or a title is its own record. A description changes what a model is told to do with the tool, so a
 * change to it carries `signal: 'security'`: after a description was approved, a new one is how a tool is swapped under
 * a client, and it must not hide among the small edits. The signal is orthogonal to the class and gates nothing by
 * itself: it is a reason for a reviewer to look, not a verdict.
 */

export type ChangeKind = 'added' | 'removed' | 'modified';
export type ChangeClass = 'breaking' | 'non-breaking' | 'informational';
export type ChangeEntity = 'server' | 'transport' | 'instructions' | 'capability' | 'tool' | 'resource' | 'resourceTemplate' | 'prompt';
/**
 * `security`: a change to what a model reads or is allowed to do (a description, the instructions, a hint towards
 * writing or destroying, a new tool that does not say it is read-only). `identity`: the server calls itself by another
 * name.
 */
export type ChangeSignal = 'security' | 'identity';

export interface ContractChange {
  entity: ChangeEntity;
  /** The entity's key: a tool or prompt name, a resource URI, a URI template, a capability; empty for the rest. */
  name: string;
  /**
   * The entity itself (`tool`, `resource`, `resourceTemplate`, `prompt`, `capability`, `duplicate`) when it came or
   * went, else what changed in it: `description`, `mimeType`, `annotations.<hint>`, `arguments.<name>`, `listChanged`,
   * a schema path (`inputSchema.cases[].id`).
   */
  field: string;
  kind: ChangeKind;
  classification: ChangeClass;
  /** One sentence. */
  reason: string;
  before: unknown;
  after: unknown;
  signal?: ChangeSignal;
  /** No rule knew this change. */
  unclassified?: true;
}

export interface ContractDiffSummary {
  breaking: number;
  'non-breaking': number;
  informational: number;
  /** Of the informational ones, how many no rule knew. */
  unclassified: number;
  /** How many carry `signal: 'security'`. */
  security: number;
  /** The worst class among the changes; `none` without changes. */
  overall: ChangeClass | 'none';
}

export interface ContractDiff {
  changes: ContractChange[];
  summary: ContractDiffSummary;
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON equality; key order does not count, array order does. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

const show = (v: unknown): string => (v === undefined ? 'nothing' : JSON.stringify(v));
const kindOf = (before: unknown, after: unknown): ChangeKind => (before === undefined ? 'added' : after === undefined ? 'removed' : 'modified');
const stringSet = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Enum values compared by their JSON text, so `1` and `"1"` stay apart. */
const valueSet = (v: unknown[]): Map<string, unknown> => new Map(v.map((x) => [JSON.stringify(x), x]));
/** A list of types is a set: `["string","null"]` is `["null","string"]`. */
const sameType = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? same([...valueSet(a).keys()].sort(), [...valueSet(b).keys()].sort()) : same(a, b);

class Collector {
  readonly changes: ContractChange[] = [];
  constructor(
    readonly entity: ChangeEntity,
    readonly name: string,
  ) {}

  add(field: string, classification: ChangeClass, reason: string, before: unknown, after: unknown, extra: Partial<ContractChange> = {}): void {
    this.changes.push({ entity: this.entity, name: this.name, field, kind: kindOf(before, after), classification, reason, before, after, ...extra });
  }

  unknown(field: string, what: string, before: unknown, after: unknown): void {
    this.add(field, 'informational', `Could not classify: ${what} changed from ${show(before)} to ${show(after)}.`, before, after, {
      unclassified: true,
    });
  }
}

type Side = 'input' | 'output';
const SCHEMA_RULED = new Set(['type', 'enum', 'properties', 'required', 'items', 'description']);

/** A schema node compared by the rules of its side; `path` is the parameter or field path, empty at the root. */
function compareSchema(c: Collector, side: Side, path: string, before: unknown, after: unknown): void {
  if (same(before, after)) return;
  const field = `${side}Schema${path === '' ? '' : `.${path}`}`;
  if (path === '' && (before === undefined || after === undefined)) {
    if (side === 'output') {
      if (after === undefined) c.add(field, 'breaking', 'The output schema was removed; a client reading the result loses its shape.', before, after);
      else c.add(field, 'non-breaking', 'An output schema was added.', before, after);
    } else c.unknown(field, 'the input schema', before, after);
    return;
  }
  if (!isRecord(before) || !isRecord(after)) return c.unknown(field, 'the schema', before, after);

  if (!sameType(before['type'], after['type'])) {
    // The rest of the node follows the type, so it is not reported on its own.
    return c.add(`${field}`, 'breaking', `The type changed from ${show(before['type'])} to ${show(after['type'])}.`, before['type'], after['type']);
  }
  if (!same(before['enum'], after['enum'])) compareEnum(c, side, field, before['enum'], after['enum']);
  compareProperties(c, side, path, field, before, after);
  if (!same(before['items'], after['items'])) compareSchema(c, side, `${path}[]`, before['items'], after['items']);
  if (!same(before['description'], after['description'])) {
    const what = path === '' ? `whole ${side} schema` : side === 'input' ? 'parameter' : 'field';
    c.add(field, 'informational', `The ${what} description changed: it is what a model reads.`, before['description'], after['description'], {
      signal: 'security',
    });
  }
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (SCHEMA_RULED.has(k) || same(before[k], after[k])) continue;
    if (side === 'input' && compareInputConstraint(c, field, k, before[k], after[k])) continue;
    // A deliberate limit: composition (anyOf, oneOf, allOf), references ($ref, $defs), nullable and the rest are not
    // reasoned about. They show as not classified, counted apart and called out above the Markdown table.
    c.unknown(field, `\`${k}\``, before[k], after[k]);
  }
}

const UPPER_BOUNDS = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems']);
const LOWER_BOUNDS = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems']);

/** What an argument may be: a tighter rule refuses a call that passed before. Returns whether a rule knew `k`. */
function compareInputConstraint(c: Collector, field: string, k: string, before: unknown, after: unknown): boolean {
  if (UPPER_BOUNDS.has(k) || LOWER_BOUNDS.has(k)) {
    if ((before !== undefined && typeof before !== 'number') || (after !== undefined && typeof after !== 'number')) return false;
    if (before === undefined) c.add(field, 'breaking', `\`${k}\` ${show(after)} now limits the value: a call outside it is refused.`, before, after);
    else if (after === undefined) c.add(field, 'non-breaking', `The \`${k}\` limit of ${show(before)} was lifted.`, before, after);
    else if (UPPER_BOUNDS.has(k) ? after < before : after > before) {
      c.add(field, 'breaking', `\`${k}\` tightened from ${show(before)} to ${show(after)}: a call outside it is refused.`, before, after);
    } else c.add(field, 'non-breaking', `\`${k}\` loosened from ${show(before)} to ${show(after)}.`, before, after);
    return true;
  }
  if (k === 'pattern' || k === 'const') {
    if (after === undefined) c.add(field, 'non-breaking', `The \`${k}\` rule was lifted.`, before, after);
    else c.add(field, 'breaking', `The value must now match \`${k}\` ${show(after)}: a call that passed before may be refused.`, before, after);
    return true;
  }
  if (k === 'additionalProperties') {
    const closedOrOpen = (v: unknown) => v === undefined || typeof v === 'boolean';
    if (!closedOrOpen(before) || !closedOrOpen(after)) return false;
    if (after === false) c.add(field, 'breaking', 'Unknown arguments are refused now: a call that passed an extra one fails.', before, after);
    else if (before === false) c.add(field, 'non-breaking', 'Unknown arguments are allowed now.', before, after);
    else c.add(field, 'informational', `additionalProperties changed from ${show(before)} to ${show(after)}, which allows the same arguments.`, before, after);
    return true;
  }
  if (k === 'default') {
    c.add(field, 'informational', 'The default changed: callers that omit the parameter get a different value.', before, after);
    return true;
  }
  return false;
}

/**
 * No enum allows any value. The input loses when a value is no longer allowed (a call that passed it fails); the output
 * loses when it may hold a value it did not before (a client that switches over the values does not know it).
 */
function compareEnum(c: Collector, side: Side, field: string, before: unknown, after: unknown): void {
  if ((before !== undefined && !Array.isArray(before)) || (after !== undefined && !Array.isArray(after))) {
    return c.unknown(field, 'the enum', before, after);
  }
  const b = before === undefined ? undefined : valueSet(before);
  const a = after === undefined ? undefined : valueSet(after);
  const removed = b === undefined ? [] : [...b.keys()].filter((k) => a !== undefined && !a.has(k));
  const added = a === undefined ? [] : [...a.keys()].filter((k) => b !== undefined && !b.has(k));
  const narrowed = removed.length > 0 || (b === undefined && a !== undefined);
  const widened = added.length > 0 || (b !== undefined && a === undefined);
  if (!narrowed && !widened) return; // reordered only
  const lost = b === undefined ? 'the values became a fixed list' :`${removed.join(', ')} no longer allowed`;
  const gained = a === undefined ? 'the list of values was lifted' : `${added.join(', ')} now possible`;
  if (side === 'input') {
    if (narrowed) return c.add(field, 'breaking', `The enum was narrowed: ${lost}; a call that passes it now fails.`, before, after);
    return c.add(field, 'non-breaking', `The enum was widened: ${gained}.`, before, after);
  }
  if (widened) return c.add(field, 'breaking', `The result enum was widened: ${gained}; a client does not know the new value.`, before, after);
  c.add(field, 'non-breaking', `The result enum was narrowed: ${lost}.`, before, after);
}

function compareProperties(c: Collector, side: Side, path: string, field: string, before: Rec, after: Rec): void {
  const bp = isRecord(before['properties']) ? before['properties'] : {};
  const ap = isRecord(after['properties']) ? after['properties'] : {};
  const br = stringSet(before['required']);
  const ar = stringSet(after['required']);
  if (!isRecord(before['properties']) && before['properties'] !== undefined) c.unknown(field, '`properties`', before['properties'], after['properties']);
  else if (!isRecord(after['properties']) && after['properties'] !== undefined) c.unknown(field, '`properties`', before['properties'], after['properties']);
  // `required: true` on a property (the draft-3 form) or a lone string is not a list of names: no rule below reads it.
  const names = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if ((!names(before['required']) || !names(after['required'])) && !same(before['required'], after['required'])) {
    c.unknown(field, '`required`', before['required'], after['required']);
  }
  const what = side === 'input' ? 'parameter' : 'field';

  for (const name of [...new Set([...Object.keys(bp), ...Object.keys(ap)])].sort()) {
    const sub = path === '' ? name : `${path}.${name}`;
    const f = `${side}Schema.${sub}`;
    const inBefore = Object.hasOwn(bp, name);
    const inAfter = Object.hasOwn(ap, name);
    if (!inBefore) {
      if (side === 'output') c.add(f, 'non-breaking', 'A field was added to the result.', undefined, ap[name]);
      else if (ar.has(name)) c.add(f, 'breaking', 'A new required parameter: every existing call now fails without it.', undefined, ap[name]);
      else c.add(f, 'non-breaking', 'A new optional parameter.', undefined, ap[name]);
      continue;
    }
    if (!inAfter) {
      if (side === 'output') c.add(f, 'breaking', 'A field was removed from the result.', bp[name], undefined);
      else c.add(f, 'breaking', 'A parameter was removed: a call that passes it is refused or ignores it.', bp[name], undefined);
      continue;
    }
    const wasRequired = br.has(name);
    const isRequired = ar.has(name);
    if (wasRequired !== isRequired) {
      if (side === 'input' && isRequired) c.add(f, 'breaking', `The ${what} became required.`, false, true);
      else if (side === 'input') c.add(f, 'non-breaking', `The ${what} is no longer required.`, true, false);
      else if (!isRequired) c.add(f, 'breaking', 'The field became optional: a client may now find it missing.', true, false);
      else c.add(f, 'non-breaking', 'The field is now always returned.', false, true);
    }
    compareSchema(c, side, sub, bp[name], ap[name]);
  }
  // A required name with no property under it on either side: no rule above saw it.
  const orphans = [...new Set([...br, ...ar])].filter((n) => br.has(n) !== ar.has(n) && !Object.hasOwn(bp, n) && !Object.hasOwn(ap, n));
  for (const n of orphans.sort()) c.unknown(field, `\`required\` of "${n}", which has no property`, br.has(n), ar.has(n));
}

// The specification's defaults for a hint that is not set.
const HINT_DEFAULTS: Record<string, boolean> = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function compareAnnotations(c: Collector, before: unknown, after: unknown): void {
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  if (before !== undefined && !isRecord(before)) return c.unknown('annotations', 'the annotations', before, after);
  if (after !== undefined && !isRecord(after)) return c.unknown('annotations', 'the annotations', before, after);
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (same(b[k], a[k])) continue;
    const field = `annotations.${k}`;
    const modified: Partial<ContractChange> = { kind: 'modified' };
    if (!Object.hasOwn(HINT_DEFAULTS, k)) {
      if (k === 'title') c.add(field, 'informational', 'The display title in the annotations changed.', b[k], a[k], modified);
      else c.unknown(field, `\`${k}\``, b[k], a[k]);
      continue;
    }
    const was = typeof b[k] === 'boolean' ? b[k] : HINT_DEFAULTS[k];
    const is = typeof a[k] === 'boolean' ? a[k] : HINT_DEFAULTS[k];
    // Towards writing or destroying is a reason to look, whatever the class: also a hint now set to the default `true`.
    const riskier = (k === 'readOnlyHint' && was === true && is !== true) || (k === 'destructiveHint' && is === true && (was === false || a[k] === true));
    if (riskier) Object.assign(modified, { signal: 'security' as const });
    if (k === 'readOnlyHint' && was === true && is === false) {
      c.add(field, 'breaking', 'The tool is no longer read-only: a client that ran it unattended now runs a writer.', b[k], a[k], modified);
    } else if (k === 'destructiveHint' && was === false && is === true) {
      c.add(field, 'breaking', 'The tool may now destroy data: a client that ran it without asking now must ask.', b[k], a[k], modified);
    } else if (k === 'openWorldHint' && was === false && is === true) {
      c.add(field, 'informational', 'The tool now reaches outside its own data (openWorldHint).', b[k], a[k], modified);
    } else if (k === 'idempotentHint' && was === true && is === false) {
      c.add(field, 'informational', 'The tool is no longer idempotent: a repeated call may act twice.', b[k], a[k], modified);
    } else c.add(field, 'informational', `The hint ${k} changed and the tool is not less safe for it.`, b[k], a[k], modified);
  }
}

function comparePluneFields(c: Collector, before: unknown, after: unknown): void {
  const b = isRecord(before) ? before : {};
  const a = isRecord(after) ? after : {};
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (same(b[k], a[k])) continue;
    const field = `x-plune.${k}`;
    if (k === 'write' && b[k] === false && a[k] === true) {
      c.add(field, 'breaking', 'The tool now writes: a read token loses it.', b[k], a[k]);
    } else if (k === 'visibility' && b[k] === 'core' && a[k] === 'discoverable') {
      c.add(field, 'breaking', 'The tool is no longer listed from the start: a client stops seeing it until it asks.', b[k], a[k]);
    } else if (k === 'write' || k === 'visibility') {
      c.add(field, 'informational', `${k} changed from ${show(b[k])} to ${show(a[k])}; no client loses the tool.`, b[k], a[k]);
    } else c.unknown(field, `\`${k}\``, b[k], a[k]);
  }
}

const keysOf = (b: Rec, a: Rec): string[] => [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();

function compareTool(c: Collector, before: SnapshotTool, after: SnapshotTool): void {
  if (!same(before.title, after.title)) c.add('title', 'informational', 'The title changed.', before.title, after.title);
  if (!same(before.description, after.description)) {
    c.add('description', 'informational', 'The description changed: it is what a model is told about the tool.', before.description, after.description, {
      signal: 'security',
    });
  }
  compareSchema(c, 'input', '', before.inputSchema, after.inputSchema);
  compareSchema(c, 'output', '', before.outputSchema, after.outputSchema);
  compareAnnotations(c, before.annotations, after.annotations);
  comparePluneFields(c, before['x-plune'], after['x-plune']);
  compareExecution(c, before.execution, after.execution);
}

/** How a tool runs. A tool that now requires a task fails a client that calls it plainly; the rest is not reasoned about. */
function compareExecution(c: Collector, before: unknown, after: unknown): void {
  if (same(before, after)) return;
  if ((before !== undefined && !isRecord(before)) || (after !== undefined && !isRecord(after))) return c.unknown('execution', '`execution`', before, after);
  const b = before ?? {};
  const a = after ?? {};
  for (const k of keysOf(b, a)) {
    if (same(b[k], a[k])) continue;
    const field = `execution.${k}`;
    if (k === 'taskSupport' && a[k] === 'required') {
      c.add(field, 'breaking', 'The tool now requires to be run as a task: a client that calls it plainly fails.', b[k], a[k], { kind: 'modified' });
    } else c.unknown(field, `\`${k}\``, b[k], a[k]);
  }
}

/** A resource or a resource template: its MIME type is how a client reads the content; the rest is what a model reads. */
function compareResource(c: Collector, before: Rec, after: Rec): void {
  for (const k of keysOf(before, after)) {
    if (k === 'uri' || k === 'uriTemplate' || same(before[k], after[k])) continue;
    if (k === 'mimeType') {
      c.add(k, 'breaking', `The MIME type changed from ${show(before[k])} to ${show(after[k])}: a client that reads the content by its type misreads it.`, before[k], after[k]);
    } else if (k === 'description') {
      c.add(k, 'informational', 'The description changed: it is what a model is told about the content.', before[k], after[k], { signal: 'security' });
    } else if (k === 'name' || k === 'title') c.add(k, 'informational', `The ${k} changed.`, before[k], after[k]);
    else c.unknown(k, `\`${k}\``, before[k], after[k]);
  }
}

function comparePrompt(c: Collector, before: Rec, after: Rec): void {
  for (const k of keysOf(before, after)) {
    if (k === 'name' || k === 'arguments' || same(before[k], after[k])) continue;
    if (k === 'description') {
      c.add(k, 'informational', 'The description changed: it is what a model is told about the prompt.', before[k], after[k], { signal: 'security' });
    } else if (k === 'title') c.add(k, 'informational', 'The title changed.', before[k], after[k]);
    else c.unknown(k, `\`${k}\``, before[k], after[k]);
  }
  if (!same(before['arguments'], after['arguments'])) compareArguments(c, before['arguments'], after['arguments']);
}

/** Prompt arguments by name. A list that is not one of named objects, or a name given twice, is not reasoned about. */
function compareArguments(c: Collector, before: unknown, after: unknown): void {
  const byName = (v: unknown): Map<string, Rec> | undefined => {
    const list = v ?? [];
    if (!Array.isArray(list) || !list.every((x) => isRecord(x) && typeof x['name'] === 'string')) return undefined;
    const map = new Map((list as Rec[]).map((x) => [x['name'] as string, x]));
    return map.size === list.length ? map : undefined;
  };
  const b = byName(before);
  const a = byName(after);
  if (b === undefined || a === undefined) return c.unknown('arguments', 'the arguments (not a list of uniquely named arguments)', before, after);
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort(byCodeUnits)) {
    const field = `arguments.${name}`;
    const was = b.get(name);
    const is = a.get(name);
    if (was === undefined) {
      if (is?.['required'] !== undefined && typeof is['required'] !== 'boolean') c.unknown(field, 'a new argument whose `required` is not a boolean', undefined, is);
      else if (is?.['required'] === true) c.add(field, 'breaking', 'A new required argument: a request for the prompt without it now fails.', undefined, is);
      else c.add(field, 'non-breaking', 'A new optional argument.', undefined, is);
      continue;
    }
    if (is === undefined) {
      c.add(field, 'breaking', 'An argument was removed: a request that passes it is refused or ignores it.', was, undefined);
      continue;
    }
    const modified: Partial<ContractChange> = { kind: 'modified' };
    for (const k of keysOf(was, is)) {
      if (k === 'name' || same(was[k], is[k])) continue;
      if (k === 'required' && [was[k], is[k]].some((v) => v !== undefined && typeof v !== 'boolean')) c.unknown(field, '`required` that is not a boolean', was[k], is[k]);
      else if (k === 'required') {
        const w = was[k] === true;
        const i = is[k] === true;
        if (i && !w) c.add(field, 'breaking', 'The argument became required: a request without it now fails.', was[k], is[k], modified);
        else if (w && !i) c.add(field, 'non-breaking', 'The argument is no longer required.', was[k], is[k], modified);
        else c.add(field, 'informational', `required changed from ${show(was[k])} to ${show(is[k])}, which means the same.`, was[k], is[k], modified);
      } else if (k === 'description') {
        c.add(field, 'informational', 'The argument description changed: it is what a model reads.', was[k], is[k], { ...modified, signal: 'security' });
      } else if (k === 'title') c.add(field, 'informational', 'The argument title changed.', was[k], is[k], modified);
      else c.unknown(field, `\`${k}\``, was[k], is[k]);
    }
  }
}

const NOTIFY: Record<string, (capability: string) => string> = {
  listChanged: (cap) => `notifies when its ${cap} list changes`,
  subscribe: () => 'offers subscriptions to resource changes',
};
const isFlag = (v: unknown) => v === undefined || typeof v === 'boolean';

/** Each declared capability by name; inside one, the `listChanged` and `subscribe` flags. */
function compareCapabilities(out: ContractChange[], before: Rec | null, after: Rec | null): void {
  const b = before ?? {};
  const a = after ?? {};
  for (const k of keysOf(b, a)) {
    if (same(b[k], a[k])) continue;
    const c = new Collector('capability', k);
    const bc = b[k];
    const ac = a[k];
    if (!Object.hasOwn(a, k)) c.add('capability', 'breaking', `The server no longer declares ${k}: a client that uses it now fails.`, bc, undefined);
    else if (!Object.hasOwn(b, k)) c.add('capability', 'non-breaking', `The server now declares ${k}.`, undefined, ac);
    else if (!isRecord(bc) || !isRecord(ac)) c.unknown('capability', `the ${k} capability`, bc, ac);
    else {
      for (const f of keysOf(bc, ac)) {
        if (same(bc[f], ac[f])) continue;
        const says = Object.hasOwn(NOTIFY, f) ? NOTIFY[f] : undefined;
        if (says === undefined || !isFlag(bc[f]) || !isFlag(ac[f])) c.unknown(f, `\`${f}\` of ${k}`, bc[f], ac[f]);
        else if (bc[f] === true) c.add(f, 'breaking', `The server no longer ${says(k)}: a client that relies on it misses changes.`, bc[f], ac[f]);
        else if (ac[f] === true) c.add(f, 'non-breaking', `The server now ${says(k)}.`, bc[f], ac[f]);
        else c.add(f, 'informational', `${f} changed from ${show(bc[f])} to ${show(ac[f])}, which means the same.`, bc[f], ac[f]);
      }
    }
    for (const change of c.changes) out.push(change);
  }
}

/** The server's name, version and title; a new name carries the `identity` signal. */
function compareServer(c: Collector, before: Rec | null, after: Rec | null): void {
  const b = before ?? {};
  const a = after ?? {};
  for (const k of keysOf(b, a)) {
    if (same(b[k], a[k])) continue;
    if (k === 'name') {
      c.add(k, 'informational', 'The server calls itself by another name: a client that keys its settings by the name may take it for another server.', b[k], a[k], {
        signal: 'identity',
      });
    } else if (k === 'version' || k === 'title') c.add(k, 'informational', `The server ${k} changed.`, b[k], a[k]);
    else c.unknown(k, `\`${k}\``, b[k], a[k]);
  }
}

const ENTITIES: Record<SectionName, { entity: ChangeEntity; noun: string; added: string; removed: string }> = {
  tools: { entity: 'tool', noun: 'tool', added: 'A new tool.', removed: 'The tool was removed: a client that calls it now fails.' },
  resources: { entity: 'resource', noun: 'resource', added: 'A new resource.', removed: 'The resource was removed: a client that reads it now fails.' },
  resourceTemplates: {
    entity: 'resourceTemplate',
    noun: 'resource template',
    added: 'A new resource template.',
    removed: 'The resource template was removed: a client that reads through it now fails.',
  },
  prompts: { entity: 'prompt', noun: 'prompt', added: 'A new prompt.', removed: 'The prompt was removed: a client that requests it now fails.' },
};

function added(c: Collector, section: SectionName, entry: Rec): void {
  const { entity, added: reason } = ENTITIES[section];
  const annotations = entry['annotations'];
  if (section === 'tools' && !(isRecord(annotations) && annotations['readOnlyHint'] === true)) {
    c.add(entity, 'non-breaking', 'A new tool that does not say it is read-only (readOnlyHint): a client may run a writer unasked.', undefined, entry, {
      signal: 'security',
    });
  } else c.add(entity, 'non-breaking', reason, undefined, entry);
}

/** A key the list holds more than once: the entries under it are not compared one by one, and never one silently. */
function duplicates(c: Collector, section: SectionName, key: string, before: Rec[], after: Rec[]): void {
  if (same(before, after)) return;
  const { noun, removed } = ENTITIES[section];
  const was = before.length === 0 ? undefined : before;
  if (after.length > 1) {
    c.add('duplicate', 'breaking', `The ${noun} is listed ${after.length} times under one ${key}: a client that asks for it by its ${key} may get either entry.`, was, after);
  } else if (after.length === 0) c.add('duplicate', 'breaking', `${removed.replace(/\.$/, '')} (it was listed ${before.length} times).`, was, undefined);
  else {
    // The one left against each of the former entries; the comparison with the worst outcome stands for all.
    const worst = before
      .map((entry) => {
        const one = new Collector(c.entity, c.name);
        compareEntity(one, section, entry, after[0]!);
        return one.changes;
      })
      .reduce((w, changes) => (severity(changes) > severity(w) ? changes : w));
    c.add('duplicate', 'informational', `The ${noun} was listed ${before.length} times and is listed once now: it is compared with each former entry, and the worst comparison is shown.`, was, after[0]);
    for (const change of worst) c.changes.push(change);
  }
}

/** breaking > not classified > non-breaking > informational > no change. */
function severity(changes: readonly ContractChange[]): number {
  return changes.reduce((w, ch) => Math.max(w, ch.classification === 'breaking' ? 3 : ch.unclassified === true ? 2 : RANK[ch.classification]), -1);
}

function compareEntity(c: Collector, section: SectionName, before: Rec, after: Rec): void {
  if (section === 'tools') compareTool(c, before as unknown as SnapshotTool, after as unknown as SnapshotTool);
  else if (section === 'prompts') comparePrompt(c, before, after);
  else compareResource(c, before, after);
}

function compareSection(out: ContractChange[], section: SectionName, before: readonly Rec[], after: readonly Rec[]): void {
  const { key } = SECTIONS.find((s) => s.section === section)!;
  const { entity, removed } = ENTITIES[section];
  const group = (list: readonly Rec[]) => {
    const map = new Map<string, Rec[]>();
    for (const e of list) map.set(e[key] as string, [...(map.get(e[key] as string) ?? []), e]);
    return map;
  };
  const b = group(before);
  const a = group(after);
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort(byCodeUnits)) {
    const c = new Collector(entity, name);
    const was = b.get(name) ?? [];
    const is = a.get(name) ?? [];
    if (was.length > 1 || is.length > 1) duplicates(c, section, key, was, is);
    else if (was[0] === undefined) added(c, section, is[0]!);
    else if (is[0] === undefined) c.add(entity, 'breaking', removed, was[0], undefined);
    else compareEntity(c, section, was[0], is[0]);
    for (const change of c.changes) out.push(change);
  }
}

const RANK: Record<ChangeClass, number> = { informational: 0, 'non-breaking': 1, breaking: 2 };

/**
 * A copy whose objects have no prototype, so a key a server chose (`constructor`, `toString`, `__proto__`) reads as
 * that key or as nothing, never as a member of Object. A snapshot is at most a few hundred levels deep (parseSnapshot
 * refuses a deeper file), so the recursion is bounded.
 */
function bare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bare);
  if (!isRecord(value)) return value;
  const out = Object.create(null) as Rec;
  for (const [k, v] of Object.entries(value)) out[k] = bare(v);
  return out;
}

export function summarize(changes: readonly ContractChange[]): ContractDiffSummary {
  const summary: ContractDiffSummary = { breaking: 0, 'non-breaking': 0, informational: 0, unclassified: 0, security: 0, overall: 'none' };
  for (const ch of changes) {
    summary[ch.classification] += 1;
    if (ch.unclassified === true) summary.unclassified += 1;
    if (ch.signal === 'security') summary.security += 1;
    if (summary.overall === 'none' || RANK[ch.classification] > RANK[summary.overall]) summary.overall = ch.classification;
  }
  return summary;
}

/**
 * Every change from `before` to `after`: the server, the transport, the instructions, the capabilities, then tools,
 * resources, resource templates and prompts, each by key. A section that is `null` (not declared) has no entities; its
 * capability says that it went.
 */
export function diffSnapshots(beforeAsRead: McpSnapshot, afterAsRead: McpSnapshot): ContractDiff {
  const before = bare(beforeAsRead) as McpSnapshot;
  const after = bare(afterAsRead) as McpSnapshot;
  const changes: ContractChange[] = [];
  const server = new Collector('server', '');
  compareServer(server, before.server as Rec | null, after.server as Rec | null);
  const whole = new Collector('transport', '');
  if (before.transport !== after.transport) {
    whole.add('transport', 'informational', 'The snapshots were taken over different transports; the contract is compared as it is.', before.transport, after.transport);
  }
  const instructions = new Collector('instructions', '');
  if (!same(before.instructions, after.instructions)) {
    instructions.add('instructions', 'informational', 'The instructions changed: they are what a model is told about the whole server.', before.instructions ?? undefined, after.instructions ?? undefined, {
      signal: 'security',
    });
  }
  for (const change of [server.changes, whole.changes, instructions.changes].flat()) changes.push(change);
  compareCapabilities(changes, before.capabilities, after.capabilities);
  for (const { section } of SECTIONS) {
    const list = (s: McpSnapshot) => (s[section] ?? []) as unknown as readonly Rec[];
    compareSection(changes, section, list(before), list(after));
  }
  return { changes, summary: summarize(changes) };
}

const counts = (s: ContractDiffSummary) =>
  `${s.breaking} breaking, ${s['non-breaking']} non-breaking, ${s.informational} informational (${s.unclassified} not classified, ${s.security} security)`;

const SIGNAL_BADGE: Record<ChangeSignal, string> = { security: 'security', identity: 'server identity' };
const flags = (ch: ContractChange) =>
  [ch.signal === undefined ? '' : SIGNAL_BADGE[ch.signal], ch.unclassified === true ? 'not classified' : ''].filter(Boolean).join(', ');
const subject = (ch: ContractChange) => (ch.name === '' ? ch.entity : `${ch.entity} ${ch.name}`);

/** The diff as plain lines, for a terminal or a failing test. */
export function renderDiffText(diff: ContractDiff): string {
  if (diff.changes.length === 0) return 'No changes to the contract.';
  return [
    `${diff.changes.length} change(s) to the contract, overall ${diff.summary.overall}: ${counts(diff.summary)}`,
    ...diff.changes.map((ch) => {
      const f = flags(ch);
      return `  ${ch.classification.padEnd(13)} ${subject(ch)}  ${ch.field}  ${ch.kind}${f === '' ? '' : ` [${f}]`}: ${ch.reason}`;
    }),
  ].join('\n');
}

/**
 * Server text as one Markdown table cell that renders as text: no HTML (a comment would hide the rest of the comment,
 * or fake another tool's marker), no code span to break out of, no new row; no mention of a person or a team, no link
 * and no image (`@`, `[`, `]`, `!`, `#` as references). `#` right after `&`, before the references that hold one.
 */
export const markdownCell = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/#/g, '&#35;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '&#96;')
    .replace(/@/g, '&#64;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/!/g, '&#33;')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
const cell = markdownCell;

/** The diff as Markdown, for a pull request's run summary or comment. */
export function renderDiffMarkdown(diff: ContractDiff): string {
  if (diff.changes.length === 0) return 'No changes to the contract.\n';
  const { unclassified } = diff.summary;
  return [
    `**Overall: ${diff.summary.overall}** — ${counts(diff.summary)}`,
    '',
    ...(unclassified > 0 ? [`${unclassified} change(s) could not be classified — check them by hand.`, ''] : []),
    '| Class | Entity | Name | Field | Change | Reason |',
    '| --- | --- | --- | --- | --- | --- |',
    ...diff.changes.map((ch) => {
      const f = flags(ch);
      return `| ${ch.classification}${f === '' ? '' : ` (${f})`} | ${ch.entity} | ${cell(ch.name)} | ${cell(ch.field)} | ${ch.kind} | ${cell(ch.reason)} |`;
    }),
    '',
  ].join('\n');
}
