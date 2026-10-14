import { createHash, randomUUID } from 'node:crypto';
import { promises as disk } from 'node:fs';
import { basename, extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveApiUrl } from '../cli/api-url.js';
import { loadToken } from '../cli/credentials.js';
import { createClient, type ClientOutcome, type PlatformClient } from './client.js';
import { defaultRunTitle, readEnv } from './env.js';
import { mediaTypeOf, printable, TEXT_TYPES } from './failure-detail.js';
import { appendBatch, DEFAULT_FALLBACK_PATH, type DeferredResult } from './fallback.js';
import type {
  DiscoveredTest,
  DiscoveryOutcome,
  ExpectedEntry,
  FrozenSummary,
  KeyRef,
  PendingResult,
  ReporterConfig,
  ResultFile,
  ResultSubmission,
  RunStats,
  UnofferedWhy,
} from './types.js';

/** The platform's ceiling on one resolve request. */
const RESOLVE_CHUNK = 500;
/** The platform's ceiling on one results batch. */
const BATCH_MAX = 500;
/** The platform's ceiling on one batch of offered tests — the same number, stated separately
 * because it is a different endpoint's promise and they are free to diverge. */
const DISCOVER_MAX = 500;
const BATCH_DEFAULT = 500;
/** What `configuration.expected` may hold before the contract refuses the whole start. */
const EXPECTED_MAX = 10_000;
/** The platform's ceiling on one external key's value, and on the title of a queue entry. */
const KEY_MAX = 1024;
const TITLE_MAX = 300;
/** What a batch's answer counts — the part of `RunStats` a submission adds to. */
const COUNTED = ['accepted', 'duplicate', 'conflict', 'rejected'] as const;

/** One verdict of a batch, as the platform answers it. Only an `accepted` one carries the result's `id`. */
interface BatchItem {
  resultKey?: string;
  status?: string;
  id?: string;
}

/** What a result's file is to the platform: a picture, a text — each with limits of its own — or any other file (a trace, a video), which only a bucket takes. */
type Kind = 'screenshot' | 'text' | 'file';

/**
 * A file on its way: the result it goes to, its kind, the name and type it goes by, and where the bytes
 * are — on this machine at `path`, or in `body` where a test attached them from memory.
 */
interface Upload {
  id: string;
  kind: Kind;
  name: string;
  type: string;
  path?: string;
  body?: Buffer;
}

/**
 * What the platform takes as a result's file, and how many (ADR 0040). Checked before sending rather
 * than left to the platform's refusal: a refused file has already crossed the wire — up to 2 MB, twenty
 * times a result — to learn what was known here. Drift costs no result: at worst a screenshot the
 * platform would now take is skipped, or one it no longer takes is refused and counted.
 */
const SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SCREENSHOT_BYTES = 2 * 1024 * 1024;
const SCREENSHOTS_PER_RESULT = 20;
/**
 * And a text: JSON or plain text, in UTF-8, without a NUL, up to 512 KiB and ten to a result — apart from
 * the twenty pictures (its 2026-09-29 review). The types are `TEXT_TYPES`, one list for both roads.
 */
const TEXT_BYTES = 512 * 1024;
const TEXTS_PER_RESULT = 10;
/** Throws on what UTF-8 does not spell: a lone byte, an overlong form, half a surrogate pair. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/**
 * The type of a picture whose attachment names none — only the ones the platform takes. A text's is never
 * guessed: a `.json` whose attachment names no type is not sent.
 */
const TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
/** The attachment that tells the reporter which test case a test is: read by it, and not a file of the test. */
const METADATA_TYPE = 'application/plune.metadata+json';
/** Uploads in flight at once. One at a time, a suite with a screenshot per test waits on every round trip. */
const UPLOADS_AT_ONCE = 4;
/** The longest name the platform takes for a result's file (ADR 0040) — in UTF-16 units, as it measures. */
const NAME_MAX = 200;

/**
 * The name a person reads on the run page: the attachment's, not its file's. Playwright reports a file
 * attached by path as the copy it saved, `<name>-<sha1>.png`, and the hash tells nobody anything. Read
 * as the platform reads a name — the last segment, trimmed: a name can be a path of this machine,
 * `attach(file, { path: file })` — with the file's extension when the name has no image extension of its
 * own, and within the 200 characters the platform takes, the extension kept.
 */
function nameOf(file: ResultFile): string {
  const own = file.name.split(/[\\/]/).pop()?.trim() || (file.path === undefined ? '' : basename(file.path));
  const fileExt = file.path === undefined ? '' : extname(file.path);
  const ownExt = extname(own);
  // `Step 1. Checkout` has an "extension" by `extname`; only an image's, or the file's own, counts.
  const typed =
    ownExt !== '' &&
    (ownExt.toLowerCase() === fileExt.toLowerCase() || TYPE_BY_EXTENSION[ownExt.toLowerCase()] !== undefined);
  const ext = typed ? ownExt : fileExt;
  let stem = typed ? own.slice(0, -ownExt.length) : own;
  if (stem.length + ext.length > NAME_MAX) {
    stem = stem.slice(0, Math.max(0, NAME_MAX - ext.length));
    if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1); // half a pair would throw in the URL
  }
  return `${stem}${ext}`;
}

/** Why a file stayed behind — said once per reason and kind, every one counted. */
const SKIPPED = {
  hidden: "its name starts with an underscore, which hides an attachment in Playwright's own reports too",
  type: 'Plune takes PNG, JPEG and WebP',
  limit: `a result holds at most ${SCREENSHOTS_PER_RESULT}`,
  missing: 'the file cannot be read on this machine',
  size: 'Plune takes a file of at most 2 MB',
  textLimit: `a result holds at most ${TEXTS_PER_RESULT} text files`,
  textSize: 'Plune takes a text file of at most 512 KiB',
  empty: 'the file is empty',
  binary: 'the file holds a NUL byte, and Plune takes UTF-8 text without one',
  encoding: 'Plune takes UTF-8 text only',
  noStorage: 'no storage bucket is connected to this project',
} as const;

