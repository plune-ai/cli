/**
 * The platform's wire, mirrored in types — and only in types.
 *
 * There is deliberately no zod here. ADR 0012 says the platform owns the contract and clients
 * conform to it; a second copy of the schema on the client is a second place to drift, and it
 * would put a validation library into the dependency tree of every project that installs an
 * adapter. The platform validates and answers with a named reason (`validation failed — <field>:
 * <why>`), and that reason is what the reporter shows.
 *
 * What keeps these shapes honest is not a runtime check here but the platform's contract test
 * against the published package — the same mechanism `cli-sync-contract.test.ts` already
 * establishes for `plune sync`.
 */

/** Kinds of run the platform accepts. `mixed` is declared, never derived — "some of these were run
 * by a person" is a fact about the process, not something visible in the results. */
export type RunKind = 'automated' | 'manual' | 'mixed' | 'eval';

/** What a result finally means. The reporter never picks one of these — see `PendingResult`. */
export type ResultStatus = 'passed' | 'failed' | 'broken' | 'blocked' | 'skipped';

/**
 * The namespaces other tools already use for the same test.
 *
 * The ORDER is the platform's, and it matters there, not here: a lookup that names no kind
 * resolves in that sequence. A client that reproduced the ranking would be a second place to
 * forget it, so this list is only a vocabulary — the ranking stays server-side.
 */
export type ExternalKeyKind =
  | 'playwright-id'
  | 'path-title'
  | 'allure-history'
  | 'cairn-stable'
  | 'eval-id'
  | 'qase'
  | 'testrail';

/** One candidate identifier for a test. `kind` omitted means "resolve it however you rank them". */
export interface KeyRef {
  kind?: ExternalKeyKind;
  value: string;
}

/** Where the run came from. Every field optional because a shard genuinely may not know it. */
export interface RunMeta {
  sha?: string;
  branch?: string;
  ciUrl?: string;
  runner?: string;
}

/** How the run itself went, as the runner measured it. `retry` 0 is the first attempt. */
export interface Execution {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  retry: number;
  worker?: string;
}

/** A link, not a file. Uploading artefacts is C3; this carries what someone else already hosts. */
export interface Attachment {
  name: string;
  url: string;
  contentType?: string;
}

