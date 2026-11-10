import type { SnapshotTool, ToolSnapshot } from './snapshot.js';

/**
 * Two snapshots compared, every change classified by fixed rules (the first that matches), so the same change always gets
 * the same class and a test can say why. A change no rule knows is not dropped and not called safe: it is
 * `informational` with `unclassified: true`, and the summary counts those apart.
 *
 * A description or a title is its own record. A description changes what a model is told to do with the tool, so a
 * change to it carries `security: true`: after a description was approved, a new one is how a tool is swapped under a
 * client, and it must not hide among the small edits.
 */

export type ChangeKind = 'added' | 'removed' | 'modified';
export type ChangeClass = 'breaking' | 'non-breaking' | 'informational';

export interface ContractChange {
  tool: string;
  /** `tool`, `title`, `description`, `annotations.<hint>`, `x-plune.<field>`, or a schema path: `inputSchema.cases[].id`. */
  field: string;
  kind: ChangeKind;
  classification: ChangeClass;
  /** One sentence. */
  reason: string;
  before: unknown;
  after: unknown;
  /** A change to what a model reads about the tool. */
  security?: true;
  /** No rule knew this change. */
  unclassified?: true;
}

export interface ContractDiffSummary {
  breaking: number;
  'non-breaking': number;
  informational: number;
  /** Of the informational ones, how many no rule knew. */
  unclassified: number;
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

class Collector {
  readonly changes: ContractChange[] = [];
  constructor(private readonly tool: string) {}