/** Said once per run, when the first link comes back: the project has a bucket, and the files go straight to it. */
const BUCKET_FOUND =
  'plune: storage bucket found for this project — screenshots, text, trace and video go straight to it over short-lived links.';

/** What differs between the two kinds: how they are called, and their limits and the reasons for them. */
const KINDS = {
  screenshot: { label: 'screenshot', bytes: SCREENSHOT_BYTES, room: SCREENSHOTS_PER_RESULT, limit: 'limit', size: 'size' },
  text: { label: 'text file', bytes: TEXT_BYTES, room: TEXTS_PER_RESULT, limit: 'textLimit', size: 'textSize' },
  // Only the label is used: a file of this kind has no home in the database, so no ceiling of its own is known here.
  file: { label: 'file', bytes: 0, room: 0, limit: 'limit', size: 'size' },
} as const;

/** Which kind of upload an attachment is by its type. */
function kindOf(type: string): Kind {
  if (type.startsWith('image/')) return 'screenshot';
  return TEXT_TYPES.has(type) ? 'text' : 'file';
}

/** What a failed call says about itself, without a word of its text: the platform's code, or the status. */
const codeOf = (out: { status: number | null; code?: string }): string =>
  out.code ?? (out.status === null ? 'network' : `http_${out.status}`);

/** A link as `uploads` hands it out — or nothing, when the answer is not one. */
function linkOf(item: unknown): { id: string; url: string; headers: Record<string, string> } | undefined {
  const link = item as { id?: unknown; url?: unknown; headers?: unknown } | null | undefined;
  if (typeof link?.id !== 'string' || typeof link.url !== 'string') return undefined;
  const headers = typeof link.headers === 'object' && link.headers !== null ? (link.headers as Record<string, string>) : {};
  return { id: link.id, url: link.url, headers };
}

/**
 * The type a text goes under: what the attachment names, without its parameters, and a charset only when it
 * is UTF-8. The platform refuses any other charset — and the bytes are checked as UTF-8 before they go, so
 * a wrong label on right bytes costs nothing.
 */
function textTypeOf(contentType: string, type: string): string {
  const charset = /;\s*charset\s*=\s*"?([^\s";]+)"?/i.exec(contentType)?.[1];
  return charset?.toLowerCase() === 'utf-8' ? `${type}; charset=utf-8` : type;
}

/** Why the platform would refuse these bytes as a text — known here, so they need not cross the wire to learn it. */
function textRefusal(bytes: Buffer): keyof typeof SKIPPED | undefined {
  if (bytes.length > TEXT_BYTES) return 'textSize';
  if (bytes.length === 0) return 'empty';
  if (bytes.includes(0)) return 'binary';
  try {
    UTF8.decode(bytes);
  } catch {
    return 'encoding';
  }
  return undefined;
}

/**
 * A result as the fallback file keeps it: its files by their paths, as it always has, and no body. JSON
 * writes a Buffer as one number for every byte, which a replay could not tell from the text it was — and
 * a text attached from memory is uploaded once its result is stored or not at all, like every file.
 */
function onDisk(result: DeferredResult): DeferredResult {
  if (!('files' in result) || result.files === undefined) return result;
  const { files, ...rest } = result;
  const kept = files.filter((f) => f.path !== undefined).map(({ body: _body, ...file }) => file);
  return kept.length === 0 ? rest : { ...rest, files: kept };
}

/** `3 screenshot(s) uploaded, 1 skipped, 1 failed to upload` — or nothing for a kind the run had none of. */
function tally(counts: RunStats['screenshots'], noun: string): string | undefined {
  if (counts.uploaded + counts.skipped + counts.failed === 0) return undefined;
  return (
    `${counts.uploaded} ${noun}(s) uploaded` +
    (counts.skipped > 0 ? `, ${counts.skipped} skipped` : '') +
    (counts.failed > 0 ? `, ${counts.failed} failed to upload` : '')
  );
}

/**
 * A foreign test name is not a key until it fits one.
 *
 * Names come from files this CLI did not write — a JUnit `classname#name`, a runner's title path —
 * and a runner will happily print a 16 384-character parameter into a title. C4 AC-12 leaves lengths
 * to the platform for the run's DESCRIPTION, where a refusal costs the description and nothing
 * else. A key is identity: refused, it takes the whole start with it, and in CI the fallback file
 * that "costs no results" is deleted with the job (1 861 results a run, every run, 12–14.09).
 *
 * So the key is bounded here, once, for every adapter: the head of the name plus a digest of the
 * whole — two long names still get two keys, and the same name gets the same key on every run.
 */
function boundKey(key: KeyRef): KeyRef {
  if (key.value.length <= KEY_MAX) return key;
  const digest = createHash('sha256').update(key.value).digest('hex').slice(0, 16);
  let head = key.value.slice(0, KEY_MAX - digest.length - 1);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1); // never half a surrogate pair
  return { ...key, value: `${head}#${digest}` };
}

/**
 * Why the platform would not take an offer (cli#71). It names the ceiling it met in its own words and in
 * nothing else — both are a 429 (`src/server/db/quota.ts`) — so the words are what tells a full queue
 * from a project at its case limit. An answer that says neither, or says it with another status, is
 * something else: the line printed with the failure carries the platform's reason, whatever it was.
 */
function whyUnoffered(out: ClientOutcome<unknown>): UnofferedWhy {
  if (out.ok || out.status !== 429) return 'other';
  if (/review queue quota reached/i.test(out.detail)) return 'queue';
  if (/test case quota reached/i.test(out.detail)) return 'cases';
  return 'other';
}