/** One assertion's outcome, in the shape the platform already stores for its own runner. */
export interface AssertionRecord {
  type: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

/**
 * One result, as an adapter hands it over — before it has a test case.
 *
 * `keys` rather than a `testCaseId` is the seam that keeps adapters thin AND leaves room for C2:
 * an adapter says "here is how this test identifies itself", and resolving that to a case is the
 * core's business. C2 adds rungs to the ladder by putting more candidates in this array; neither
 * this shape nor the adapters change.
 *
 * `rawStatus` rather than `status` is the other half of that discipline. The platform maps a
 * runner's word to a meaning per project (`timedOut` → `broken` by default, overridable), so a
 * team can change what a timeout means to them without waiting for a reporter release. A reporter
 * that decided the status would take that away and put two different answers on two surfaces.
 */
export interface PendingResult {
  resultKey: string;
  /**
   * The case this result IS, when the test says so outright — a `PluneId` annotation, or the
   * `@P<id>` token C2 also reads out of a title.
   *
   * Separate from `keys` because it is a different claim, and the platform draws the same line:
   * `plune-id` is deliberately absent from its external-key kinds, since it is the thing external
   * keys resolve TO. Present means no lookup is needed for this result at all.
   */
  testCaseId?: string;
  keys: KeyRef[];
  /** Which runner produced this — the key into the project's status map. */
  source: string;
  /** The runner's own word: `passed`, `failed`, `timedOut`, `interrupted`, `skipped`. */
  rawStatus: string;
  /** What the author expected — `test.fail()` and friends. Absent means a pass was expected. */
  expectedStatus?: ResultStatus;
  /**
   * What to call this test, and where it lives — read ONLY when nothing resolved it (D14).
   *
   * A result that found its case needs neither: the case already has a title and a spec. These are
   * for the other path, where the reporter offers the test to the review queue and the queue needs a
   * name a person can judge and a spec a case can point at.
   *
   * Optional because an adapter that cannot say both simply does not participate. Deriving them from
   * a key's internal spelling was the alternative and it is worse: it makes the core parse a string
   * the adapter formatted, which is a contract nothing checks.
   */
  title?: string;
  specRef?: string;
  execution?: Execution;
  errorContext?: string;
  params?: Record<string, unknown>;
  attachments?: Attachment[];
  assertions?: AssertionRecord[];
}

/** What a run submission looks like once a key has resolved. Built by the core, never by a caller. */
export interface ResultSubmission extends Omit<PendingResult, 'keys' | 'testCaseId'> {
  testCaseId: string;
}

/**
 * A test this project runs and the platform has no case for (D14, platform ADR 0029).
 *
 * Deliberately NOT a proposed case. A proposal carries steps and an expected result, and a reporter
 * has neither — it sees a `TestResult`, never the test's source. This says the test exists and where
 * it lives, and stops; the platform refuses steps here by name rather than dropping them, so the
 * shape cannot quietly grow into the thing it was written to avoid.
 */
export interface DiscoveredTest {
  keys: KeyRef[];
  title: string;
  source: string;
  specRef: string;
  rawStatus?: string;
}

/**
 * What became of ONE offered test. Read per test, not off the status line: most of a repeated batch
 * is already known or already refused, and only `queued` is new work for a reviewer.
 */
export interface DiscoveryOutcome {
  key: KeyRef;
  outcome: 'queued' | 'duplicate' | 'refused' | 'known';
  id?: string;
}

/** One entry of the "what this run intended to execute" list, from which the platform derives
 * `notRun`. Either side may be given; the core fills `externalKey` from the adapter's key list. */
export interface ExpectedEntry {
  testCaseId?: string;
  externalKey?: KeyRef;
}

/** The run as the platform answers with it. Only `id` is load-bearing for the client. */
export interface RunRecord {
  id: string;
  projectId?: string;
  schemaVersion?: number;
}

/** Per-element verdicts from a batch. `conflict` means two runners disagreed about one result —
 * the platform refuses to resolve that by overwriting, and neither do we. */
export interface SubmitCounts {
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
}

/** What the session accumulated, for the one summary line a reporter prints. */
export interface RunStats extends SubmitCounts {
  /** Results whose keys matched no case — never sent, because inventing an id would write into
   * somebody else's history. Rung 6 of C2's ladder is what to do about them: see `offered`. */
  unresolved: number;
  /** Unresolved tests offered to the review queue under `PLUNE_CREATE=1` (D14). Counted separately
   * from `unresolved` because they are the same tests seen twice, not a second population. */
  offered: number;
  /**
   * Unmatched tests that were NOT offered, because the queue would not take them (#627).
   *
   * Separate from `offered` rather than a shortfall computed against `unresolved`: the reason a
   * test went unoffered is the caller's next action, and a subtraction cannot carry a reason. A
   * queue at capacity means "empty it and import again"; nothing else here means that.
   */
  unoffered: number;
  /** Results written to the fallback file instead of the platform. */
  deferred: number;
}

/** Everything the core needs to talk to a deployment. */
export interface ReporterConfig {
  /** Base URL. Falls back to `PLUNE_API_URL`, then beta — the same resolution `sync` uses. */
  apiUrl?: string;
  /** Bearer token. Falls back to the store `plune login` writes. */
  token?: string;
  /** The key several shards share so they land in one run. Absent means a run of its own. */
  externalKey?: string;
  kind?: RunKind;
  meta?: RunMeta;
  /** What to call this run in a list. The first shard to declare one wins. */
  title?: string;
  /** Where it ran — staging, prod, a preview. What keeps two CI matrices from reading as one. */
  environment?: string;
  /** How the run is marked — smoke, nightly, a team. */
  labels?: string[];
  /** Results per request. The platform's ceiling is 500. */
  batchSize?: number;
  /** Where unsent batches go. Defaults beside the run file the CLI already writes. */
  fallbackPath?: string;
  /**
   * Offer tests that resolved to nothing to the platform's review queue (`PLUNE_CREATE=1`, D14).
   *
   * Off by default, and that is the product decision rather than caution: a reporter that filled a
   * stranger's review queue on first run would teach the team to ignore the queue. Turning it on is
   * how somebody says "yes, tell me what we are running that you do not know about".
   */
  offerDiscovered?: boolean;
  /** Transport seam — the same one `sync.ts` uses so tests need no server. */
  fetchImpl?: typeof fetch;
  /** Where a line for the operator goes. Defaults to stderr. */
  log?: (line: string) => void;
}
