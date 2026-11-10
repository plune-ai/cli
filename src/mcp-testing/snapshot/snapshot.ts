/**
 * A contract snapshot of an MCP server's tools: what a `tools/list` answer says about each tool, as JSON that reads well
 * in `git diff` and is the same text byte for byte for the same answer. Keys are sorted at every level, tools by name,
 * two-space indent, one `\n` line ending, no timestamps and no machine paths.
 *
 * What changes without changing meaning is dropped before writing: the `$schema` keyword at the root of a schema (it
 * follows the SDK, not the tool) and the order of keys. Everything a client really sees stays, so an SDK update that
 * drops a parameter description still shows in the diff.
 */

export const SNAPSHOT_FORMAT = 'plune-mcp-snapshot/1';

/** Contract fields of our own server that `tools/list` does not carry. */
export interface PluneToolFields {
  visibility: 'core' | 'discoverable';
  write: boolean;
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

export interface ToolSnapshot {
  format: string;
  tools: SnapshotTool[];
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

const LISTED_FIELDS = ['title', 'description', 'inputSchema', 'outputSchema', 'annotations'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const s of secrets) text = text.split(s).join('[redacted]');
    return text.replace(HOME_DIR, '~');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, secrets)]));
}

/**
 * A `required` list is a set: its order follows the order the properties were declared in, not the contract. A list of
 * names under a `required` key inside example data is sorted as well; it carries no meaning there either way.
 */
function sortRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sortRequired);
  if (!isRecord(node)) return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === 'required' && Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v].sort() : sortRequired(v),
    ]),
  );
}

/** `$schema` at the root of a tool schema names the JSON Schema dialect the SDK writes, not anything about the tool. */
function normalizeSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  return sortRequired(Object.fromEntries(Object.entries(schema).filter(([k]) => k !== '$schema')));
}

/** A snapshot of a `tools/list` answer, read as data: an entry without a string `name` cannot be compared and throws. */
export function buildSnapshot(listed: readonly unknown[], opts: SnapshotOptions = {}): ToolSnapshot {
  const secrets = [...new Set((opts.secrets ?? []).map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET_LENGTH))]
    // The longest first, so a secret that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const tools = listed.map((entry, i): SnapshotTool => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') throw new Error(`tools/list entry ${i} has no name`);
    const tool: Record<string, unknown> = { name: entry['name'] };
    for (const field of LISTED_FIELDS) {
      const v = entry[field];
      if (v === undefined) continue;
      tool[field] = field === 'inputSchema' || field === 'outputSchema' ? normalizeSchema(v) : v;
    }
    const plune = opts.pluneFields?.(entry['name']);
    if (plune !== undefined) tool['x-plune'] = { visibility: plune.visibility, write: plune.write };
    return sortKeys(redact(tool, secrets)) as SnapshotTool;
  });
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { format: SNAPSHOT_FORMAT, tools };
}

export function serializeSnapshot(snapshot: ToolSnapshot): string {
  return `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;
}

/** A snapshot file read back; throws on a file that is not one. */
export function parseSnapshot(text: string): ToolSnapshot {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || parsed['format'] !== SNAPSHOT_FORMAT || !Array.isArray(parsed['tools'])) {
    throw new Error(`not a ${SNAPSHOT_FORMAT} file`);
  }
  for (const t of parsed['tools']) if (!isRecord(t) || typeof t['name'] !== 'string') throw new Error('a snapshot tool has no name');
  return parsed as unknown as ToolSnapshot;
}