/** A title is a label, not an identity — the head is enough for a reviewer to judge the entry. */
function boundTitle(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * A run in progress.
 *
 * `runId: null` is not an error state to check for — it is a run that never reached the platform,
 * and everything below keeps working: results go to the fallback file, `finish` does nothing, and
 * the test run itself is untouched. A reporter that failed a build because a dashboard was down
 * would be worse than no reporter.
 */
export interface RunSession {
  readonly runId: string | null;
  readonly joined: boolean;
  readonly stats: Readonly<RunStats>;
  /** Hand over one result. Sends a batch as soon as enough have accumulated. */
  add(result: PendingResult): Promise<void>;
  /** Send whatever is buffered. Safe to call when nothing is. */
  flush(): Promise<void>;
  /**
   * Send what is left and close the run. Resolves to the summary the platform froze at `finish` (plune#1247), or
   * `undefined` when it answered with none: no run, a refused finish, a deployment older than the summary.
   */
  finish(reason?: string): Promise<FrozenSummary | undefined>;
  /** Send what is left and deliberately leave the run open — the shard case (AC-03). */
  leaveOpen(): Promise<void>;
}

/**
 * What one results call may weigh, as serialized JSON — under the 10 MiB the route admits (#790,
 * ADR-0006 of that feature) with room for the envelope. The CLI's own transport limit, not a copy of
 * the platform's cap: the two can differ and nothing breaks.
 */
const BATCH_BYTES = 8 * 1024 * 1024;
const ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ results: [] }));

