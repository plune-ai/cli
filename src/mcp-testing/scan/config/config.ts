import { noCommands } from '../../report/human.js';
import type { McpSnapshot } from '../../snapshot/snapshot.js';
import {
  descriptionTexts,
  findToolNames,
  visible,
  type ScanClass,
  type ScanLevel,
  type ScanRule,
} from '../descriptions.js';
import {
  lineLocator,
  parseJson,
  type JsonMember,
  type JsonNode,
  type ParseErrorCategory,
} from './json-tree.js';

/**
 * The `scan/cfg/*` and `scan/cross/*` rules of `plune mcp scan` (docs/features/mcp-scan/threat-catalog.md, MCP-G4):
 * what a client's MCP configuration file says about the servers it starts, and what the tool lists of several servers
 * say about each other. A pure function of text it is given: it reads no file (the caller names and reads them), starts
 * nothing and opens no connection. The command, the choice of files and the exit codes are MCP-G6's.
 *
 * What a finding holds: the rule, the server label, the path of the field (`mcpServers.github.env.GITHUB_TOKEN`), the
 * line and column of its value, a fixed sentence. Never the value, a part of it, its length or a hash: not for a
 * secret, and not for an address or a package name either, which are values of the file too. A key or a label is
 * shown (it is the name the person gave), cut to 64 characters and escaped; one that has the form of a token is not.
 * Text from the file is also made safe to print: no character that does not print, nothing that starts a line with
 * `::` or holds `##[` (see `noCommands`).
 */

export type ClientId = 'claude-code' | 'cursor' | 'vscode' | 'claude-desktop';

/** The rows of the catalog whose task is MCP-G4, in its order; a test reads the catalog table against this. */
export const CONFIG_RULES = {
  'scan/cross/duplicate-tool-name': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Rename a tool on one of the servers, or run the servers in separate sessions; a client has to tell same-named tools apart.',
  },
  'scan/cross/foreign-tool-reference': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Read the text: a description should say what its own tool does, not how to use a tool of another server.',
  },
  'scan/cfg/secret-known-format': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Take the value out of the file and refer to it, for example ${GITHUB_TOKEN}; treat the token as exposed and replace it.',
  },
  'scan/cfg/secret-in-url': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Move the credential to a header or an environment variable and refer to it; an address ends up in logs and history.',
  },
  'scan/cfg/secret-by-name': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'If the value is a secret, replace the literal with a reference such as ${NAME} (${env:NAME} in Cursor, ${input:id} in VS Code).',
  },
  'scan/cfg/broad-filesystem-root': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Give a file server the one folder it needs, not a whole drive or the home directory.',
  },
  'scan/cfg/shell-command': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Start the server program directly, with its arguments in `args`, instead of through a shell and a script string.',
  },
  'scan/cfg/download-to-shell': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Install the program first and start it by name, so what runs is something you have looked at.',
  },
  'scan/cfg/http-plaintext': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Use an https address; plain http to another host can be read and changed on the way.',
  },
  'scan/cfg/foreign-host': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Check that the host is one you mean to send requests to, or add it to the list you pass.',
  },
  'scan/cfg/invalid-entry': {
    class: 'deterministic',
    level: 'warn',
    gating: 'no',
    fix: 'Give the entry a `command` or a `url`, put it under the key this client reads, or remove it; it was not assessed.',
  },
  'scan/cfg/env-file-not-read': {
    class: 'deterministic',
    level: 'info',
    gating: 'no',
    fix: 'Pass the file to the scan too, or check by hand that it holds no secret that is committed.',
  },
  'scan/cfg/unpinned-package': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Pin the package to an exact version (name@1.2.3, or name==1.2.3 for uvx) and update it on purpose.',
  },
  'scan/cfg/auto-confirm': {
    class: 'deterministic',
    level: 'warn',
    gating: 'no',
    fix: 'Pin the package to an exact version; then the flag only skips a prompt about a package you chose.',
  },
  'scan/cfg/package-not-allowed': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Check the exact spelling of the package name against the one you meant, or add it to the list you pass.',
  },
} as const satisfies Record<string, ScanRule>;

export type ConfigRuleId = keyof typeof CONFIG_RULES;

export interface ConfigFile {
  /** Only a label for the reports (and, by its last segment, how `.claude.json` is told from the project files). Never opened. */
  path: string;
  client: ClientId;
  text: string;
}

export interface ConfigOptions {
  /** Hosts a server address may name (`--allow-host`). Without any, `scan/cfg/foreign-host` is not evaluated. */
  allowHosts?: readonly string[];
  /** Package names a launcher may start (`--allow-package`). Without any, `scan/cfg/package-not-allowed` is not evaluated. */
  allowPackages?: readonly string[];
  /** The snapshot of a server by its label in the file. With fewer than two, the `scan/cross/*` rules are not evaluated. */
  snapshots?: ReadonlyMap<string, McpSnapshot>;
  /** At most this many findings (and servers) are produced, then `truncated`. Default 5000. */
  maxFindings?: number;
}

