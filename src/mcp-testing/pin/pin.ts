import { createHash } from 'node:crypto';
import { descriptionTexts, type ScanRule } from '../scan/descriptions.js';
import { diffSnapshots, type ContractChange } from '../snapshot/diff.js';
import {
  byCodeUnits,
  nestedDeeperThan,
  SNAPSHOT_KIND,
  SNAPSHOT_SCHEMA_VERSION,
  sortKeys,
  type McpSnapshot,
  type SnapshotTransport,
} from '../snapshot/snapshot.js';

/**
 * The lock file of `plune mcp pin` (MCP-G3): what a person approved of a server's tools, prompts and resource templates,
 * so that a change after the approval stops a build and shows what changed. The file lives in the user's repository and
 * is committed: a change to it in a pull request is the approval, and git keeps who approved what and when.
 *
 * Every entry is kept whole, as the contract snapshot normalized it (`buildSnapshot`: keys sorted, sets sorted, `$schema`
 * dropped, secrets masked, entities in code-unit order of their key), restricted to the fields of `HASHED_FIELDS`, with
 * the SHA-256 of its canonical JSON beside it. No second normalization: what `plune mcp snapshot` writes and what is
 * pinned here cannot drift apart. The content makes a difference readable field by field; the hash makes it cheap and
 * exact to detect.
 *
 * Pure: no network, no file. The command (src/cli/commands/mcp-pin.ts) connects, reads and writes.
 */

export const LOCK_KIND = 'plune-mcp-lock';
/**
 * The version of the format and of the field lists the hashes cover. Adding a field to `HASHED_FIELDS` would change
 * every hash, so it raises this number; a file of an older version is read and reported as needing a new approval.
 */
export const LOCK_VERSION = 1;
export const LOCK_FILE = 'plune-mcp.lock.json';

/** The fields each hash covers, of lockVersion 1. `execution`, `x-plune` and the server's version are not pinned. */
export const HASHED_FIELDS = {
  tools: ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'],
  prompts: ['name', 'title', 'description', 'arguments'],
  resourceTemplates: ['uriTemplate', 'name', 'title', 'description', 'mimeType'],
} as const;
export type PinnedSection = keyof typeof HASHED_FIELDS;
export const PINNED_SECTIONS = Object.keys(HASHED_FIELDS) as PinnedSection[];

/** The rows of the rule catalog whose task is MCP-G3 (docs/features/mcp-scan/threat-catalog.md), in its order. */
export const PIN_RULES = {
  'scan/pin/tool-changed': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Read the difference; if it is meant, approve it with plune mcp pin and commit the lock file.',
  },
  'scan/pin/tool-added': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Read the new entry in full; if it is meant, approve it with plune mcp pin and commit the lock file.',
  },
  'scan/pin/tool-removed': {
    class: 'deterministic',
    level: 'warn',
    gating: 'yes',
    fix: 'Approve the removal with plune mcp pin, so the lock file matches the server.',
  },
  'scan/pin/server-not-pinned': {
    class: 'deterministic',
    level: 'warn',
    gating: 'yes',
    fix: 'Pin the server with plune mcp pin, or name its entry in the lock file with --name.',
  },
  'scan/pin/list-unstable': {
    class: 'deterministic',
    level: 'warn',
    gating: 'yes',
    fix: 'Find what changes the list between requests (a time, a counter, the caller); a list that changes is announced with notifications/tools/list_changed.',
  },
  'scan/pin/differs-between-sessions': {
    class: 'deterministic',
    level: 'warn',
    gating: 'yes',
    fix: 'Find what the list depends on (the time, the account, the client); pin what a new session gets.',
  },
  'scan/pin/list-changed-announced': {
    class: 'deterministic',
    level: 'info',
    gating: 'no',
    fix: 'Run plune mcp pin --check again after the change.',
  },
} as const satisfies Record<string, ScanRule>;
export type PinRuleId = keyof typeof PIN_RULES;

/** One pinned tool, prompt or resource template: its hashed fields as normalized, and `sha256` of them. */
export type PinnedEntry = Record<string, unknown> & { sha256: string };

