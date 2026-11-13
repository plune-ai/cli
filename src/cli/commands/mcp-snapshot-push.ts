// `plune mcp snapshot --push`: send the contract snapshot to the platform's MCP catalog.
//
// The request shape lives in this one file (`snapshotBody`, the two paths), so a change in the platform's contract
// is a change here and nowhere else. It is built from a list of the fields the platform accepts, not from the
// snapshot as it is: the platform refuses a field it does not know (400), and a field it would keep must never be one
// that describes how this machine reached the server. The snapshot has no command, address, header or environment
// variable to begin with; the list makes that a property of this file, not of the snapshot writer.
//
// The client is the one every command uses (`reporter-core/client.ts`): retries, the `Retry-After` pause, the
// classification of an answer, and the token scrubbed out of anything the far side says back.

import { resolveApiUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import {
  createClient,
  type ClientOutcome,
  type PlatformClient,
} from '../../reporter-core/client.js';
import type { McpSnapshot } from '../../mcp-testing/snapshot/index.js';

/** The platform contract this was written against: plune-ai/plune#2730 (`src/contracts/mcp-server.ts`), head b93dad0. */
const MAX_SERVER_NAME = 100;
const MAX_ENVIRONMENT = 100;

export interface PushDeps {
  apiUrl?: string;
  loadToken?: () => string | null;
  fetchImpl?: typeof fetch;
  /** Test seam: the pause between retries. */
  wait?: (ms: number) => Promise<void>;
}

export interface PushTarget {
  /** The id of a server the platform already has. */
  serverId?: string;
  /** Its name: found among the project's servers, or created on the first push. */
  serverName?: string;
  /** Where the server was running (`ci`, `staging`); not part of the contract. */
  environment?: string;
}

/** What the platform said about the snapshot. */
export interface PushResult {
  serverId: string;
  /** The server's name, when the push named it. */
  serverName?: string;
  number: number;
  hash: string;
  tools: number | null;
  /** 201: a new snapshot. false: the platform already held this contract as its latest snapshot (200). */
  created: boolean;
  /** The platform made the server for this push. */
  serverCreated: boolean;
}

/**
 * The push did not happen, and why. `kind` decides the exit code: `unavailable` is exit 1 (try again later, the
 * snapshot is kept), everything else is exit 2 (something to fix here).
 */
export class SnapshotPushError extends Error {
  constructor(
    readonly kind:
      | 'usage'
      | 'not-logged-in'
      | 'auth'
      | 'invalid'
      | 'not-found'
      | 'conflict'
      | 'unavailable'
      | 'other',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotPushError';
  }
}

const pick = <T extends Record<string, unknown>>(
  from: T,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(
    keys.filter((k) => Object.hasOwn(from, k) && from[k] !== undefined).map((k) => [k, from[k]]),
  );

const ENTITY_FIELDS = {
  tools: [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
    'execution',
    'x-plune',
  ],
  resources: ['uri', 'name', 'title', 'description', 'mimeType'],
  resourceTemplates: ['uriTemplate', 'name', 'title', 'description', 'mimeType'],
  prompts: ['name', 'title', 'description', 'arguments'],
} as const;
const ARGUMENT_FIELDS = ['name', 'title', 'description', 'required'] as const;
const SERVER_FIELDS = ['name', 'version', 'title'] as const;

const entities = (
  list: readonly unknown[] | null,
  fields: readonly string[],
): Record<string, unknown>[] | null =>
  list === null
    ? null
    : (list as Record<string, unknown>[]).map((e) => {
        const entry = pick(e, fields);
        if (Array.isArray(entry['arguments'])) {
          entry['arguments'] = (entry['arguments'] as Record<string, unknown>[]).map((a) =>
            pick(a, ARGUMENT_FIELDS),
          );
        }
        return entry;
      });

/** The body of `POST /v1/mcp-servers/:id/snapshots`: the fields the platform accepts, and no other. */
export function snapshotBody(snapshot: McpSnapshot, environment?: string): Record<string, unknown> {
  return {
    kind: snapshot.kind,
    schemaVersion: snapshot.schemaVersion,
    transport: snapshot.transport,
    ...(environment !== undefined ? { environment } : {}),
    server:
      snapshot.server === null
        ? null
        : pick(snapshot.server as unknown as Record<string, unknown>, SERVER_FIELDS),
    instructions: snapshot.instructions,
    capabilities: snapshot.capabilities,
    tools: entities(snapshot.tools, ENTITY_FIELDS.tools),
    resources: entities(snapshot.resources, ENTITY_FIELDS.resources),
    resourceTemplates: entities(snapshot.resourceTemplates, ENTITY_FIELDS.resourceTemplates),
    prompts: entities(snapshot.prompts, ENTITY_FIELDS.prompts),
  };
}

/** The flags, checked before anything is connected to or sent. Returns the plain problem, or `undefined`. */
export function checkPushFlags(flags: {
  push?: boolean | undefined;
  server?: string | undefined;
  serverName?: string | undefined;
  environment?: string | undefined;
}): string | undefined {
  if (flags.push !== true) {
    const stray = (['server', 'serverName', 'environment'] as const).find(
      (k) => flags[k] !== undefined,
    );
    if (stray === undefined) return undefined;
    return `--${stray === 'serverName' ? 'server-name' : stray} only means something with --push.`;
  }
  const hasId = flags.server !== undefined;
  const hasName = flags.serverName !== undefined;
  if (hasId === hasName)
    return '--push needs exactly one of --server <id> and --server-name <name>.';
  if (flags.server !== undefined && flags.server.trim() === '')
    return '--server must not be empty.';
  if (flags.serverName !== undefined) {
    const n = flags.serverName.trim();
    if (n === '' || n.length > MAX_SERVER_NAME)
      return `--server-name must be 1 to ${MAX_SERVER_NAME} characters.`;
  }
  if (flags.environment !== undefined) {
    const e = flags.environment.trim();
    if (e === '' || e.length > MAX_ENVIRONMENT)
      return `--environment must be 1 to ${MAX_ENVIRONMENT} characters.`;
  }
  return undefined;
}

/** The token, or the plain refusal: asked before the server is connected to, so a logged-out user waits for nothing. */
export function pushToken(deps: PushDeps): string {
  const token = (deps.loadToken ?? loadToken)();
  if (token === null || token === '') {
    throw new SnapshotPushError(
      'not-logged-in',
      'Not logged in. Run "plune login" first, or set PLUNE_TOKEN. Nothing was sent.',
    );
  }
  return token;
}

function failure(
  out: Extract<ClientOutcome<unknown>, { ok: false }>,
  what: string,
): SnapshotPushError {
  const said = out.detail === '' ? '' : `: ${out.detail}`;
  switch (out.kind) {
    case 'auth':
      return new SnapshotPushError(
        'auth',
        out.status === 401
          ? 'Your API token was rejected (401). Run "plune login" again with a fresh token.'
          : `The platform refused ${what} (${out.status})${said}. Writing the MCP catalog needs a token that may write.`,
      );
    case 'invalid':
      return new SnapshotPushError(
        'invalid',
        `The platform refused ${what} (${out.status ?? 400})${said}.`,
      );
    case 'conflict':
      return new SnapshotPushError('conflict', `The platform refused ${what} (409)${said}.`);
    case 'unavailable':
      return new SnapshotPushError(
        'unavailable',
        out.status === null
          ? 'Could not reach the Plune API. Check your connection, then try again.'
          : `The Plune API answered ${out.status}${said}. Try again later.`,
      );
    default:
      return out.status === 404
        ? new SnapshotPushError('not-found', `The platform has no ${what}${said}.`)
        : new SnapshotPushError(
            'other',
            `The platform answered ${out.status ?? 'with something unreadable'} to ${what}${said}.`,
          );
  }
}

interface ServerRow {
  id: string;
  name: string;
}
const isServerRow = (v: unknown): v is ServerRow =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as ServerRow).id === 'string' &&
  typeof (v as ServerRow).name === 'string';

/** Push one snapshot. Throws `SnapshotPushError`; never prints. */
export async function pushSnapshot(
  snapshot: McpSnapshot,
  target: PushTarget,
  token: string,
  deps: PushDeps = {},
): Promise<PushResult> {
  const client: PlatformClient = createClient({
    apiUrl: resolveApiUrl(deps.apiUrl),
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.wait !== undefined ? { wait: deps.wait } : {}),
  });

  let serverId = target.serverId;
  let serverCreated = false;
  if (serverId === undefined) {
    const name = (target.serverName ?? '').trim();
    const find = async (): Promise<string | undefined> => {
      const listed = await client.get<{ servers?: unknown }>('/v1/mcp-servers');
      if (!listed.ok) throw failure(listed, 'the list of MCP servers');
      const rows = Array.isArray(listed.body.servers)
        ? listed.body.servers.filter(isServerRow)
        : [];
      return rows.find((s) => s.name === name)?.id;
    };
    serverId = await find();
    if (serverId === undefined) {
      // Not retried: a created server whose answer was lost would be found by the next push, by name.
      const made = await client.post<{ id?: unknown }>(
        '/v1/mcp-servers',
        { name, transport: snapshot.transport === 'stdio' ? 'stdio' : 'http' },
        0,
      );
      if (made.ok && typeof made.body.id === 'string') {
        serverId = made.body.id;
        serverCreated = true;
      } else if (!made.ok && made.kind === 'conflict') {
        // Another push made it between our look and our create: it is there now.
        serverId = await find();
      } else if (!made.ok) throw failure(made, 'to add the MCP server');
      if (serverId === undefined)
        throw new SnapshotPushError('other', 'The platform did not name the MCP server it made.');
    }
  }

  const sent = await client.post<{
    id?: unknown;
    number?: unknown;
    hash?: unknown;
    tools?: unknown;
  }>(
    `/v1/mcp-servers/${encodeURIComponent(serverId)}/snapshots`,
    snapshotBody(snapshot, target.environment?.trim()),
  );
  if (!sent.ok)
    throw failure(
      sent,
      target.serverId !== undefined ? `MCP server '${serverId}'` : 'the snapshot',
    );
  const { number, hash, tools } = sent.body;
  if (typeof number !== 'number' || !Number.isInteger(number) || typeof hash !== 'string') {
    throw new SnapshotPushError(
      'other',
      'The platform answered, but not with a snapshot (no number or hash).',
    );
  }
  return {
    serverId,
    ...(target.serverName !== undefined ? { serverName: target.serverName.trim() } : {}),
    number,
    hash,
    tools: typeof tools === 'number' ? tools : null,
    created: sent.status === 201,
    serverCreated,
  };
}

/** The lines `plune mcp snapshot --push` prints on success, plainly: new snapshot, or the same contract again. */
export function describePush(r: PushResult): string {
  const where = r.serverName !== undefined ? `server "${r.serverName}"` : `server ${r.serverId}`;
  const made = r.serverCreated ? `Added ${where} to the platform.\n` : '';
  const what = r.created
    ? `Pushed snapshot ${r.number} of ${where}: a new contract (${r.hash.slice(0, 12)}).`
    : `Snapshot ${r.number} of ${where} already holds this contract (${r.hash.slice(0, 12)}); nothing new was recorded.`;
  return `${made}${what}\n`;
}
