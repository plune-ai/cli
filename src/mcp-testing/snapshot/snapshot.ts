/**
 * A contract snapshot of an MCP server: what the handshake and the four lists (`tools/list`, `resources/list`,
 * `resources/templates/list`, `prompts/list`) say about it, as JSON that reads well in `git diff` and is the same text
 * byte for byte for the same answers. Keys are sorted at every level, entities by their key in code-unit order (never
 * by a locale), two-space indent, one `\n` line ending, no timestamps, no machine paths, and of the connection only its
 * transport: no command, no environment, no URL, no header.
 *
 * A section of a capability the server did not declare is `null`, not `[]`: "not declared" and "declared, empty" are
 * different facts. What changes without changing meaning is dropped before writing: the `$schema` keyword at the root
 * of a schema (it follows the SDK, not the tool), the order of keys and the order of lists that are sets (`required`, a
 * list under `type`, prompt arguments). Everything a client really sees stays, so an SDK update that drops a parameter
 * description still shows in the diff. A key the list holds twice keeps both entries: the diff reports it.
 */

export const SNAPSHOT_KIND = 'plune-mcp-snapshot';
export const SNAPSHOT_SCHEMA_VERSION = 2;
/** The tools-only format before `schemaVersion`; read only to name its version in the refusal. */
const FORMAT_V1 = 'plune-mcp-snapshot/1';

export type SnapshotTransport = 'stdio' | 'http' | 'sse';

/** Contract fields of our own server that `tools/list` does not carry. */
export interface PluneToolFields {
  visibility: 'core' | 'discoverable';
  write: boolean;
}

export interface SnapshotServer {
  name: string;
  version: string;
  title?: string;
}

export interface SnapshotTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  'x-plune'?: PluneToolFields;
}

export interface SnapshotResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface SnapshotResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface SnapshotPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

export interface SnapshotPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: SnapshotPromptArgument[];
}

export interface McpSnapshot {
  kind: typeof SNAPSHOT_KIND;
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  transport: SnapshotTransport;
  server: SnapshotServer | null;
  instructions: string | null;
  capabilities: Record<string, unknown> | null;
  tools: SnapshotTool[] | null;
  resources: SnapshotResource[] | null;
  resourceTemplates: SnapshotResourceTemplate[] | null;
  prompts: SnapshotPrompt[] | null;
}

/** What a server answered, as sent. A list left out was not asked for; the capability it belongs to must not be declared. */
export interface SnapshotInput {
  transport: SnapshotTransport;
  serverInfo?: unknown;
  instructions?: unknown;
  capabilities?: unknown;
  tools?: readonly unknown[];
  resources?: readonly unknown[];
  resourceTemplates?: readonly unknown[];
  prompts?: readonly unknown[];
}

export interface SnapshotOptions {
  /** Our contract fields for a tool, by name; a tool without them gets no `x-plune`. */
  pluneFields?: (name: string) => PluneToolFields | undefined;
  /**
   * Values that must not reach the file wherever a server echoes them (a description, an example, a default): header
   * values, tokens, the server's address. Each occurrence becomes `[redacted]`.
   */
  secrets?: readonly string[];
}

/** A server answer that cannot become a snapshot, or a file that is not one. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotFormatError';
  }
}

/** The four entity lists: the field each is keyed by and the capability that declares it. */
export const SECTIONS = [
  { section: 'tools', key: 'name', capability: 'tools', method: 'tools/list', entity: 'tool' },
  { section: 'resources', key: 'uri', capability: 'resources', method: 'resources/list', entity: 'resource' },
  { section: 'resourceTemplates', key: 'uriTemplate', capability: 'resources', method: 'resources/templates/list', entity: 'resource template' },
  { section: 'prompts', key: 'name', capability: 'prompts', method: 'prompts/list', entity: 'prompt' },
] as const;
export type SectionName = (typeof SECTIONS)[number]['section'];

const FIELDS: Record<SectionName, readonly string[]> = {
  tools: ['title', 'description', 'inputSchema', 'outputSchema', 'annotations'],
  resources: ['name', 'title', 'description', 'mimeType'],
  resourceTemplates: ['name', 'title', 'description', 'mimeType'],
  prompts: ['title', 'description', 'arguments'],
};
const ARGUMENT_FIELDS = ['name', 'title', 'description', 'required'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Code-unit order, the same on every machine: `localeCompare` would sort by the locale of the machine. */
export const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every object with its keys in code-unit order; `fromEntries`, so a key named `__proto__` stays a key. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}

// A secret shorter than this is not looked for: replacing every "1" would wreck the file. A server whose secret is that
// short leaks it here; raise the bar only together with a test.
const MIN_SECRET_LENGTH = 4;

// A home directory at the start of a path: /home/<user>, /Users/<user>, C:\Users\<user>. Not inside a URL path, so a
// `/home/` after a host name is left alone; a path that names no user directory is not caught.
const HOME_DIR = /(?<![\w./\\-])(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])[^\\/\s"'`]+/g;

// A secret is found as written in any letter case, in keys (property names) as in values. A URL-encoded or base64 form
// of it is not, and a home directory only at the start of a path: deliberate limits of a text match.
function redact(value: unknown, secrets: RegExp | undefined): unknown {
  if (typeof value === 'string') return (secrets === undefined ? value : value.replace(secrets, '[redacted]')).replace(HOME_DIR, '~');
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets) as string, redact(v, secrets)]));
}

const isNameList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * `required` and a list under `type` are sets: their order follows the order of declaration, not the contract. Such a
 * list under one of those keys inside example data is sorted as well; it carries no meaning there either way.
 */
function sortSets(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sortSets);
  if (!isRecord(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, (k === 'required' || k === 'type') && isNameList(v) ? [...v].sort() : sortSets(v)]),
  );
}