export interface PinnedServer {
  transport: SnapshotTransport;
  /** Where the server was reached, without secrets: `stdio` (never the command), or an HTTP origin and path (never the query). */
  source: string;
  /** The server's own name and version, for reference only: neither is in a hash. */
  server: { name: string; version: string } | null;
  /** SHA-256 of the entry hashes of every section, in the snapshot's order. */
  sha256: string;
  /** When the entry was last approved (ISO 8601, UTC). */
  approvedAt: string;
  /** `null`: the server did not declare the capability. */
  tools: PinnedEntry[] | null;
  prompts: PinnedEntry[] | null;
  resourceTemplates: PinnedEntry[] | null;
}

export interface LockFile {
  kind: typeof LOCK_KIND;
  lockVersion: number;
  servers: Record<string, PinnedServer>;
}

/** A lock file that cannot be read as one: exit 2. */
export class LockFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockFormatError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Code-point order (a key above U+FFFF sorts after U+FFFF, which code-unit order would not do). */
export function byCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Canonical JSON: object keys in code-point order, no whitespace, a member whose value is `undefined` left out. Numbers
 * and strings are as `JSON.stringify` writes them, which is the shortest form that reads back as the same number
 * (`0.1`, `1e-7`) and the same escapes on every machine; a key's order as built never counts.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(byCodePoints)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

const KEY: Record<PinnedSection, string> = { tools: 'name', prompts: 'name', resourceTemplates: 'uriTemplate' };
export const keyOf = (section: PinnedSection, entry: Record<string, unknown>): string => entry[KEY[section]] as string;

/** An entry of a snapshot as it is pinned: the hashed fields only, and their hash. */
export function pinEntry(section: PinnedSection, entity: Record<string, unknown>): PinnedEntry {
  const fields: Record<string, unknown> = {};
  for (const f of HASHED_FIELDS[section]) if (entity[f] !== undefined) fields[f] = entity[f];
  return { ...fields, sha256: sha256(fields) };
}

const contentOf = (entry: PinnedEntry): Record<string, unknown> => {
  const { sha256: _, ...rest } = entry;
  return rest;
};

/** The hash of a server: of every section's entry hashes, in the order the snapshot gave them. */
export function serverHash(s: Pick<PinnedServer, PinnedSection>): string {
  return sha256(Object.fromEntries(PINNED_SECTIONS.map((section) => [section, s[section]?.map((e) => e.sha256) ?? null])));
}

/** What a live server is now, as a lock entry. `approvedAt` is the caller's (the time of approval). */
export function pinServer(snapshot: McpSnapshot, source: string, approvedAt: string): PinnedServer {
  const sections = Object.fromEntries(
    PINNED_SECTIONS.map((section) => {
      const list = snapshot[section] as unknown as Record<string, unknown>[] | null;
      return [section, list === null ? null : list.map((e) => pinEntry(section, e))];
    }),
  ) as Pick<PinnedServer, PinnedSection>;
  return {
    transport: snapshot.transport,
    source,
    server: snapshot.server === null ? null : { name: snapshot.server.name, version: snapshot.server.version },
    sha256: serverHash(sections),
    approvedAt,
    ...sections,
  };
}

/** Entries pinned in all: zero means there is nothing to approve. */
export const pinnedCount = (s: Pick<PinnedServer, PinnedSection>): number => PINNED_SECTIONS.reduce((n, k) => n + (s[k]?.length ?? 0), 0);