export interface ConfigFinding {
  rule: ConfigRuleId;
  class: ScanClass;
  level: ScanLevel;
  /** Whether it may change the exit code now: only a `gating: yes` rule. A heuristic is always false. */
  gating: boolean;
  /** Where the finding comes from: the field of a configuration file, or a text of a server's snapshot. */
  origin: 'config' | 'snapshot';
  file?: string;
  server: string;
  /** For `config`, the path of the field; for `snapshot`, the JSON Pointer of the text in that server's snapshot. */
  path: string;
  /** 1-based, as an editor counts; of the value of the field, or (a cross rule) of the server's entry. */
  line?: number;
  column?: number;
  message: string;
  fix: string;
  /** The catalog's fields of a finding about a value: the name of the key it is under (masked like any name). */
  key?: string;
  /** `secret-known-format`: the id of the format. */
  format?: string;
  /** `secret-known-format` in `args`: the index, and the flag before it when that looks like one. */
  argIndex?: number;
  previousArg?: string;
  /** `secret-in-url`: `userinfo`, or the name of the query parameter. */
  urlPart?: string;
}

export type FileProblem =
  | { kind: 'parse-error'; category: ParseErrorCategory; line: number; column: number }
  | { kind: 'too-large' }
  | { kind: 'unknown-client' }
  | { kind: 'bad-input' }
  | { kind: 'internal-error' }
  | { kind: 'not-an-object'; path: string }
  | { kind: 'duplicate-key'; path: string; line: number; column: number };

export interface ServerRef {
  label: string;
  path: string;
  line: number;
  column: number;
  /** False for an entry the rules could not read (`scan/cfg/invalid-entry`): not assessed, which is not clean. */
  assessed: boolean;
}

export interface FileResult {
  path: string;
  client: string;
  /** `nothing-to-scan`: no server entry at all; `unreadable`: the file could not be read as this client's JSON. Neither is clean. */
  status: 'scanned' | 'nothing-to-scan' | 'unreadable';
  servers: ServerRef[];
  problems: FileProblem[];
}

/** A rule, or one field for a rule, that was not checked, and why; the reason is fixed text, never a value. */
export interface NotEvaluated {
  rule: ConfigRuleId;
  reason: string;
  file?: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface ConfigScan {
  status: 'scanned' | 'nothing-to-scan';
  files: FileResult[];
  /** Rules that did not run, and why: a report says "not evaluated" for them, never "clean". */
  notEvaluated: NotEvaluated[];
  /** The cap on findings was reached; there may be more. */
  truncated: boolean;
  findings: ConfigFinding[];
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** What a regular expression reads of one value: a hostile megabyte-long argument is not matched to its end. */
const MAX_VALUE = 64 * 1024;
/** What every rule but the token formats reads of one argument or command: a flag, a package, a path is never longer. */
const MAX_TOKEN = 4096;
const DEFAULT_MAX_FINDINGS = 5000;
const SHOWN_NAME = 64;
const CLIENTS: ReadonlySet<string> = new Set<ClientId>([
  'claude-code',
  'cursor',
  'vscode',
  'claude-desktop',
]);
// ponytail: the `type` values by what the client documentation shows; MCP-G7 reads real files, a missing one shows as a false invalid-entry.
const TYPES: ReadonlySet<string> = new Set(['stdio', 'http', 'sse', 'streamable-http']);

// ---- text from the file, made safe to print ------------------------------------------------------------------------

/**
 * Formats of a token that is a secret on its own, by the prefix its provider documents. A closed list; a token of
 * another shape is for `secret-by-name` to suspect. ponytail: lengths and prefixes from the providers' public
 * descriptions, not re-checked against each provider's current documentation; MCP-G7 measures false hits.
 */
const KNOWN_FORMATS: readonly [id: string, re: RegExp][] = [
  ['github-token', /(?<![A-Za-z0-9])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{36,}/],
  ['aws-access-key-id', /(?<![A-Za-z0-9])(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z2-7]{16}(?![A-Za-z0-9])/],
  ['slack-token', /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-key', /(?<![A-Za-z0-9])[rs]k_live_[A-Za-z0-9]{16,}/],
  ['anthropic-key', /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ['google-api-key', /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/],
  ['npm-token', /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/],
  ['gitlab-token', /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20}/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];
const knownFormat = (value: string): string | undefined => {
  const head = value.length > MAX_VALUE ? value.slice(0, MAX_VALUE) : value;
  return KNOWN_FORMATS.find(([, re]) => re.test(head))?.[0];
};

/** A name that starts with the prefix of a token, even one too short for the whole format, or holds a whole token. */
const KEY_PREFIX =
  /^\s*(?:gh[pousr]_|github_pat_|AKIA|ASIA|AGPA|AIDA|AROA|xox[abprs]-|[rs]k_live_|sk-ant-|AIza|npm_|glpat-|-----BEGIN )/;
const tokenish = (name: string): boolean => {
  const head = name.slice(0, 256);
  return KEY_PREFIX.test(head) || knownFormat(head) !== undefined;
};

/** A name from the file as it may be printed: not a token, escaped, bounded, and not a workflow command. */
const safe = (name: string): string =>
  noCommands(visible(tokenish(name) ? '[key]' : name, SHOWN_NAME));
const safeText = (text: string): string => noCommands(visible(text, 400));
/** A JSON Pointer of a snapshot text: each segment through the same mask as a name. */
const safePointer = (pointer: string): string =>
  noCommands(
    pointer
      .split('/')
      .map((seg) => (tokenish(seg) ? '[key]' : seg))
      .join('/'),
  );

type Part = string | number;
/** `mcpServers.github.env.GITHUB_TOKEN`, `mcpServers["a.b"].url`, `args[1]`. */
function pathOf(parts: readonly Part[]): string {
  return parts
    .map((p, i) => {
      if (typeof p === 'number') return `[${p}]`;
      const name = safe(p);
      if (/^[A-Za-z_][\w-]*$/.test(name)) return i === 0 ? name : `.${name}`;
      return `[${JSON.stringify(name)}]`;
    })
    .join('');
}

// ---- reading values ------------------------------------------------------------------------------------------------

const isObject = (n: JsonNode | undefined): n is Extract<JsonNode, { t: 'object' }> =>
  n?.t === 'object';
const isString = (n: JsonNode | undefined): n is Extract<JsonNode, { t: 'string' }> =>
  n?.t === 'string';

/** The members of an object by key, the last of a repeated key winning (as in the client); the repeats go to `onRepeat`. */
function unique(members: readonly JsonMember[], onRepeat?: (m: JsonMember) => void): JsonMember[] {
  const byKey = new Map<string, JsonMember>();
  for (const m of members) {
    if (byKey.has(m.key)) onRepeat?.(m);
    byKey.set(m.key, m);
  }
  return [...byKey.values()];
}
const member = (obj: Extract<JsonNode, { t: 'object' }>, key: string): JsonMember | undefined => {
  for (let i = obj.members.length - 1; i >= 0; i--)
    if (obj.members[i]!.key === key) return obj.members[i];
  return undefined;
};

/** A reference to a variable: `${VAR}`, `${env:VAR}`, `${input:id}`, or an expansion with an empty default. */
const REF = /\$\{(?:env:|input:)?[A-Za-z_][\w.-]*(?::-)?\}/g;
const SCHEME_WORD = /^(?:bearer|basic|token)$/i;
/** Something is written there that is not a reference: a literal, or a non-empty default in an expansion. */
const isLiteral = (value: string): boolean => {
  const rest = value.replace(REF, '').trim();
  return rest !== '' && !SCHEME_WORD.test(rest);
};
const CREDENTIAL_NAME =
  /token|secret|passw(?:or)?d|api[_-]?key|authorization|credential|private[_-]?key/i;
const URL_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'key',
  'secret',
  'password',
  'api_key',
  'apikey',
  'access_token',
]);

interface Address {
  scheme: string;
  userinfo: string | undefined;
  host: string;
  query: string | undefined;
}
function addressOf(raw: string): Address | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/.exec(raw.slice(0, MAX_VALUE));
  if (!m) return undefined;
  const authority = m[2]!;
  const at = authority.lastIndexOf('@');
  const hostPort = authority.slice(at + 1);
  const host = hostPort.startsWith('[')
    ? hostPort.slice(1, hostPort.indexOf(']') === -1 ? undefined : hostPort.indexOf(']'))
    : hostPort.replace(/:\d*$/, '');
  const rest = m[3]!;
  const q = rest.indexOf('?');
  return {
    scheme: m[1]!.toLowerCase(),
    userinfo: at === -1 ? undefined : authority.slice(0, at),
    host: host.toLowerCase().replace(/\.$/, ''),
    query: q === -1 ? undefined : rest.slice(q + 1),
  };
}
function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && [m[1], m[2], m[3]].every((o) => Number(o) <= 255);
}