/** `$schema` at the root of a tool schema names the JSON Schema dialect the SDK writes, not anything about the tool. */
function normalizeSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  return sortSets(Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const text = (v: unknown) => JSON.stringify(sortKeys(v));

/** By key, then (a key listed twice) by the whole entry's text: the same entries give the same order. */
function sortEntities<T>(list: T[], key: (e: T) => string): T[] {
  return list.sort((a, b) => byCodeUnits(key(a), key(b)) || byCodeUnits(text(a), text(b)));
}

/** Prompt arguments are a set by name; an argument without a string name is kept as sent, last. */
function promptArguments(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const args = v.map((a) => (isRecord(a) ? Object.fromEntries(ARGUMENT_FIELDS.filter((f) => a[f] !== undefined).map((f) => [f, a[f]])) : a));
  return sortEntities(args, (a) => (isRecord(a) && typeof a['name'] === 'string' ? a['name'] : '\uffff'));
}

function entry(section: SectionName, raw: unknown, i: number, opts: SnapshotOptions): Record<string, unknown> {
  const { key, method } = SECTIONS.find((s) => s.section === section)!;
  if (!isRecord(raw) || typeof raw[key] !== 'string') throw new SnapshotFormatError(`${method} entry ${i} has no ${key}`);
  const out: Record<string, unknown> = { [key]: raw[key] };
  for (const field of FIELDS[section]) {
    const v = raw[field];
    if (v === undefined) continue;
    out[field] = field === 'inputSchema' || field === 'outputSchema' ? normalizeSchema(v) : field === 'arguments' ? promptArguments(v) : v;
  }
  if (section === 'tools') {
    const plune = opts.pluneFields?.(raw[key]);
    if (plune !== undefined) out['x-plune'] = { visibility: plune.visibility, write: plune.write };
  }
  return out;
}

function server(info: unknown): SnapshotServer | null {
  if (!isRecord(info)) return null;
  return {
    name: typeof info['name'] === 'string' ? info['name'] : '',
    version: typeof info['version'] === 'string' ? info['version'] : '',
    ...(typeof info['title'] === 'string' ? { title: info['title'] } : {}),
  };
}

/** The snapshot of a server's answers, read as data: an entry without its key cannot be compared and throws. */
export function buildSnapshot(input: SnapshotInput, opts: SnapshotOptions = {}): McpSnapshot {
  const list = [...new Set((opts.secrets ?? []).map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET_LENGTH))]
    // The longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const secrets = list.length === 0 ? undefined : new RegExp(list.map(escapeRegExp).join('|'), 'gi');
  const capabilities = isRecord(input.capabilities) ? input.capabilities : null;
  const clean = <T>(v: unknown): T => sortKeys(redact(v, secrets)) as T;

  const snapshot: McpSnapshot = {
    kind: SNAPSHOT_KIND,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    transport: input.transport,
    server: clean(server(input.serverInfo)),
    instructions: typeof input.instructions === 'string' ? clean(input.instructions) : null,
    capabilities: clean(capabilities),
    tools: null,
    resources: null,
    resourceTemplates: null,
    prompts: null,
  };
  for (const { section, key, capability } of SECTIONS) {
    const listed = input[section];
    if (listed === undefined) {
      if (capabilities?.[capability] !== undefined) throw new SnapshotFormatError(`the server declares ${capability}, but no ${section} list was given`);
      continue;
    }
    const entries = listed.map((raw, i) => clean<Record<string, unknown>>(entry(section, raw, i, opts)));
    (snapshot as unknown as Record<string, unknown>)[section] = sortEntities(entries, (e) => e[key] as string);
  }
  return snapshot;
}

/** Tools, resources, resource templates and prompts together: zero means the snapshot measured nothing. */
export const entityCount = (s: McpSnapshot): number => SECTIONS.reduce((n, { section }) => n + (s[section]?.length ?? 0), 0);

export function serializeSnapshot(snapshot: McpSnapshot): string {
  return `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;
}

/** A snapshot file read back; a `SnapshotFormatError` on a file that is not one of this version. */
export function parseSnapshot(raw: string): McpSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotFormatError(`not JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new SnapshotFormatError(`not a ${SNAPSHOT_KIND} file`);
  const found = parsed['format'] === FORMAT_V1 ? 1 : parsed['kind'] === SNAPSHOT_KIND ? parsed['schemaVersion'] : undefined;
  if (found === undefined) throw new SnapshotFormatError(`not a ${SNAPSHOT_KIND} file`);
  if (found !== SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotFormatError(
      `schemaVersion ${JSON.stringify(found)} is not supported: this plune reads schemaVersion ${SNAPSHOT_SCHEMA_VERSION}; take the snapshot again with this version`,
    );
  }
  if (!['stdio', 'http', 'sse'].includes(parsed['transport'] as string)) throw new SnapshotFormatError('the snapshot names no transport');
  for (const { section, key, entity } of SECTIONS) {
    const v = parsed[section];
    if (v === null) continue;
    if (!Array.isArray(v)) throw new SnapshotFormatError(`${section} is neither a list nor null`);
    for (const e of v) if (!isRecord(e) || typeof e[key] !== 'string') throw new SnapshotFormatError(`a ${entity} has no ${key}`);
  }
  for (const k of ['server', 'capabilities'] as const) {
    if (parsed[k] !== null && !isRecord(parsed[k])) throw new SnapshotFormatError(`${k} is neither an object nor null`);
  }
  if (parsed['instructions'] !== null && typeof parsed['instructions'] !== 'string') throw new SnapshotFormatError('instructions is neither text nor null');
  return parsed as unknown as McpSnapshot;
}