/** LF only, no BOM, two-space indent, keys sorted: the file's own bytes do not depend on the OS either. */
export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(sortKeys(lock), null, 2)}\n`;
}

export const emptyLock = (): LockFile => ({ kind: LOCK_KIND, lockVersion: LOCK_VERSION, servers: {} });

/** As deep as a snapshot file may be, plus the three levels the lock adds around an entry. */
const MAX_FILE_DEPTH = 260;

/**
 * A lock file read back. Its line ends (a checkout with CRLF) and a byte order mark an editor added do not count: the
 * hashes are of the parsed values. An entry whose hash does not match its content was edited by hand, and a file of
 * another `lockVersion` was pinned over other fields: both are refused, never compared.
 */
export function parseLock(raw: string): LockFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\ufeff/, ''));
  } catch (err) {
    throw new LockFormatError(`not JSON: ${(err as Error).message}`);
  }
  if (nestedDeeperThan(parsed, MAX_FILE_DEPTH)) throw new LockFormatError(`nested deeper than ${MAX_FILE_DEPTH} levels, which no lock file is`);
  if (!isRecord(parsed) || parsed['kind'] !== LOCK_KIND) throw new LockFormatError(`not a ${LOCK_KIND} file`);
  const version = parsed['lockVersion'];
  if (version !== LOCK_VERSION) {
    throw new LockFormatError(
      typeof version === 'number' && Number.isInteger(version) && version < LOCK_VERSION
        ? `lockVersion ${version} hashed other fields than this plune (lockVersion ${LOCK_VERSION}); approve the servers again with plune mcp pin`
        : `lockVersion ${JSON.stringify(version)} is not supported: this plune reads lockVersion ${LOCK_VERSION}`,
    );
  }
  if (!isRecord(parsed['servers'])) throw new LockFormatError('servers is not an object');
  for (const [label, s] of Object.entries(parsed['servers'])) {
    const where = `server ${JSON.stringify(label)}`;
    if (!isRecord(s)) throw new LockFormatError(`${where} is not an object`);
    if (!['stdio', 'http', 'sse'].includes(s['transport'] as string)) throw new LockFormatError(`${where} names no transport`);
    for (const section of PINNED_SECTIONS) {
      const list = s[section];
      if (list === null) continue;
      if (!Array.isArray(list)) throw new LockFormatError(`${where}: ${section} is neither a list nor null`);
      for (const e of list) {
        if (!isRecord(e) || typeof e[KEY[section]] !== 'string' || typeof e['sha256'] !== 'string') {
          throw new LockFormatError(`${where}: an entry of ${section} has no ${KEY[section]} or no sha256`);
        }
        if (sha256(contentOf(e as PinnedEntry)) !== e['sha256']) {
          throw new LockFormatError(
            `${where}: the sha256 of ${section} ${JSON.stringify(e[KEY[section]])} does not match its content (edited by hand?); approve it again with plune mcp pin`,
          );
        }
      }
    }
    if (s['sha256'] !== serverHash(s as unknown as PinnedServer)) {
      throw new LockFormatError(`${where}: its sha256 does not match its entries (edited by hand?); approve it again with plune mcp pin`);
    }
  }
  return parsed as unknown as LockFile;
}

export type PinClass = 'changed' | 'added' | 'removed';

/** One key of one section whose pinned and live entries differ. */
export interface PinDifference {
  class: PinClass;
  section: PinnedSection;
  /** The tool or prompt name, or the URI template. */
  name: string;
  /** For tools: the catalog rule. */
  rule?: PinRuleId;
  /** A text the model reads (a name, title or description, of the entry or of a parameter) is not what was approved. */
  modelText: boolean;
  /** Field by field, as `plune mcp diff` classifies them; empty for an entry that came or went whole. */
  changes: ContractChange[];
  pinned: PinnedEntry[];
  live: PinnedEntry[];
}

export interface PinComparison {
  /** True when the server hash is the pinned one: nothing to look at. */
  same: boolean;
  differences: PinDifference[];
  /** How many keys are as pinned. */
  unchanged: number;
  /** The server's version, pinned and live, when it changed: shown for reference, never a difference. */
  version?: { pinned: string; live: string };
}

const ENTITY: Record<PinnedSection, ContractChange['entity']> = { tools: 'tool', prompts: 'prompt', resourceTemplates: 'resourceTemplate' };
const TOOL_RULE: Record<PinClass, PinRuleId> = { changed: 'scan/pin/tool-changed', added: 'scan/pin/tool-added', removed: 'scan/pin/tool-removed' };

/** A snapshot holding only the pinned sections, so the classification of `plune mcp diff` reads them as it reads any. */
function asSnapshot(transport: SnapshotTransport, s: Pick<PinnedServer, PinnedSection>): McpSnapshot {
  const strip = (list: PinnedEntry[] | null) => (list === null ? null : list.map(contentOf));
  return {
    kind: SNAPSHOT_KIND,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    transport,
    server: null,
    instructions: null,
    capabilities: null,
    tools: strip(s.tools) as McpSnapshot['tools'],
    resources: null,
    resourceTemplates: strip(s.resourceTemplates) as McpSnapshot['resourceTemplates'],
    prompts: strip(s.prompts) as McpSnapshot['prompts'],
  };
}

/**
 * The prose a model reads in some entries of one section, with where it is: every name, title and description, of the
 * entry and inside its schemas and arguments (the walk of the description rules). Property names, enum values and the
 * like are text too, but a change to them is a schema change, shown as one.
 */
function modelTexts(section: PinnedSection, entries: PinnedEntry[]): string {
  const s = asSnapshot('stdio', { tools: null, prompts: null, resourceTemplates: null, [section]: entries });
  return descriptionTexts(s)
    .filter((t) => !t.key && /\/(name|title|description)$/.test(t.pointer))
    .map((t) => `${t.pointer}\u0000${t.text}`)
    .sort()
    .join('\u0001');
}

const group = (section: PinnedSection, list: PinnedEntry[] | null): Map<string, PinnedEntry[]> => {
  const map = new Map<string, PinnedEntry[]>();
  for (const e of list ?? []) map.set(keyOf(section, e), [...(map.get(keyOf(section, e)) ?? []), e]);
  return map;
};
const hashes = (list: PinnedEntry[]) => list.map((e) => e.sha256).join(',');

/**
 * The live server against its pinned entry. The verdict is the server hash; only when it differs is each key compared,
 * and each changed one gets its field-by-field difference. The order of a list is not a change (the snapshot sorts every
 * list by key); a server's version is not either.
 */
export function comparePinned(pinned: PinnedServer, live: PinnedServer): PinComparison {
  const version =
    pinned.server !== null && live.server !== null && pinned.server.version !== live.server.version
      ? { pinned: pinned.server.version, live: live.server.version }
      : undefined;
  const differences: PinDifference[] = [];
  let unchanged = 0;
  if (pinned.sha256 !== live.sha256) {
    const changes = diffSnapshots(asSnapshot(pinned.transport, pinned), asSnapshot(live.transport, live)).changes;
    for (const section of PINNED_SECTIONS) {
      const before = group(section, pinned[section]);
      const after = group(section, live[section]);
      for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(byCodeUnits)) {
        const was = before.get(name) ?? [];
        const is = after.get(name) ?? [];
        if (hashes(was) === hashes(is)) {
          unchanged++;
          continue;
        }
        const cls: PinClass = was.length === 0 ? 'added' : is.length === 0 ? 'removed' : 'changed';
        differences.push({
          class: cls,
          section,
          name,
          ...(section === 'tools' ? { rule: TOOL_RULE[cls] } : {}),
          modelText: modelTexts(section, was) !== modelTexts(section, is),
          changes: cls === 'changed' ? changes.filter((c) => c.entity === ENTITY[section] && c.name === name) : [],
          pinned: was,
          live: is,
        });
      }
    }
    // The hashes differ and no key does: the lists differ in order (the snapshot sorts them, so that is a bug to see),
    // or a section went from declared and empty to not declared. Never a match to pass.
    if (differences.length === 0) {
      differences.push({ class: 'changed', section: 'tools', name: '', modelText: false, changes: [], pinned: [], live: [] });
    }
  } else unchanged = PINNED_SECTIONS.reduce((n, section) => n + group(section, live[section]).size, 0);
  // What the model reads first: a reviewer looks at those before the rest.
  differences.sort((a, b) => Number(b.modelText) - Number(a.modelText));
  return { same: differences.length === 0, differences, unchanged, ...(version === undefined ? {} : { version }) };
}

/**
 * `pinned` with the approved differences taken from `live`, every other key left as it was pinned. Keys keep the
 * snapshot's order (code units), and the entries under a key keep the order of the side they come from.
 */
export function applyApproved(pinned: PinnedServer, live: PinnedServer, approved: readonly PinDifference[], approvedAt: string): PinnedServer {
  const take = new Set(approved.map((d) => `${d.section}\u0000${d.name}`));
  const sections = Object.fromEntries(
    PINNED_SECTIONS.map((section) => {
      const before = group(section, pinned[section]);
      const after = group(section, live[section]);
      const merged = [...new Set([...before.keys(), ...after.keys()])]
        .sort(byCodeUnits)
        .flatMap((name) => (take.has(`${section}\u0000${name}`) ? after.get(name) : before.get(name)) ?? []);
      // A section the server no longer declares is `null` once nothing pinned is left in it.
      return [section, live[section] === null && merged.length === 0 ? null : merged];
    }),
  ) as Pick<PinnedServer, PinnedSection>;
  return { ...live, ...sections, sha256: serverHash(sections), approvedAt };
}

export interface StabilityFinding {
  rule: 'scan/pin/list-unstable' | 'scan/pin/differs-between-sessions' | 'scan/pin/list-changed-announced';
  level: 'warn' | 'info';
  gating: boolean;
  message: string;
}

/** What `--stability` saw: each `tools/list` answer of the first session as pinned entries, and one of a new session. */
export interface StabilityAnswers {
  first: PinnedEntry[][];
  second: PinnedEntry[];
  /** `notifications/tools/list_changed` received in the first session, its wait included. */
  announced: number;
  /** The server declared `tools.listChanged: true`. */
  declared: boolean;
}

/** The names whose entries differ between two answers. */
export function differingNames(a: PinnedEntry[], b: PinnedEntry[]): string[] {
  const x = group('tools', a);
  const y = group('tools', b);
  return [...new Set([...x.keys(), ...y.keys()])].sort(byCodeUnits).filter((n) => hashes(x.get(n) ?? []) !== hashes(y.get(n) ?? []));
}

const listHash = (answer: PinnedEntry[]) => hashes(answer);
const named = (names: string[]) => names.map((n) => JSON.stringify(n)).join(', ');

function finding(rule: StabilityFinding['rule'], message: string): StabilityFinding {
  const r = PIN_RULES[rule];
  return { rule, level: r.level, gating: r.gating === 'yes', message };
}

/**
 * The findings of `--stability`. A list that changes within a session is legal when the server announces it; then it is
 * `info`, and only the unannounced change is a warning. A new session is compared with the first answer of the first.
 */
export function stabilityFindings(a: StabilityAnswers): StabilityFinding[] {
  const out: StabilityFinding[] = [];
  const first = a.first[0] ?? [];
  const distinct = new Set(a.first.map(listHash));
  if (distinct.size > 1 && a.announced === 0) {
    const changed = a.first.slice(1).find((answer) => listHash(answer) !== listHash(first)) ?? [];
    out.push(
      finding(
        'scan/pin/list-unstable',
        `tools/list answered ${distinct.size} different lists in ${a.first.length} requests without list_changed (${named(differingNames(first, changed))} differ)`,
      ),
    );
  }
  if (listHash(a.second) !== listHash(first)) {
    const names = differingNames(first, a.second);
    out.push(finding('scan/pin/differs-between-sessions', `a new session got a different tool list (${names.length} ${names.length === 1 ? 'tool differs' : 'tools differ'}: ${named(names)})`));
  }
  if (a.announced > 0) {
    out.push(
      finding(
        'scan/pin/list-changed-announced',
        `the server announced a tool list change (allowed by the protocol${a.declared ? '' : ', though it did not declare tools.listChanged'}); re-run pin --check after it`,
      ),
    );
  }
  return out;
}

/** One connection as `--stability` uses it. */
export interface ListingSession {
  /** `tools/list` to its last page, as pinned entries. */
  tools(): Promise<PinnedEntry[]>;
  /** `notifications/tools/list_changed` received so far. */
  announced(): number;
  declared: boolean;
  close(): Promise<void>;
}

export interface StabilityOptions {
  /** Requests in the first session. */
  times: number;
  /** Between two requests. */
  pauseMs: number;
  /** After the last request, how long a `list_changed` is waited for. */
  waitMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `times` answers in one session with `pauseMs` between them, a wait of `waitMs` for an announcement, then one answer in
 * a new session. What a server answers another client, at another time or from another address is not seen.
 */
export async function measureStability(open: () => Promise<ListingSession>, opts: StabilityOptions): Promise<StabilityAnswers> {
  const first: PinnedEntry[][] = [];
  let announced: number;
  let declared: boolean;
  const one = await open();
  try {
    declared = one.declared;
    for (let i = 0; i < opts.times; i++) {
      if (i > 0) await sleep(opts.pauseMs);
      first.push(await one.tools());
    }
    await sleep(opts.waitMs);
    announced = one.announced();
  } finally {
    await one.close();
  }
  const two = await open();
  try {
    return { first, second: await two.tools(), announced, declared };
  } finally {
    await two.close();
  }
}