/** Consecutive batches of at most `BATCH_BYTES`; a result that weighs more on its own goes alone. */
function packed(results: readonly ResultSubmission[]): ResultSubmission[][] {
  const out: ResultSubmission[][] = [];
  let part: ResultSubmission[] = [];
  let bytes = ENVELOPE_BYTES;
  for (const result of results) {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (part.length > 0 && bytes + 1 + size > BATCH_BYTES) {
      out.push(part);
      part = [];
      bytes = ENVELOPE_BYTES;
    }
    bytes += (part.length > 0 ? 1 : 0) + size; // the comma between two results
    part.push(result);
  }
  if (part.length > 0) out.push(part);
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Start a run, or join the one that already carries this key.
 *
 * `expected` — one list of candidate identifiers per test the runner knows about — is used twice
 * on purpose. It becomes `configuration.expected`, from which the platform derives what never ran
 * (AC-09); and it is the input to the single up-front resolve, so the per-test path afterwards is
 * a map lookup rather than a request (AC-10). A runner that cannot enumerate its tests passes
 * nothing and resolves lazily on the first flush — same function, later moment.
 */
/** As much of the run as the reporter reads back — enough to tell a stored field from a dropped one. */
interface RunEcho {
  id: string;
  title?: string | null;
  environment?: string | null;
  labels?: string[] | null;
}

/**
 * Say so when a deployment took the run's description and kept none of it.
 *
 * This is the failure D13 exists to end, and it is the one the client can see and the server cannot:
 * a deployment older than those columns validates the body, stores what it knows, and answers 201.
 * Nothing about that is distinguishable from success — which is exactly why the reporter refused
 * these variables out loud before there was anywhere to put them.
 *
 * Only when EVERY field we sent came back empty. A joiner is told a title it did not set, and the
 * platform keeps the first shard's — so one field disagreeing is the rule working, not a gap.
 */
function warnIfDropped(
  sent: { title?: string; environment?: string; labels?: string[] },
  run: RunEcho,
  log: (line: string) => void,
): void {
  const names = Object.keys(sent) as (keyof typeof sent)[];
  if (names.length === 0) return;
  if (names.some((name) => run[name] != null)) return;


  log(
    `plune: this deployment stored none of ${names.join(', ')} — it is older than the fields. ` +
      'The run is otherwise reported in full.',
  );
}

export async function startRun(
  passed: ReporterConfig,
  declared?: readonly (readonly KeyRef[])[],
): Promise<RunSession> {
  // A committed config cannot know the run key of a job that does not exist yet, so the environment
  // fills what the caller left open. Explicitly PASSED wins — but an explicit `undefined` does not:
  // that is a caller spreading an optional field, not a decision to unset one.
  const env = readEnv();
  const stated = Object.fromEntries(Object.entries(passed).filter(([, v]) => v !== undefined));
  const cfg: ReporterConfig = { ...env.config, ...stated };

  const log = cfg.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const fallbackPath = cfg.fallbackPath ?? DEFAULT_FALLBACK_PATH;
  const externalKey = cfg.externalKey ?? null;
  /** Made once, and written on every line this session defers: what tells `plune run report` that they are one run's (cli#45). */
  const sessionMarker = randomUUID();
  const batchSize = Math.min(cfg.batchSize ?? BATCH_DEFAULT, BATCH_MAX);
  const offerDiscovered = cfg.offerDiscovered ?? false;

  const token = cfg.token ?? loadToken() ?? '';
  const client: PlatformClient = createClient({
    apiUrl: resolveApiUrl(cfg.apiUrl),
    token,
    ...(cfg.fetchImpl !== undefined ? { fetchImpl: cfg.fetchImpl } : {}),
  });

  const stats: RunStats = {
    accepted: 0,
    duplicate: 0,
    conflict: 0,
    rejected: 0,
    unresolved: 0,
    offered: 0,
    created: 0,
    unoffered: 0,
    deferred: 0,
    screenshots: { uploaded: 0, skipped: 0, failed: 0 },
    textFiles: { uploaded: 0, skipped: 0, failed: 0 },
    otherFiles: { uploaded: 0, skipped: 0, failed: 0 },
  };
  /** `null` records a key we already asked about and the platform did not know — asking twice
   * would cost a request to learn the same thing. */
  const resolved = new Map<string, string | null>();
  let buffer: PendingResult[] = [];
  /**
   * Tests that resolved to nothing, held until the run ends (D14).
   *
   * Accumulated rather than offered per batch for one reason: a retried test appears several times,
   * and a queue that grew a row per attempt would be unusable by the second flaky suite. Keyed by
   * the identity the platform would use, so a repeat replaces rather than adds.
   */
  const discoveries = new Map<string, DiscoveredTest>();
  let runId: string | null = null;
  let joined = false;
  /** Set once the platform has told us it will not accept anything more from this process. */
  let offline = token === '';
  let done = false;
  /** Names shortened to fit a key or a title, by original value — said once, counted once. */
  const shortened = new Set<string>();
  /** Why files stayed behind, as far as it has been said — once per reason and kind; the summary counts them all. */
  const skipsSaid = new Set<string>();
  const countsOf = (kind: Kind) => (kind === 'text' ? stats.textFiles : kind === 'file' ? stats.otherFiles : stats.screenshots);
  /** Whether a link has come back: the project has a bucket. Set before the line is said, so two files say it once. */
  let bucketSeen = false;
  /** Files the platform said have nowhere to go; the rest of the skipped have reasons of their own. */
  let noStorage = 0;
  /** An older platform has no `uploads` route (404 and no JSON): a picture or a text goes the way 0.17 sent it. */
  let uploadsMissing = false;
  /** The kinds whose first refusal of the platform's own routes has been said. */
  const failedSaid = new Set<Kind>();
  /** The codes of a bucket's trouble that have been said. */
  const codesSaid = new Set<string>();
  /** How many more files of a kind the route of the database takes for a result — by result and kind. */
  const rooms = new Map<string, number>();

  function bound(keys: readonly KeyRef[]): KeyRef[] {
    return keys.map((key) => {
      const fit = boundKey(key);
      if (fit !== key && !shortened.has(key.value)) {
        shortened.add(key.value);
        if (shortened.size === 1) {
          log(
            `plune: a test name longer than ${KEY_MAX} characters was shortened to fit its key — ` +
              `${JSON.stringify(printable(key.value.slice(0, 80)))}… Give the test a shorter name; until then this is its identity.`,
          );
        }
      }
      return fit;
    });
  }
  const expected = declared?.map(bound);

  if (offline) {
    log('plune: no API token — run "plune login" first. Results will be written to the fallback file.');
  }
  if (env.ignored.length > 0) {
    // Said out loud rather than dropped: a run has nowhere to store these yet, and a caller who
    // set them would otherwise have every reason to believe they arrived.
    log(`plune: ignoring ${env.ignored.join(', ')} — a run has nowhere to store them yet.`);
  }

  function defer(results: DeferredResult[]): void {
    appendBatch(fallbackPath, {
      runId,
      externalKey,
      session: sessionMarker,
      ...(cfg.meta !== undefined ? { meta: cfg.meta } : {}),
      results: results.map(onDisk),
    });
    stats.deferred += results.length;
  }

  /** Ask the platform about every key we have not asked about yet. */
  async function resolveKeys(values: readonly KeyRef[]): Promise<void> {
    const unknown = values.filter((k) => !resolved.has(k.value));
    // Deliberately not gated on a run: `/v1/test-cases/resolve` is about cases, not runs, and
    // needing the run first is what made the run's own configuration unusable (see below).
    if (unknown.length === 0 || offline) return;

    for (const part of chunk(unknown, RESOLVE_CHUNK)) {
      const out = await client.post<{ results: { key: KeyRef; testCaseId: string | null }[] }>(
        '/v1/test-cases/resolve',
        { keys: part },
      );
      // A 2xx without its list is no answer either (#790 re-review C5).
      if (!out.ok || !Array.isArray(out.body?.results)) {
        // Not fatal: an unresolved key defers its result rather than losing it.
        log(`plune: could not look up test cases (${out.ok ? 'the answer had no results' : out.detail || out.kind}).`);
        return;
      }
      for (const row of out.body.results) {
        // A row with no key names no test: its result stays unanswered, and so deferred (#790 re-review C7).
        if (typeof row?.key?.value === 'string') resolved.set(row.key.value, row.testCaseId);
      }
    }
  }

  /**
   * Look every test up FIRST, then start the run — and that order is the whole point.
   *
   * `configuration.expected` is what the platform derives `notRun` from, and it can only match an
   * entry it can identify. Built before the lookup, it could carry nothing but a raw external key,
   * and a project whose cases are keyed some other way got an empty `notRun` while its results
   * landed perfectly — a crashed shard would have looked exactly like a green run. Resolving first
   * costs nothing (the lookup is about cases, not runs) and lets each entry name its actual case.
   */
  if (!offline) {
    if (expected !== undefined) await resolveKeys(expected.flat());

    const stated = expected?.slice(0, EXPECTED_MAX) ?? [];
    const configuration =
      stated.length === 0
        ? undefined
        : {
            expected: stated.flatMap<ExpectedEntry>((keys) => {
              const hit = keys.map((k) => resolved.get(k.value)).find((v) => typeof v === 'string');
              if (typeof hit === 'string') return [{ testCaseId: hit }];
              // Unresolved: say what we know rather than dropping the entry. The platform cannot
              // count it, but the run still declares how many tests it meant to run.
              return keys[0] === undefined ? [] : [{ externalKey: keys[0] }];
            }),
            // The claim travels with the list it is about (D20). A runner that could not enumerate
            // its tests has no list, and a claim without one is nothing the platform can check —
            // so it is not sent, rather than sent and silently meaningless.
            ...(cfg.full === true ? { full: true } : {}),
          };
    if (expected !== undefined && expected.length > EXPECTED_MAX) {
      log(`plune: ${expected.length} tests is more than the run configuration holds — reporting the first ${EXPECTED_MAX}.`);
    }

    // D13. Sent as they are — the platform states the limits and refuses what exceeds them by
    // name, and its refusal costs no results: the run fails to start, this says why, and every
    // result goes to the fallback file. A second copy of the caps here would only drift.
    const described = {
      ...(cfg.title !== undefined ? { title: cfg.title } : {}),
      ...(cfg.environment !== undefined ? { environment: cfg.environment } : {}),
      ...(cfg.labels !== undefined ? { labels: cfg.labels } : {}),
    };

    const start = await client.post<{ run: RunEcho; joined: boolean }>('/v1/runs', {
      schemaVersion: 2,
      kind: cfg.kind ?? 'automated',
      ...(externalKey !== null ? { externalKey } : {}),
      ...(cfg.meta !== undefined ? { meta: cfg.meta } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
      // Named even when nobody named it — the list has to read without opening a row. Only what
      // the caller DESCRIBED goes to `warnIfDropped` below: a title this side invented is not one
      // a person will miss, and a deployment older than the field must not be nagged on every run.
      title: defaultRunTitle(),
      ...described,
    });

    if (start.ok && typeof start.body?.run?.id === 'string') {
      runId = start.body.run.id;
      joined = start.status === 200;
      warnIfDropped(described, start.body.run, log);
    } else {
      const why = start.ok ? 'the answer had no run' : start.detail || start.kind;
      log(`plune: could not start the run (${why}). Results will be written to ${fallbackPath}.`);
    }
  }

  /**
   * What the platform has told us about this result's identity.
   *
   * `unmatched` and `unanswered` look the same from a distance and must not be treated the same.
   * `unmatched` means the platform looked and there is no case — the result cannot be sent, and
   * C2's ladder decides what to do about it. `unanswered` means the lookup itself failed, so we
   * know nothing; reporting that as unmatched would drop a result the run really produced, on
   * the strength of a question nobody answered.
   */
  type Match =
    | { kind: 'found'; testCaseId: string }
    | { kind: 'unmatched' }
    | { kind: 'unanswered' };

  function matchFor(result: PendingResult): Match {
    // The test named its case outright. Nothing to look up, and nothing to rank against.
    if (result.testCaseId !== undefined) return { kind: 'found', testCaseId: result.testCaseId };
    let unanswered = false;
    for (const key of result.keys) {
      const hit = resolved.get(key.value);
      if (typeof hit === 'string') return { kind: 'found', testCaseId: hit };
      if (hit === undefined) unanswered = true;
    }
    return unanswered ? { kind: 'unanswered' } : { kind: 'unmatched' };
  }

  /**
   * Hold on to a test nothing resolved, if it said enough to be judged.
   *
   * A result missing either half is skipped in silence rather than sent with a guess: the platform
   * requires both and would refuse the whole batch, so one thin adapter would cost every other
   * test's offer. `unresolved` still counts it, which is the honest report — the test had no case,
   * and this reporter had nothing to offer about it.
   */
  function remember(result: PendingResult): void {
    if (!offerDiscovered) return;
    if (result.title === undefined || result.specRef === undefined) return;
    if (result.keys.length === 0) return;
    const title = boundTitle(result.title);
    if (title !== result.title) shortened.add(result.title);
    discoveries.set(result.keys[0]!.value, {
      keys: result.keys,
      title,
      source: result.source,
      specRef: result.specRef,
      rawStatus: result.rawStatus,
    });
  }

  /**
   * Offer everything this run found no case for, once, as the run closes.
   *
   * Failure here is reported and dropped, never deferred: the fallback file replays RESULTS, and an
   * offer is not a result — it is a question about a test the next run will ask again anyway. Writing
   * it there would mean a replay silently posts to a different endpoint than the file promises.
   */
  async function offer(): Promise<void> {
    if (discoveries.size === 0 || offline || runId === null) return;
    const batches = chunk([...discoveries.values()], DISCOVER_MAX);
    for (const [index, batch] of batches.entries()) {
      const out = await client.post<{ results: DiscoveryOutcome[] }>('/v1/review-items/discovered', {
        discovered: batch,
        runId,
      });
      // A 2xx without its list is no answer either (#790 re-review C7).
      if (!out.ok || !Array.isArray(out.body?.results)) {
        // The number that matters is not the batch that was refused — it is everything still
        // unoffered, which is that batch plus every one behind it, because this loop stops here.
        // Naming only the batch understates the work left by however many batches remain, and the
        // reader has no way to see the difference: the rest were never mentioned at all (#627).
        stats.unoffered = batches.slice(index).reduce((n, rest) => n + rest.length, 0);
        stats.unofferedWhy = whyUnoffered(out);
        log(
          `plune: could not offer ${stats.unoffered} unknown test(s) for review ` +
            `(${out.ok ? 'the answer had no results' : out.detail || out.kind}).`,
        );
        return;
      }
      // Only what a person now has to look at. `duplicate`, `refused` and `known` are the platform
      // saying "already handled" — reporting them as offers would make a repeat run look like new
      // work every time, which is how a queue stops being read.
      stats.offered += out.body.results.filter((r) => r?.outcome === 'queued').length;
      // `created` is the opposite of work to do, and it is counted for exactly that reason: the
      // project trusts this source, so the case exists already. Left out, a run that filled a
      // project with two thousand cases would print "0 offered for review" and read as a run where
      // nothing happened.
      stats.created += out.body.results.filter((r) => r?.outcome === 'created').length;
    }
  }

  function skip(kind: Kind, name: string, why: keyof typeof SKIPPED): void {
    countsOf(kind).skipped += 1;
    if (why === 'noStorage') noStorage += 1;
    // A project without a bucket is told once for the run, whichever file it was: the reason is the same.
    const said = why === 'noStorage' ? why : `${kind}/${why}`;
    if (skipsSaid.has(said)) return;
    skipsSaid.add(said);
    if (why === 'noStorage') log(`plune: "${name}" not stored — ${SKIPPED[why]}.`);
    else log(`plune: ${KINDS[kind].label} "${name}" not uploaded — ${SKIPPED[why]}.`);
  }

  /**
   * Ask where one file goes (plune-ai/plune#945): into the customer's bucket by a link, to the route that has
   * always taken a picture or a text, or nowhere. One file to a call: a refusal of one (a file over the
   * bucket's ceiling refuses the whole call) costs no other, and a renewed link is the same call again.
   */
  function ask(job: Upload, size: number) {
    return client.post<{ files?: unknown[] }>(`/v1/results/${encodeURIComponent(job.id)}/files/uploads`, {
      files: [{ name: job.name, contentType: job.type, size }],
    });
  }

  /** The old warning, said once per kind, for a refusal of the platform's own routes. */
  function failed(job: Upload, why: string): void {
    countsOf(job.kind).failed += 1;
    if (!failedSaid.has(job.kind)) {
      failedSaid.add(job.kind);
      log(`plune: could not upload a ${KINDS[job.kind].label} (${why}) — its result is reported without it.`);
    }
  }

  /** A bucket's trouble: counted for every file, said once for each code — the name and the code, nothing else. */
  function failedToBucket(job: Upload, code: string): void {
    countsOf(job.kind).failed += 1;
    if (codesSaid.has(code)) return;
    codesSaid.add(code);
    log(`plune: "${job.name}" not uploaded to your bucket (${code}) — its result is reported without it.`);
  }

  /** Why the platform's own routes would not have this file, when it is known here — better than "no bucket". */
  function refusedHere(job: Upload, size: number): keyof typeof SKIPPED | undefined {
    if (job.kind === 'screenshot') {
      if (!SCREENSHOT_TYPES.has(job.type)) return 'type';
      if (size > SCREENSHOT_BYTES) return 'size';
    }
    if (job.kind === 'text' && size > TEXT_BYTES) return 'textSize';
    return undefined;
  }

  /** The way it always was: the bytes as the body of the route of the result, after the checks only that route needs. */
  async function uploadDirect(job: Upload, size: number): Promise<void> {
    const { kind } = job;
    if (kind === 'file') return skip(kind, job.name, 'noStorage');
    const { bytes: ceiling, size: tooBig } = KINDS[kind];
    if (size > ceiling) return skip(kind, job.name, tooBig);
    let bytes: Buffer;
    if (job.body !== undefined) bytes = job.body;
    else {
      try {
        bytes = await disk.readFile(job.path as string);
      } catch {
        return skip(kind, job.name, 'missing');
      }
    }
    const refusal = kind === 'text' ? textRefusal(bytes) : undefined;
    if (refusal !== undefined) return skip(kind, job.name, refusal);
    const out = await client.upload(
      `/v1/results/${encodeURIComponent(job.id)}/files?name=${encodeURIComponent(job.name)}`,
      bytes,
      job.type,
    );
    if (out.ok) countsOf(kind).uploaded += 1;
    // Said once: a closed run or a lost network refuses every file after the first the same way.
    else failed(job, out.detail || out.kind);
  }

  /** The three steps of ADR 0041: the link is the platform's, the PUT the bucket's, and `complete` is the platform asking the bucket. */
  async function uploadToBucket(job: Upload, size: number, first: { id: string; url: string; headers: Record<string, string> }): Promise<void> {
    const source = job.body !== undefined ? { body: job.body } : { path: job.path as string, size };
    let link = first;
    for (let renewed = false; ; ) {
      const put = await client.put(link.url, link.headers, source);
      if (put.ok) break;
      // The link has expired: one new one for this file, then it is a warning (a file that is refused twice is not slow).
      if (put.status !== 403 || renewed) return failedToBucket(job, put.code);
      renewed = true;
      const again = await ask(job, size);
      if (!again.ok) return failedToBucket(job, codeOf(again));
      const fresh = linkOf(again.body?.files?.[0]);
      if (fresh === undefined) return failedToBucket(job, 'bad_answer');
      link = fresh;
    }
    const done = await client.post(`/v1/files/${encodeURIComponent(link.id)}/complete`, {});
    if (!done.ok) return failedToBucket(job, codeOf(done));
    countsOf(job.kind).uploaded += 1;
  }

  /** At most `UPLOADS_AT_ONCE` calls of the platform or of a bucket in flight, whoever's they are. */
  let free = UPLOADS_AT_ONCE;
  const waiting: (() => void)[] = [];
  async function gated<T>(work: () => Promise<T>): Promise<T> {
    if (free === 0) await new Promise<void>((resolve) => waiting.push(resolve));
    else free -= 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next();
      else free += 1;
    }
  }

  /**
   * Decide what one file does, under the name `nameOf` gave it — never the path, which names this machine, and
   * never a link. The decision takes the place the file holds in its result, so the files of one result are
   * decided in the order of their attachments; the work itself (a PUT, a direct upload) is handed back.
   */
  async function plan(job: Upload): Promise<(() => Promise<void>) | undefined> {
    const { kind } = job;
    let size: number;
    if (job.body !== undefined) size = job.body.length;
    else if (job.path === undefined) return void skip(kind, job.name, 'missing');
    else {
      try {
        size = (await disk.stat(job.path)).size;
      } catch {
        return void skip(kind, job.name, 'missing');
      }
    }
    if (size === 0) return void skip(kind, job.name, 'empty');
    // A place in the result goes to a picture or a text the database will take, in the order of the attachments.
    const direct = (): (() => Promise<void>) | undefined => {
      if (kind === 'file') return void skip(kind, job.name, 'noStorage');
      const roomKey = `${job.id}/${kind}`;
      const left = rooms.get(roomKey) ?? KINDS[kind].room;
      if (left === 0) return void skip(kind, job.name, KINDS[kind].limit);
      rooms.set(roomKey, left - 1);
      return () => uploadDirect(job, size);
    };
    if (uploadsMissing) return direct();
    const out = await gated(() => ask(job, size));
    if (!out.ok) {
      if (out.status === 404 && out.detail === '' && out.code === undefined) {
        uploadsMissing = true;
        return direct();
      }
      if (out.code !== undefined) failedToBucket(job, out.code);
      else failed(job, out.detail || out.kind);
      return undefined;
    }
    const item = out.body?.files?.[0] as { skipped?: unknown; direct?: unknown } | undefined;
    if (item?.skipped === 'no_storage') return void skip(kind, job.name, refusedHere(job, size) ?? 'noStorage');
    if (item?.direct === true) return direct();
    const link = linkOf(item);
    if (link === undefined) return void failed(job, 'bad_answer');
    if (!bucketSeen) {
      bucketSeen = true;
      log(BUCKET_FOUND);
    }
    return () => uploadToBucket(job, size, link);
  }

  /**
   * The screenshots and the text files of the results a batch just stored, each to its own result
   * (platform ADR 0040).
   *
   * Only `accepted`: a `duplicate` was stored by an earlier report, files and all, and sending them
   * again would fill its places with copies. Awaited before the next batch, and so before anything
   * closes the run — the platform takes no file on a closed run. Never deferred: the fallback file
   * replays results, and a result that arrived without its files has still arrived.
   */
  async function upload(items: BatchItem[] | undefined, filesByKey: ReadonlyMap<string, ResultFile[]>): Promise<void> {
    if (filesByKey.size === 0 || !Array.isArray(items)) return;
    const jobs: Upload[] = [];
    for (const item of items) {
      if (item?.status !== 'accepted' || typeof item.id !== 'string' || typeof item.resultKey !== 'string') continue;
      for (const file of filesByKey.get(item.resultKey) ?? []) {
        const type =
          mediaTypeOf(file.contentType) ??
          (file.path === undefined ? undefined : TYPE_BY_EXTENSION[extname(file.path).toLowerCase()]);
        // A type nobody named, the test-case id the reporter reads (not the test's file), an image or a trace kept as
        // a body: not a file to send, so neither sent nor counted.
        if (type === undefined || type === METADATA_TYPE) continue;
        const kind = kindOf(type);
        if (kind !== 'text' && file.path === undefined) continue;
        const name = nameOf(file);
        if (file.name.startsWith('_')) skip(kind, name, 'hidden');
        else {
          jobs.push({
            id: item.id,
            kind,
            name,
            type: kind === 'text' ? textTypeOf(file.contentType ?? '', type) : type,
            ...(file.body !== undefined ? { body: file.body } : {}),
            ...(file.path !== undefined ? { path: file.path } : {}),
          });
        }
      }
    }
    // The files of one result are asked about one after the other, in the order of the attachments; the results
    // run side by side, and the calls they make share the four places of `gated`.
    const byResult = new Map<string, Upload[]>();
    for (const job of jobs) byResult.set(job.id, [...(byResult.get(job.id) ?? []), job]);
    await Promise.all(
      [...byResult.values()].map(async (group) => {
        const work: Promise<void>[] = [];
        for (const job of group) {
          const act = await plan(job);
          if (act !== undefined) work.push(gated(act));
        }
        await Promise.all(work);
      }),
    );
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const pending = buffer;
    buffer = [];

    if (offline || runId === null) {
      defer(pending);
      return;
    }

    await resolveKeys(pending.flatMap((p) => p.keys));

    const submissions: ResultSubmission[] = [];
    const unanswered: PendingResult[] = [];
    /** The files of what is sent, by result key — kept on this side: their paths name this machine. */
    const filesByKey = new Map<string, ResultFile[]>();
    for (const result of pending) {
      const match = matchFor(result);
      if (match.kind === 'found') {
        const { keys: _keys, files, ...rest } = result;
        submissions.push({ ...rest, testCaseId: match.testCaseId });
        if (files !== undefined) filesByKey.set(result.resultKey, files);
      } else if (match.kind === 'unmatched') {
        stats.unresolved += 1;
        remember(result);
      } else {
        unanswered.push(result);
      }
    }
    if (unanswered.length > 0) defer(unanswered);
    if (submissions.length === 0) {
      // Still a batch of the report handled, and on a FIRST import it is the only kind there is:
      // nothing resolves, so nothing is posted, and progress reported only on posts would go
      // silent for exactly the import that takes longest.
      progress();
      return;
    }

    // One fallback line per batch, never the rest of the flush on one line: `plune run report` sends
    // a line as one request, and a line of every batch left would be the request the route refuses.
    for (const part of packed(submissions)) {
      if (offline) {
        defer(part);
        continue;
      }
      const out = await client.post<{ counts: Record<keyof RunStats, number>; items?: BatchItem[] }>(
        `/v1/runs/${runId}/results`,
        { results: part },
      );
      // A success with no counts says nothing about what was stored: kept for a replay, not guessed —
      // and counts with no number in them say no more (#790 re-review C7).
      const counts = out.ok ? out.body?.counts : undefined;
      const told = COUNTED.filter((k) => typeof counts?.[k] === 'number');
      if (told.length > 0) {
        for (const k of told) stats[k] += counts![k];
        progress();
        await upload(out.ok ? out.body?.items : undefined, filesByKey);
        continue;
      }

      if (out.ok) {
        log('plune: could not send results (the answer carried no counts).');
      } else if (out.kind === 'auth') {
        log('plune: the API token was refused — run "plune login" with a fresh one.');
        offline = true;
      } else if (out.kind === 'conflict') {
        // Two processes closed one run. Retrying would not help and hiding it would leave someone
        // wondering why a third of a sharded run is missing.
        log(`plune: this run is closed — ${out.detail}`);
      } else {
        log(`plune: could not send results (${out.detail || out.kind}).`);
      }
      defer(part);
    }
  }

  /**
   * Movement, but only where its absence would be ambiguous (#627).
   *
   * A suite that fits in one batch reports once and is done; a line about it would be noise. A
   * mature suite is a dozen or more silent round trips, and a person watching a first import has
   * nothing to tell a slow one from a hung one — the summary only arrives after everything.
   *
   * Counted against `expected`, the list of what the runner said ran, so the denominator is the
   * whole report rather than the part reached so far. Deliberately the unsliced list: a report
   * larger than the run configuration holds is exactly the one whose progress is worth watching.
   */
  function progress(): void {
    const total = expected?.length ?? 0;
    if (total <= batchSize) return;
    const done = stats.accepted + stats.duplicate + stats.conflict + stats.rejected + stats.unresolved;
    log(`plune: ${Math.min(done, total)} of ${total} results sent`);
  }

  function summarise(): void {
    const parts = [`${stats.accepted} accepted`];
    if (stats.duplicate > 0) parts.push(`${stats.duplicate} already reported`);
    if (stats.conflict > 0) parts.push(`${stats.conflict} conflicting`);
    if (stats.rejected > 0) parts.push(`${stats.rejected} rejected`);
    if (stats.unresolved > 0) parts.push(`${stats.unresolved} with no matching test case`);
    if (stats.offered > 0) parts.push(`${stats.offered} offered for review`);
    if (stats.created > 0) parts.push(`${stats.created} added as cases (trusted source)`);
    const kinds = [stats.screenshots, stats.textFiles, stats.otherFiles];
    const sum = (what: 'uploaded' | 'skipped' | 'failed') => kinds.reduce((n, counts) => n + counts[what], 0);
    if (bucketSeen) {
      // One count for the files of a project with a bucket: every kind goes the same way there. Only what the
      // platform said has no bucket is labelled so; the other skips have their reasons, said above once each.
      const other = sum('skipped') - noStorage;
      parts.push(
        `${sum('uploaded')} file(s) uploaded to your bucket` +
          (noStorage > 0 ? `, ${noStorage} skipped (no bucket connected)` : '') +
          (other > 0 ? `, ${other} skipped` : '') +
          (sum('failed') > 0 ? `, ${sum('failed')} failed to upload` : ''),
      );
    } else {
      for (const said of [tally(stats.screenshots, 'screenshot'), tally(stats.textFiles, 'text file')]) {
        if (said !== undefined) parts.push(said);
      }
      // A trace or a video has nowhere to go without a bucket: counted, so that nobody finds them missing by surprise.
      const other = stats.otherFiles;
      if (other.skipped > 0) parts.push(`${other.skipped} file(s) not stored (no bucket connected)`);
      if (other.failed > 0) parts.push(`${other.failed} file(s) failed to upload`);
    }
    if (stats.deferred > 0) parts.push(`${stats.deferred} not delivered — written to ${fallbackPath}`);
    if (shortened.size > 0) parts.push(`${shortened.size} test name(s) shortened to fit a key`);
    log(`plune: ${parts.join(' · ')}`);
    // Where a GitHub run shows it without anyone opening the log — for every road, from here (#790).
    // Said and nothing more: a reporting failure is not the build's failure (#788).
    if (stats.deferred > 0 && process.env['GITHUB_ACTIONS'] === 'true') {
      log(`::warning::${stats.deferred} result(s) were not delivered to Plune — see the reporting step's log.`);
    }
  }

  return {
    get runId() {
      return runId;
    },
    get joined() {
      return joined;
    },
    get stats() {
      return stats;
    },
    async add(result) {
      buffer.push({ ...result, keys: bound(result.keys) });
      if (buffer.length >= batchSize) await flush();
    },
    flush,
    async finish(reason?: string) {
      if (done) return undefined;
      done = true;
      await flush();
      // Before the close, not after: the entries name the run that found them, and a closed run is
      // still the right answer to "where did this come from".
      await offer();
      let frozen: FrozenSummary | undefined;
      if (runId !== null && !offline) {
        const out = await client.post<{ detached?: number; summary?: FrozenSummary }>(`/v1/runs/${runId}/events`, {
          event: 'finish',
          ...(reason !== undefined ? { reason } : {}),
        });
        // A refusal here leaves the run open, which is a truthful state — see `leaveOpen`.
        if (!out.ok) log(`plune: could not close run ${runId} (${out.detail || out.kind}).`);
        else {
          // Handed back as it came: what it means for an exit code is the gate's to say (plune#1247).
          frozen = out.body?.summary ?? undefined;
          // The one thing a full run does outside itself (D20). Said when it happened and only then:
          // a `0 detached` on every ordinary run would teach people to stop reading the line.
          if (typeof out.body?.detached === 'number' && out.body.detached > 0) {
            log(`plune: ${out.body.detached} test case(s) marked detached — this full run no longer reports them.`);
          }
        }
      }
      summarise();
      return frozen;
    },
    async leaveOpen() {
      if (done) return;
      done = true;
      await flush();
      // A shard offers what IT found. The platform deduplicates by key, so the other shards'
      // repeats come back `duplicate` — whereas offering only from the closing process would mean
      // a sharded run never offers anything, since no process closes it.
      await offer();
      if (runId !== null) {
        // Deliberately open: this process is one shard and cannot know the others are done.
        // Whoever does know closes it, and until then the run reads as still running — which is
        // the truth, and the whole point of AC-08.
        log(`plune: run ${runId} is still open — close it with "plune run finish ${runId}".`);
      }
      summarise();
    },
  };
}