const programOf = (command: string): string =>
  (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh']);
/** `-c`, `-lc`, `/c`, `-Command`: linear, and a flag is never long. */
const isScriptFlag = (s: string): boolean =>
  s.length <= 40 &&
  ((/^-[a-z]+$/.test(s) && s.includes('c')) ||
    /^\/[ck]$/i.test(s) ||
    /^-(?:command|c|encodedcommand|ec)$/i.test(s));
const OPERATORS = /&&|\|\||\$\(|`|(?:^|\s)[;|](?:\s|$)|;\s/;
const DOWNLOADER = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i;
const SHELL_AFTER = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k)?sh|iex|invoke-expression)\b/i;
const DOWNLOAD_NESTED = [/\b(?:ba|z|da)?sh\s+<\(\s*(?:curl|wget)\b/i, /\$\(\s*(?:curl|wget)\b/i];
/**
 * Where a download is piped into a shell or `iex`, as an offset in `text`: a segment with a downloader, a single `|`,
 * a segment that starts with a shell. The text is cut at `|`, `||`, `&&`, `;`, `&` and line ends first, so every
 * pattern runs over one segment and the whole is linear (a pattern that reaches from `curl` to `|` backtracks to
 * every `curl`). The caller bounds `text`.
 */
function downloadToShell(text: string): number | undefined {
  let start = 0;
  let prev: { from: number; segment: string } | undefined;
  const cuts = /\|\||&&|[|;&\n]/g;
  const hit = (segment: string): number | undefined => {
    if (prev !== undefined && SHELL_AFTER.test(segment)) {
      const d = DOWNLOADER.exec(prev.segment);
      if (d) return prev.from + d.index;
    }
    return undefined;
  };
  for (let m = cuts.exec(text); ; m = cuts.exec(text)) {
    const end = m ? m.index : text.length;
    const segment = text.slice(start, end);
    const found = hit(segment);
    if (found !== undefined) return found;
    prev = m && m[0] === '|' ? { from: start, segment } : undefined;
    if (!m) break;
    start = end + m[0].length;
  }
  const nested = DOWNLOAD_NESTED.map((re) => re.exec(text)?.index).filter(
    (i): i is number => i !== undefined,
  );
  return nested.length === 0 ? undefined : Math.min(...nested);
}
const BROAD_ROOT =
  /^(?:\/|~\/?|\$HOME[\\/]?|\$\{(?:env:)?HOME\}[\\/]?|%USERPROFILE%[\\/]?|[A-Za-z]:[\\/]?|\/(?:Users|home)\/[^/\\]+\/?|[A-Za-z]:[\\/]Users[\\/][^/\\]+[\\/]?)$/;

type Kind = 'npm' | 'uv';
interface Token {
  text: string;
  /** Index in the entry's `args`. */
  index: number;
}
interface Launch {
  kind: Kind;
  flags: Token[];
  /** The package, as written, and where. */
  pkg: Token | undefined;
}
const VALUE_FLAGS: Record<Kind, ReadonlySet<string>> = {
  npm: new Set(['-c', '--call', '--registry', '--cache', '--userconfig', '--node-options']),
  uv: new Set([
    '--with',
    '--python',
    '-p',
    '--index',
    '--index-url',
    '--with-requirements',
    '--env-file',
    '--directory',
  ]),
};
const PACKAGE_FLAGS: Record<Kind, ReadonlySet<string>> = {
  npm: new Set(['-p', '--package']),
  uv: new Set(['--from']),
};

/** The launcher an entry uses, looking through `cmd /c`, and the package it starts. */
function launchOf(command: string, args: Token[]): Launch | undefined {
  let name = programOf(command);
  let tokens = args;
  if (name === 'cmd' && tokens[0] !== undefined && /^\/[ck]$/i.test(tokens[0].text)) {
    name = programOf(tokens[1]?.text ?? '');
    tokens = tokens.slice(2);
  }
  let kind: Kind;
  if (name === 'npx' || name === 'bunx') kind = 'npm';
  else if (name === 'uvx') kind = 'uv';
  else if ((name === 'pnpm' || name === 'yarn') && tokens[0]?.text === 'dlx') {
    kind = 'npm';
    tokens = tokens.slice(1);
  } else return undefined;
  const launch: Launch = { kind, flags: [], pkg: undefined };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const eq = t.text.indexOf('=');
    const flag = eq === -1 ? t.text : t.text.slice(0, eq);
    if (PACKAGE_FLAGS[kind].has(flag)) {
      const text = eq === -1 ? tokens[i + 1]?.text : t.text.slice(eq + 1);
      if (text !== undefined)
        launch.pkg = { text, index: eq === -1 ? tokens[i + 1]!.index : t.index };
      return launch;
    }
    if (t.text.startsWith('-')) {
      launch.flags.push(t);
      if (eq === -1 && VALUE_FLAGS[kind].has(t.text)) i++;
    } else {
      launch.pkg = t;
      return launch;
    }
  }
  return launch;
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** `undefined`: not a registry package (a path or a git address), so no judgement. */
function pinnedOf(spec: string, kind: Kind): { name: string; pinned: boolean } | undefined {
  if (
    /^(?:\.|\/|~|file:|git\+|github:|gitlab:|https?:|[A-Za-z]:[\\/])/.test(spec) ||
    spec.includes('://')
  )
    return undefined;
  if (kind === 'npm') {
    const at = spec.indexOf('@', 1);
    return at === -1
      ? { name: spec, pinned: false }
      : { name: spec.slice(0, at), pinned: EXACT_SEMVER.test(spec.slice(at + 1)) };
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?([\s\S]*)$/.exec(spec);
  const name = m?.[1] ?? spec;
  const rest = (m?.[2] ?? '').trim();
  return {
    name,
    pinned:
      /^===?\s*[0-9][^*,<>~!=\s]*$/.test(rest) ||
      (/^@\s*[0-9][^*\s]*$/.test(rest) && rest !== '@latest'),
  };
}

// ---- the scan --------------------------------------------------------------------------------------------------------

interface Run {
  cap: number;
  allowHosts: ReadonlySet<string> | undefined;
  allowPackages: ReadonlySet<string> | undefined;
  findings: ConfigFinding[];
  notChecked: NotEvaluated[];
  truncated: boolean;
}
interface FileCtx {
  run: Run;
  file: string;
  locate: (at: number) => { line: number; column: number };
}
const full = (run: Run): boolean => run.findings.length >= run.cap;

function emit(
  fc: FileCtx,
  rule: ConfigRuleId,
  server: string,
  parts: readonly Part[],
  at: number,
  message: string,
  level?: ScanLevel,
  extra?: Partial<ConfigFinding>,
): void {
  if (full(fc.run)) {
    fc.run.truncated = true;
    return;
  }
  const def: ScanRule = CONFIG_RULES[rule];
  fc.run.findings.push({
    rule,
    class: def.class,
    level: level ?? def.level,
    gating: def.gating === 'yes',
    origin: 'config',
    file: safeText(fc.file),
    server,
    path: pathOf(parts),
    ...fc.locate(at),
    message: def.class === 'heuristic' ? `${message} (advice)` : message,
    fix: def.fix,
    ...extra,
  });
}

/** A field whose value is too long for the token formats to read to its end: listed, never clean. */
function notChecked(fc: FileCtx, parts: readonly Part[], at: number): void {
  if (fc.run.notChecked.length >= fc.run.cap) {
    fc.run.truncated = true;
    return;
  }
  fc.run.notChecked.push({
    rule: 'scan/cfg/secret-known-format',
    reason: 'value too long to check',
    file: safeText(fc.file),
    path: pathOf(parts),
    ...fc.locate(at),
  });
}

/** The flag before the argument at `index`, when it looks like one (`--auth-token`); the catalog shows it, nothing else of the neighbours. */
function flagBefore(nodes: readonly JsonNode[], index: number): string | undefined {
  const prev = nodes[index - 1];
  return isString(prev) && /^--?[a-z0-9-]{1,40}$/.test(prev.value) && !tokenish(prev.value)
    ? prev.value
    : undefined;
}

/** `scan/cfg/secret-known-format` over one value; the finding holds the id of the format, never the value. */
function knownIn(
  fc: FileCtx,
  server: string,
  parts: readonly Part[],
  at: number,
  text: string,
  where: { key?: string; argIndex?: number; previousArg?: string } = {},
): void {
  if (text.length > MAX_VALUE) notChecked(fc, parts, at);
  const format = knownFormat(text);
  if (format === undefined) return;
  const name =
    where.key !== undefined && /^[A-Za-z_]\w*$/.test(where.key) && !tokenish(where.key)
      ? where.key
      : 'NAME';
  emit(
    fc,
    'scan/cfg/secret-known-format',
    server,
    parts,
    at,
    `a literal value in the format of a known token (${format}); use \${${name}}`,
    undefined,
    {
      format,
      ...(where.key === undefined ? {} : { key: safe(where.key) }),
      ...(where.argIndex === undefined ? {} : { argIndex: where.argIndex }),
      ...(where.previousArg === undefined ? {} : { previousArg: where.previousArg }),
    },
  );
}

/** An entry of a server list: the rules over its fields. Returns whether it could be assessed. */
function scanEntry(
  fc: FileCtx,
  base: readonly Part[],
  label: string,
  labelAt: number,
  node: JsonNode,
): boolean {
  const parts = [...base, label];
  const server = safe(label);
  const invalid = (at: number, parts2: readonly Part[], why: string) =>
    emit(fc, 'scan/cfg/invalid-entry', server, parts2, at, `${why}; not assessed`);
  if (!isObject(node)) {
    invalid(labelAt, parts, 'the entry is not an object');
    return false;
  }
  const field = (name: string) => member(node, name);
  const type = field('type');
  if (type !== undefined && !(isString(type.value) && TYPES.has(type.value.value))) {
    invalid(labelAt, parts, 'the entry has a type this scan does not know');
    return false;
  }
  const command = field('command');
  const url = field('url');
  const commandText =
    isString(command?.value) && command.value.value !== '' ? command.value.value : undefined;
  const urlText = isString(url?.value) && url.value.value !== '' ? url.value.value : undefined;
  if (commandText === undefined && urlText === undefined) {
    invalid(labelAt, parts, 'neither command nor url');
    return false;
  }
  const wrongType = (name: string, m: JsonMember | undefined, ok: boolean) => {
    if (m !== undefined && !ok)
      invalid(m.keyAt, [...parts, name], `the field "${name}" has the wrong kind of value`);
  };
  const args = field('args');
  wrongType('command', command, command === undefined || isString(command.value));
  wrongType('url', url, url === undefined || isString(url.value));
  wrongType('args', args, args === undefined || args.value.t === 'array');
  for (const name of ['env', 'headers'])
    wrongType(name, field(name), field(name) === undefined || isObject(field(name)!.value));

  const envFile = field('envFile');
  if (isString(envFile?.value) && envFile.value.value !== '') {
    emit(
      fc,
      'scan/cfg/env-file-not-read',
      server,
      [...parts, 'envFile'],
      envFile.value.at,
      'envFile: not read; secrets in it were not checked',
    );
  }

  for (const section of ['env', 'headers'] as const) {
    const m = field(section);
    if (!isObject(m?.value)) continue;
    for (const entry of unique(m.value.members)) {
      if (!isString(entry.value)) continue;
      const at = [...parts, section, entry.key];
      const value = entry.value.value;
      knownIn(fc, server, at, entry.value.at, value, { key: entry.key });
      if (CREDENTIAL_NAME.test(entry.key.slice(0, 1024)) && isLiteral(value.slice(0, MAX_VALUE)))
        emit(
          fc,
          'scan/cfg/secret-by-name',
          server,
          at,
          entry.value.at,
          'literal value under a credential name',
          undefined,
          { key: safe(entry.key) },
        );
    }
  }

  if (urlText !== undefined && isString(url?.value))
    scanUrl(fc, server, [...parts, 'url'], url.value.at, urlText);
  if (commandText !== undefined || args?.value.t === 'array') {
    const nodes = args?.value.t === 'array' ? args.value.items : [];
    const tokens: Token[] = [];
    nodes.forEach((n, index) => {
      if (isString(n))
        tokens.push({
          text: n.value.length > MAX_TOKEN ? n.value.slice(0, MAX_TOKEN) : n.value,
          index,
        });
    });
    scanCommand(fc, server, parts, command, commandText ?? '', tokens, nodes);
  }
  return true;
}

function scanUrl(
  fc: FileCtx,
  server: string,
  parts: readonly Part[],
  at: number,
  raw: string,
): void {
  knownIn(fc, server, parts, at, raw);
  const address = addressOf(raw);
  if (address === undefined) return;
  if (
    address.userinfo !== undefined &&
    isLiteral(address.userinfo.replace(REF, '').replace(/:/g, '') === '' ? '' : address.userinfo)
  ) {
    emit(
      fc,
      'scan/cfg/secret-in-url',
      server,
      parts,
      at,
      'credentials in the userinfo part of the address',
      undefined,
      { urlPart: 'userinfo' },
    );
  }
  for (const pair of (address.query ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    let name = pair.slice(0, eq);
    try {
      name = decodeURIComponent(name);
    } catch {
      /* keep the raw name */
    }
    const key = name.toLowerCase().replace(/-/g, '_');
    if (URL_PARAMS.has(key) && isLiteral(pair.slice(eq + 1)))
      emit(
        fc,
        'scan/cfg/secret-in-url',
        server,
        parts,
        at,
        `query parameter "${key}" holds a literal value`,
        undefined,
        { urlPart: key },
      );
  }
  const judged = !address.host.includes('${') && address.host !== '';
  if (address.scheme === 'http' && judged && !isLoopback(address.host))
    emit(fc, 'scan/cfg/http-plaintext', server, parts, at, 'plain http to a non-loopback host');
  if (fc.run.allowHosts !== undefined && judged && !fc.run.allowHosts.has(address.host)) {
    emit(
      fc,
      'scan/cfg/foreign-host',
      server,
      parts,
      at,
      `host "${safe(address.host)}" is not in --allow-host`,
    );
  }
}

function scanCommand(
  fc: FileCtx,
  server: string,
  parts: readonly Part[],
  command: JsonMember | undefined,
  fullCommand: string,
  tokens: Token[],
  nodes: JsonNode[],
): void {
  const argPath = (t: Token): Part[] => [...parts, 'args', t.index];
  const argAt = (t: Token): number => nodes[t.index]!.at;
  const commandAt = command?.value.at ?? 0;
  if (fullCommand !== '') knownIn(fc, server, [...parts, 'command'], commandAt, fullCommand);
  for (const t of tokens) {
    const n = nodes[t.index];
    const previousArg = flagBefore(nodes, t.index);
    knownIn(fc, server, argPath(t), argAt(t), isString(n) ? n.value : t.text, {
      argIndex: t.index,
      ...(previousArg === undefined ? {} : { previousArg }),
    });
  }

  // From here on every rule reads a clipped text: a flag, a package or a path is never as long as a megabyte.
  const commandText = fullCommand.slice(0, MAX_TOKEN);
  const program = programOf(commandText);
  const scriptFlag = SHELLS.has(program) ? tokens.find((t) => isScriptFlag(t.text)) : undefined;
  if (scriptFlag !== undefined) {
    emit(
      fc,
      'scan/cfg/shell-command',
      server,
      [...parts, 'command'],
      commandAt,
      `runs "${program} ${scriptFlag.text}" with an inline script`,
    );
  } else {
    const op = tokens.find((t) => OPERATORS.test(t.text));
    if (op !== undefined)
      emit(
        fc,
        'scan/cfg/shell-command',
        server,
        argPath(op),
        argAt(op),
        'an argument holds a shell operator or a command substitution',
      );
  }

  // One text of the command and its arguments, to read a download that spans several of them; a match is put on the argument it starts in.
  const spans: { start: number; token: Token | undefined }[] = [{ start: 0, token: undefined }];
  let joined = commandText;
  for (const t of tokens) {
    if (joined.length >= MAX_VALUE) break;
    spans.push({ start: joined.length + 1, token: t });
    joined += ` ${t.text}`;
  }
  const download = downloadToShell(joined);
  if (download !== undefined) {
    const span = [...spans].reverse().find((s) => s.start <= download)!;
    if (span.token === undefined)
      emit(
        fc,
        'scan/cfg/download-to-shell',
        server,
        [...parts, 'command'],
        commandAt,
        'downloads and pipes into a shell',
      );
    else
      emit(
        fc,
        'scan/cfg/download-to-shell',
        server,
        argPath(span.token),
        argAt(span.token),
        'downloads and pipes into a shell',
      );
  }

  const launch = launchOf(commandText, tokens);
  let unpinned = false;
  if (launch?.pkg !== undefined) {
    const spec = pinnedOf(launch.pkg.text, launch.kind);
    unpinned = spec !== undefined && !spec.pinned;
    if (spec !== undefined && !spec.pinned)
      emit(
        fc,
        'scan/cfg/unpinned-package',
        server,
        argPath(launch.pkg),
        argAt(launch.pkg),
        'package without an exact version',
      );
    if (fc.run.allowPackages !== undefined) {
      const written = spec?.name ?? launch.pkg.text;
      const name = written.toLowerCase();
      const squeezed = name.replace(/[-_.]+/g, '-');
      if (
        !fc.run.allowPackages.has(name) &&
        !(launch.kind === 'uv' && fc.run.allowPackages.has(squeezed))
      ) {
        emit(
          fc,
          'scan/cfg/package-not-allowed',
          server,
          argPath(launch.pkg),
          argAt(launch.pkg),
          `package "${safe(written)}" is not in --allow-package`,
        );
      }
    }
  }
  const yes = launch?.flags.find((t) => t.text === '-y' || t.text === '--yes');
  if (yes !== undefined) {
    emit(
      fc,
      'scan/cfg/auto-confirm',
      server,
      argPath(yes),
      argAt(yes),
      unpinned || launch?.pkg === undefined
        ? 'installs without asking, and the package is not pinned'
        : 'installs without asking; the package is pinned',
      unpinned || launch?.pkg === undefined ? 'warn' : 'info',
    );
  }

  const everything = [commandText, ...tokens.map((t) => t.text)];
  if (everything.some((s) => !BROAD_ROOT.test(s) && /filesystem/i.test(s))) {
    for (const t of tokens) {
      if (BROAD_ROOT.test(t.text))
        emit(
          fc,
          'scan/cfg/broad-filesystem-root',
          server,
          argPath(t),
          argAt(t),
          `${/^(?:\/|[A-Za-z]:[\\/]?)$/.test(t.text) ? 'the root of a drive' : 'the home directory'} as the root`,
        );
    }
  }
}

/** The server lists of a file: where they are and what they are called in the path. */
function containers(
  fc: FileCtx,
  file: ConfigFile,
  root: Extract<JsonNode, { t: 'object' }>,
): { base: Part[]; list: JsonNode }[] {
  const out: { base: Part[]; list: JsonNode }[] = [];
  const userFile = file.client === 'claude-code' && /(?:^|[\\/])\.claude\.json$/i.test(file.path);
  const expected = file.client === 'vscode' ? 'servers' : 'mcpServers';
  const other = expected === 'servers' ? 'mcpServers' : 'servers';
  const top = member(root, expected);
  if (top !== undefined) out.push({ base: [expected], list: top.value });
  else if (!userFile) {
    const wrong = member(root, other);
    if (wrong !== undefined)
      emit(
        fc,
        'scan/cfg/invalid-entry',
        '',
        [other],
        wrong.keyAt,
        `"${other}" is not the server list this client reads (it reads "${expected}"); not assessed`,
      );
  }
  // `~/.claude.json` holds much else; only these two branches are read.
  const projects = userFile ? member(root, 'projects') : undefined;
  if (isObject(projects?.value)) {
    for (const project of unique(projects.value.members)) {
      const list = isObject(project.value) ? member(project.value, 'mcpServers') : undefined;
      if (list !== undefined)
        out.push({ base: ['projects', project.key, 'mcpServers'], list: list.value });
    }
  }
  return out;
}

function scanFile(run: Run, file: ConfigFile): FileResult {
  const result: FileResult = {
    path: typeof file?.path === 'string' ? safeText(file.path) : '(unnamed)',
    client: typeof file?.client === 'string' ? file.client : '(unknown)',
    status: 'nothing-to-scan',
    servers: [],
    problems: [],
  };
  const unreadable = (problem: FileProblem): FileResult => ({
    ...result,
    status: 'unreadable',
    problems: [problem],
  });
  if (
    typeof file !== 'object' ||
    file === null ||
    typeof file.text !== 'string' ||
    typeof file.path !== 'string'
  )
    return unreadable({ kind: 'bad-input' });
  if (!CLIENTS.has(file.client)) return unreadable({ kind: 'unknown-client' });
  if (Buffer.byteLength(file.text, 'utf8') > MAX_FILE_BYTES)
    return unreadable({ kind: 'too-large' });
  const locate = lineLocator(file.text);
  const parsed = parseJson(file.text, { comments: file.client === 'vscode' });
  if (!parsed.ok)
    return unreadable({ kind: 'parse-error', category: parsed.category, ...locate(parsed.at) });
  if (parsed.root === undefined) return result;
  if (!isObject(parsed.root))
    return { ...result, problems: [{ kind: 'not-an-object', path: '$' }] };
  const fc: FileCtx = { run, file: file.path, locate };
  for (const { base, list } of containers(fc, file, parsed.root)) {
    if (!isObject(list)) {
      emit(
        fc,
        'scan/cfg/invalid-entry',
        '',
        base,
        list.at,
        'the server list is not an object; not assessed',
      );
      continue;
    }
    for (const entry of unique(list.members, (m) =>
      result.problems.push({
        kind: 'duplicate-key',
        path: pathOf([...base, m.key]),
        ...locate(m.keyAt),
      }),
    )) {
      if (result.servers.length >= run.cap || full(run)) {
        run.truncated = true;
        break;
      }
      const assessed = scanEntry(fc, base, entry.key, entry.keyAt, entry.value);
      result.servers.push({
        label: safe(entry.key),
        path: pathOf([...base, entry.key]),
        ...locate(entry.keyAt),
        assessed,
      });
    }
  }
  if (result.servers.length > 0) result.status = 'scanned';
  return result;
}

/** `scanFile` that cannot throw: what a crooked input trips over is a status of the file, not an exception. */
function scanFileSafely(run: Run, file: ConfigFile): FileResult {
  const before = { findings: run.findings.length, notChecked: run.notChecked.length };
  try {
    return scanFile(run, file);
  } catch {
    run.findings.length = before.findings;
    run.notChecked.length = before.notChecked;
    return {
      path: typeof file?.path === 'string' ? safeText(file.path) : '(unnamed)',
      client: typeof file?.client === 'string' ? file.client : '(unknown)',
      status: 'unreadable',
      servers: [],
      problems: [{ kind: 'internal-error' }],
    };
  }
}

/** A snapshot the cross rules can read: an object whose tools, when it has any, are objects with a string name. */
function readable(snapshot: unknown): snapshot is McpSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const tools = (snapshot as { tools?: unknown }).tools;
  if (tools === undefined || tools === null) return true;
  return (
    Array.isArray(tools) &&
    tools.every(
      (t) =>
        typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string',
    )
  );
}

/** The `scan/cross/*` rules over the snapshots of the servers of the file, by their labels. */
function scanCross(
  run: Run,
  snapshots: ReadonlyMap<string, McpSnapshot>,
  files: FileResult[],
): void {
  const where = (label: string) => {
    for (const f of files)
      for (const s of f.servers)
        if (s.label === safe(label)) return { file: f.path, line: s.line, column: s.column };
    return undefined;
  };
  const add = (rule: ConfigRuleId, label: string, path: string, message: string) => {
    if (full(run)) {
      run.truncated = true;
      return;
    }
    const def: ScanRule = CONFIG_RULES[rule];
    run.findings.push({
      rule,
      class: def.class,
      level: def.level,
      gating: def.gating === 'yes',
      origin: 'snapshot',
      ...where(label),
      server: safe(label),
      path: safePointer(path),
      message,
      fix: def.fix,
    });
  };
  const tools = new Map<string, Map<string, number>>();
  for (const [label, snapshot] of snapshots)
    tools.set(label, new Map((snapshot.tools ?? []).map((t, i) => [t.name, i] as const).reverse()));

  const owners = new Map<string, string[]>();
  for (const [label, names] of tools)
    for (const name of names.keys()) owners.set(name, [...(owners.get(name) ?? []), label]);
  for (const [name, labels] of owners) {
    if (labels.length < 2) continue;
    const first = labels[0]!;
    const rest = labels.slice(1, 3).map((l) => `"${safe(l)}"`);
    const more = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
    add(
      'scan/cross/duplicate-tool-name',
      first,
      `/tools/${tools.get(first)!.get(name)!}/name`,
      `"${safe(name)}" is listed by servers "${safe(first)}" and ${rest.join(', ')}${more}; a client must tell them apart`,
    );
  }

  for (const [label, snapshot] of snapshots) {
    const own = tools.get(label)!;
    const foreign = new Map<string, string>();
    for (const [other, names] of tools)
      if (other !== label)
        for (const name of names.keys())
          if (!own.has(name) && !foreign.has(name)) foreign.set(name, other);
    if (foreign.size === 0) continue;
    const names = [...foreign.keys()];
    for (const text of descriptionTexts(snapshot)) {
      if (text.key || /^\/tools\/\d+\/name$/.test(text.pointer)) continue;
      const seen = new Set<string>();
      for (const hit of findToolNames(text.text.slice(0, 1024 * 1024), names)) {
        if (seen.has(hit.name)) continue;
        seen.add(hit.name);
        add(
          'scan/cross/foreign-tool-reference',
          label,
          text.pointer,
          `the text names "${safe(hit.name)}" of server "${safe(foreign.get(hit.name)!)}"`,
        );
      }
    }
  }
}

/**
 * Scan the configuration files of MCP clients with the `scan/cfg/*` rules and, given the snapshots of at least two of
 * their servers, the `scan/cross/*` rules. A file that holds no server, or cannot be read, is not clean: its status says
 * so. A rule that needs a list or snapshots the caller did not give, or gave in a form that cannot be read, is in
 * `notEvaluated`, and so is a value too long to check. Input of the wrong kind at any of the boundaries is a status
 * or a `notEvaluated` row with fixed text, and the scan of a file or of the snapshots is guarded; nothing in it throws.
 */
export function scanClientConfig(
  files: readonly ConfigFile[],
  options: ConfigOptions = {},
): ConfigScan {
  const opts: ConfigOptions = typeof options === 'object' && options !== null ? options : {};
  /** The strings of a list, trimmed and lower-cased; `undefined` for no list, a list that is not one, or one with no string. */
  const set = (list: unknown): ReadonlySet<string> | undefined => {
    if (!Array.isArray(list)) return undefined;
    const strings = list.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
    return strings.length === 0 ? undefined : new Set(strings.map((s) => s.trim().toLowerCase()));
  };
  const cap = opts.maxFindings;
  const run: Run = {
    cap:
      typeof cap === 'number' && Number.isFinite(cap) && cap >= 1
        ? Math.floor(cap)
        : DEFAULT_MAX_FINDINGS,
    allowHosts: set(opts.allowHosts),
    allowPackages: set(opts.allowPackages),
    findings: [],
    notChecked: [],
    truncated: false,
  };
  const results = (Array.isArray(files) ? files : []).map((f) => scanFileSafely(run, f));
  const notEvaluated: NotEvaluated[] = [];
  const snapshots = opts.snapshots;
  const crossReason = (reason: string) =>
    notEvaluated.push(
      { rule: 'scan/cross/duplicate-tool-name', reason },
      { rule: 'scan/cross/foreign-tool-reference', reason },
    );
  if (!(snapshots instanceof Map) || snapshots.size < 2)
    crossReason('needs the snapshots of at least two servers of the file (--snapshot)');
  else if (
    ![...snapshots.entries()].every(([label, s]) => typeof label === 'string' && readable(s))
  )
    crossReason('the snapshots could not be read');
  else {
    const before = run.findings.length;
    try {
      scanCross(run, snapshots, results);
    } catch {
      run.findings.length = before;
      crossReason('the snapshots could not be read');
    }
  }
  if (run.allowHosts === undefined)
    notEvaluated.push({
      rule: 'scan/cfg/foreign-host',
      reason:
        opts.allowHosts === undefined
          ? 'no list of allowed hosts was given (--allow-host)'
          : 'the list of allowed hosts holds no usable host',
    });
  if (run.allowPackages === undefined)
    notEvaluated.push({
      rule: 'scan/cfg/package-not-allowed',
      reason:
        opts.allowPackages === undefined
          ? 'no list of allowed packages was given (--allow-package)'
          : 'the list of allowed packages holds no usable package',
    });
  notEvaluated.push(
    ...[...run.notChecked].sort((a, b) => a.line! - b.line! || a.column! - b.column!),
  );
  return {
    status: results.some((r) => r.status === 'scanned') ? 'scanned' : 'nothing-to-scan',
    files: results,
    notEvaluated,
    truncated: run.truncated,
    findings: run.findings,
  };
}

/** A finding as one report line; every piece of it is already escaped. */
export function formatConfigFinding(f: ConfigFinding): string {
  const place = f.line === undefined ? '' : ` (line ${f.line}, col ${f.column})`;
  return f.origin === 'snapshot'
    ? `server "${f.server}" ${f.path}: ${f.message}`
    : `${f.path}${place}: ${f.message}`;
}