  add(field: string, classification: ChangeClass, reason: string, before: unknown, after: unknown, extra: Partial<ContractChange> = {}): void {
    this.changes.push({ tool: this.tool, field, kind: kindOf(before, after), classification, reason, before, after, ...extra });
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

  if (!same(before['type'], after['type'])) {
    // The rest of the node follows the type, so it is not reported on its own.
    return c.add(`${field}`, 'breaking', `The type changed from ${show(before['type'])} to ${show(after['type'])}.`, before['type'], after['type']);
  }
  if (!same(before['enum'], after['enum'])) compareEnum(c, side, field, before['enum'], after['enum']);
  compareProperties(c, side, path, field, before, after);
  if (!same(before['items'], after['items'])) compareSchema(c, side, `${path}[]`, before['items'], after['items']);
  if (!same(before['description'], after['description'])) {
    if (path === '') c.unknown(field, 'the description of the whole schema', before['description'], after['description']);
    else {
      c.add(field, 'informational', `The ${side === 'input' ? 'parameter' : 'field'} description changed: it is what a model reads.`, before['description'], after['description'], {
        security: true,
      });
    }
  }
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (SCHEMA_RULED.has(k) || same(before[k], after[k])) continue;
    c.unknown(field, `\`${k}\``, before[k], after[k]);
  }
}

function compareEnum(c: Collector, side: Side, field: string, before: unknown, after: unknown): void {
  if (side === 'output') return c.unknown(field, 'the enum of a returned value', before, after);
  if (before === undefined && Array.isArray(after)) return c.add(field, 'breaking', 'The values were narrowed to a list.', before, after);
  if (Array.isArray(before) && after === undefined) return c.add(field, 'non-breaking', 'The list of allowed values was lifted.', before, after);
  if (!Array.isArray(before) || !Array.isArray(after)) return c.unknown(field, 'the enum', before, after);
  const b = valueSet(before);
  const a = valueSet(after);
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const added = [...a.keys()].filter((k) => !b.has(k));
  if (removed.length === 0 && added.length === 0) return; // reordered only
  if (added.length === 0) return c.add(field, 'breaking', `The enum was narrowed: ${removed.join(', ')} no longer allowed.`, before, after);
  if (removed.length === 0) return c.add(field, 'non-breaking', `The enum was widened: ${added.join(', ')} now allowed.`, before, after);
  c.unknown(field, 'the enum (values both added and removed)', before, after);
}

function compareProperties(c: Collector, side: Side, path: string, field: string, before: Rec, after: Rec): void {
  const bp = isRecord(before['properties']) ? before['properties'] : {};
  const ap = isRecord(after['properties']) ? after['properties'] : {};
  const br = stringSet(before['required']);
  const ar = stringSet(after['required']);
  if (!isRecord(before['properties']) && before['properties'] !== undefined) c.unknown(field, '`properties`', before['properties'], after['properties']);
  else if (!isRecord(after['properties']) && after['properties'] !== undefined) c.unknown(field, '`properties`', before['properties'], after['properties']);
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
    const modified = { kind: 'modified' as const };
    if (!(k in HINT_DEFAULTS)) {
      if (k === 'title') c.add(field, 'informational', 'The display title in the annotations changed.', b[k], a[k], modified);
      else c.unknown(field, `\`${k}\``, b[k], a[k]);
      continue;
    }
    const was = typeof b[k] === 'boolean' ? b[k] : HINT_DEFAULTS[k];
    const is = typeof a[k] === 'boolean' ? a[k] : HINT_DEFAULTS[k];
    if (k === 'readOnlyHint' && was === true && is === false) {
      c.add(field, 'breaking', 'The tool is no longer read-only: a client that ran it unattended now runs a writer.', b[k], a[k], modified);
    } else if (k === 'destructiveHint' && was === false && is === true) {
      c.add(field, 'breaking', 'The tool may now destroy data: a client that ran it without asking now must ask.', b[k], a[k], modified);
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

function compareTool(c: Collector, before: SnapshotTool, after: SnapshotTool): void {
  if (!same(before.title, after.title)) c.add('title', 'informational', 'The title changed.', before.title, after.title);
  if (!same(before.description, after.description)) {
    c.add('description', 'informational', 'The description changed: it is what a model is told about the tool.', before.description, after.description, {
      security: true,
    });
  }
  compareSchema(c, 'input', '', before.inputSchema, after.inputSchema);
  compareSchema(c, 'output', '', before.outputSchema, after.outputSchema);
  compareAnnotations(c, before.annotations, after.annotations);
  comparePluneFields(c, before['x-plune'], after['x-plune']);
}

const RANK: Record<ChangeClass, number> = { informational: 0, 'non-breaking': 1, breaking: 2 };

export function summarize(changes: readonly ContractChange[]): ContractDiffSummary {
  const summary: ContractDiffSummary = { breaking: 0, 'non-breaking': 0, informational: 0, unclassified: 0, security: 0, overall: 'none' };
  for (const ch of changes) {
    summary[ch.classification] += 1;
    if (ch.unclassified === true) summary.unclassified += 1;
    if (ch.security === true) summary.security += 1;
    if (summary.overall === 'none' || RANK[ch.classification] > RANK[summary.overall]) summary.overall = ch.classification;
  }
  return summary;
}

/** Every change from `before` to `after`, tools in name order. */
export function diffSnapshots(before: ToolSnapshot, after: ToolSnapshot): ContractDiff {
  const b = new Map(before.tools.map((t) => [t.name, t]));
  const a = new Map(after.tools.map((t) => [t.name, t]));
  const changes: ContractChange[] = [];
  for (const name of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const c = new Collector(name);
    const was = b.get(name);
    const is = a.get(name);
    if (was === undefined) c.add('tool', 'non-breaking', 'A new tool.', undefined, is);
    else if (is === undefined) c.add('tool', 'breaking', 'The tool was removed: a client that calls it now fails.', was, undefined);
    else compareTool(c, was, is);
    changes.push(...c.changes);
  }
  return { changes, summary: summarize(changes) };
}

const counts = (s: ContractDiffSummary) =>
  `${s.breaking} breaking, ${s['non-breaking']} non-breaking, ${s.informational} informational (${s.unclassified} not classified, ${s.security} security)`;

const flags = (ch: ContractChange) => [ch.security === true ? 'security' : '', ch.unclassified === true ? 'not classified' : ''].filter(Boolean).join(', ');

/** The diff as plain lines, for a terminal or a failing test. */
export function renderDiffText(diff: ContractDiff): string {
  if (diff.changes.length === 0) return 'No changes to the tool contract.';
  return [
    `${diff.changes.length} change(s) to the tool contract, overall ${diff.summary.overall}: ${counts(diff.summary)}`,
    ...diff.changes.map((ch) => {
      const f = flags(ch);
      return `  ${ch.classification.padEnd(13)} ${ch.tool}  ${ch.field}  ${ch.kind}${f === '' ? '' : ` [${f}]`}: ${ch.reason}`;
    }),
  ].join('\n');
}

const cell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\|');

/** The diff as Markdown, for a pull request's run summary. */
export function renderDiffMarkdown(diff: ContractDiff): string {
  if (diff.changes.length === 0) return 'No changes to the tool contract.\n';
  return [
    `**Overall: ${diff.summary.overall}** — ${counts(diff.summary)}`,
    '',
    '| Class | Tool | Field | Change | Reason |',
    '| --- | --- | --- | --- | --- |',
    ...diff.changes.map((ch) => {
      const f = flags(ch);
      return `| ${ch.classification}${f === '' ? '' : ` (${f})`} | \`${cell(ch.tool)}\` | \`${cell(ch.field)}\` | ${ch.kind} | ${cell(ch.reason)} |`;
    }),
    '',
  ].join('\n');
}
