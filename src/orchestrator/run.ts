// Orchestration pipeline (ADR-OR01/OR02). `runRow` handles one dataset row; `runOrchestration`
// (below) drives evals × rows. Pure given injected deps — no direct I/O here (the CLI composition
// root in cli/commands/run.ts wires the real provider/cache/embedder).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheKey, configHash } from '../util/hash.js';
import { extractJson } from '../assertions/json-extract.js';
import { isCacheable } from '../cache/cache.js';
import { getAssertion } from '../assertions/index.js';
import { buildJudge } from './judge.js';
import { mapLimit } from './concurrency.js';
import { ProviderError, AuthError } from '../providers/errors.js';
import type {
  AssertionResultRecord,
  CacheSummary,
  EvalResult,
  RowResult,
  RunError,
  RunResult,
  Summary,
  Usage,
} from '../types/results.js';
import { rowStatus } from '../types/results.js';
import type {
  AssertionConfig,
  Config,
  DatasetRef,
  DatasetRow,
  EvalConfig,
  ProviderConfig,
} from '../types/config.js';
import type { Provider } from '../types/provider.js';
import type { Embedder } from '../types/embedder.js';
import type { Cache } from '../cache/cache.js';
import { MAX_RUNS } from '../config/schema.js';
import { mcpLimits } from '../config/mcp.js';
import { runAgentRow, type AgentConnect, type AgentRowParams } from './agent.js';

const DEFAULT_MAX_TOKENS = 1024;
const PLUNE_VERSION = '0.1.0';

/** A config/input error (unknown prompt variable, missing prompt_file) → the CLI maps it to exit 2. */
export class RunConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'RunConfigError';
  }
}

export interface RowParams {
  template: string;
  assertions: AssertionConfig[];
  row: DatasetRow;
  providerConfig: ProviderConfig;
  provider: Provider;
  embedder: Embedder;
  cache: Cache;
  now: () => number;
  dryRun: boolean;
  noCache: boolean;
  /** Every row must be answered from the cache; a miss ends the row without a model call. */
  cacheStrict?: boolean;
  /** Entries older than this count as a miss. */
  cacheMaxAgeMs?: number;
  /** Test seam: the policy version in the key (default CACHE_POLICY_VERSION). */
  policyVersion?: number;
  /** Which repeat of the row this is, from 0 (`runs`); from 1 on it has a cache key of its own. */
  attempt?: number;
}

/** The code on a row left unanswered by `--cache-strict`; the CLI turns these into its own exit code. */
export const CACHE_MISS_CODE = 'CACHE_MISS';

/**
 * Format check for a completion, before it is cached or replayed: an eval with a `json-schema`
 * assertion needs an answer that holds JSON. Whether the JSON fits the schema is a content verdict
 * and is not asked here (adr/0001-completion-cache-hardening.md).
 */
export function answerParses(output: string, assertions: AssertionConfig[]): boolean {
  return assertions.every(
    (a) => a.type !== 'json-schema' || extractJson(output, a.extract ?? 'auto').ok,
  );
}

/** Substitute {{var}} from the row's vars (CLI_SPEC §5.2). An unknown variable is a config error. */
export function resolvePrompt(
  template: string,
  vars: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new RunConfigError(`Unknown variable "${key}" referenced in prompt`);
    }
    return String(vars[key]);
  });
}

export function toRunError(err: unknown): RunError {
  if (err instanceof ProviderError || err instanceof AuthError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'ERROR', message: err instanceof Error ? err.message : String(err) };
}

export function estimateUsage(
  prompt: string,
  maxTokens: number,
): { input_tokens: number; output_tokens: number } {
  return { input_tokens: Math.ceil(prompt.length / 4), output_tokens: maxTokens };
}

function pricedField(priced: boolean | undefined): { priced?: boolean } {
  return priced === undefined ? {} : { priced };
}

export function costFields(c: { cost_usd: number; priced?: boolean }): {
  cost_usd: number;
  priced?: boolean;
} {
  return { cost_usd: c.cost_usd, ...pricedField(c.priced) };
}

/** The row's assertions on an answer, with what the judge calls among them cost. Shared by plain and agentic rows. */
export async function assess(
  p: Pick<RowParams, 'assertions' | 'row' | 'provider' | 'providerConfig' | 'embedder'>,
  output: string,
): Promise<{
  records: AssertionResultRecord[];
  assertionError: RunError | undefined;
  judgeCost: number;
  judgeUnpriced: boolean;
}> {
  // Row-local judge so judge-call cost is attributed to this row (ADR-OR02).
  let judgeCost = 0;
  let judgeUnpriced = false;
  const judge = buildJudge(p.provider, p.providerConfig, (u) => {
    const c = p.provider.estimateCost(u);
    judgeCost += c.cost_usd;
    if (c.priced === false) judgeUnpriced = true;
  });

  const records: AssertionResultRecord[] = [];
  let assertionError: RunError | undefined;
  for (const assertion of p.assertions) {
    try {
      const result = await getAssertion(assertion.type).run({
        output,
        vars: p.row.vars,
        row: p.row,
        params: assertion,
        embedder: p.embedder,
        judge,
      });
      records.push({
        type: assertion.type,
        passed: result.passed,
        ...(result.score !== undefined ? { score: result.score } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      });
    } catch (err) {
      // A judge/embedder infra failure surfaces as an errored row (ADR-OR02).
      assertionError = toRunError(err);
      break;
    }
  }
  return { records, assertionError, judgeCost, judgeUnpriced };
}

export async function runRow(p: RowParams): Promise<RowResult> {
  const t0 = p.now();
  const prompt = resolvePrompt(p.template, p.row.vars);
  // No default. `?? 0` used to stand here, and it turned every eval on a model newer than Opus 4.6
  // into a 400 before the first row ran (the parameter is deprecated there; only 1.0 is accepted).
  const temperature = p.providerConfig.temperature;
  const maxTokens = p.providerConfig.max_tokens ?? DEFAULT_MAX_TOKENS;

  // --dry-run: estimate cost only; never touch the network or cache (FR-8).
  if (p.dryRun) {
    const est = estimateUsage(prompt, maxTokens);
    const cost = p.provider.estimateCost(est);
    const usage: Usage = { ...est, ...costFields(cost) };
    return { vars: p.row.vars, output: null, cached: false, usage, assertions: [] };
  }

  // An unset temperature keys as 0 (the cache policy version, not this default, retires old entries).
  const key = cacheKey(
    {
      provider: p.providerConfig.type,
      model: p.providerConfig.model,
      temperature: temperature ?? 0,
      max_tokens: maxTokens,
      prompt_resolved: prompt,
      ...(p.attempt !== undefined ? { attempt: p.attempt } : {}),
    },
    p.policyVersion,
  );

  let output: string;
  let usage: Usage;
  let cached = false;
  let cacheSaved: RowResult['cache_saved'];

  let hit = p.noCache
    ? undefined
    : p.cache.get(key, p.cacheMaxAgeMs !== undefined ? { maxAgeMs: p.cacheMaxAgeMs } : {});
  if (hit !== undefined && !answerParses(hit.output, p.assertions)) {
    // A stored answer that does not hold the expected format is dropped, and the model is asked
    // once in this run. (Only that entry; a provider failure never removes entries.)
    // Under --cache-strict no retry is possible, so the entry is left alone (CI must not mutate it).
    if (p.cacheStrict !== true) p.cache.delete(key);
    hit = undefined;
  }
  if (hit === undefined && p.cacheStrict === true) {
    return {
      vars: p.row.vars,
      output: null,
      cached: false,
      latency_ms: p.now() - t0,
      error: { code: CACHE_MISS_CODE, message: 'no usable cache entry (--cache-strict)' },
      assertions: [],
    };
  }
  if (hit !== undefined) {
    output = hit.output;
    cached = true;
    usage = {
      input_tokens: hit.usage.input_tokens,
      output_tokens: hit.usage.output_tokens,
      cost_usd: 0,
      // A hit costs nothing, but whether that 0 is a known price depends on the model.
      ...pricedField(p.provider.estimateCost(hit.usage).priced),
    };
    cacheSaved = {
      input_tokens: hit.usage.input_tokens,
      output_tokens: hit.usage.output_tokens,
      cost_usd: p.provider.estimateCost(hit.usage).cost_usd,
    };
  } else {
    try {
      const res = await p.provider.complete({
        provider: p.providerConfig.type,
        model: p.providerConfig.model,
        ...(temperature !== undefined ? { temperature } : {}),
        max_tokens: maxTokens,
        prompt_resolved: prompt,
      });
      output = res.output;
      const cost = p.provider.estimateCost(res.usage, res.cost_usd);
      usage = {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        // Prefer the provider-reported actual cost (res.cost_usd) when present; resolveCost still
        // lets a config pricing override win, else falls back to the table estimate (ADR-PRC01).
        ...costFields(cost),
      };
      // Stored only once the answer is usable: some text, not cut off, no provider error, and the
      // expected format. A wrong-but-well-formed answer (assertions fail below) stays cached.
      if (!p.noCache && isCacheable(res) && answerParses(res.output, p.assertions)) {
        p.cache.set(key, res);
      }
    } catch (err) {
      // Provider exhausted (after retry) → the row is ERRORED, not failed (ADR-OR02).
      return {
        vars: p.row.vars,
        output: null,
        cached: false,
        latency_ms: p.now() - t0,
        error: toRunError(err),
        assertions: [],
      };
    }
  }

  const { records, assertionError, judgeCost, judgeUnpriced } = await assess(p, output);

  const finalUsage: Usage = {
    ...usage,
    cost_usd: usage.cost_usd + judgeCost,
    // A row is priced only when every call in it was; the field stays absent if the provider never said.
    ...(judgeUnpriced ? { priced: false } : {}),
  };
  return {
    vars: p.row.vars,
    output,
    cached,
    usage: finalUsage,
    latency_ms: p.now() - t0,
    ...(cacheSaved !== undefined ? { cache_saved: cacheSaved } : {}),
    ...(assertionError !== undefined ? { error: assertionError } : {}),
    assertions: records,
  };
}

// --- Repeats: one row run `runs` times, one verdict by `pass_threshold` ---

/**
 * Passes a row needs: ceil(pass_threshold × runs), never fewer than one. The 1e-9 allowance absorbs
 * binary rounding: 0.7 × 10 is 7.000000000000001 in floating point, and a bare ceil would ask for 8.
 */
export function neededPasses(passThreshold: number, runs: number): number {
  return Math.max(1, Math.ceil(passThreshold * runs - 1e-9));
}

type Attempt = NonNullable<RowResult['attempts']>['results'][number];
type Tokens = { input_tokens: number; output_tokens: number; cost_usd: number };

function toAttempt(r: RowResult): Attempt {
  return {
    output: r.output,
    cached: r.cached,
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.latency_ms !== undefined ? { latency_ms: r.latency_ms } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    assertions: r.assertions,
    ...(r.cache_saved !== undefined ? { cache_saved: r.cache_saved } : {}),
  };
}

function sumTokens(parts: Tokens[]): Tokens {
  return parts.reduce(
    (a, u) => ({
      input_tokens: a.input_tokens + u.input_tokens,
      output_tokens: a.output_tokens + u.output_tokens,
      cost_usd: a.cost_usd + u.cost_usd,
    }),
    { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  );
}

/** Usage summed over attempts: unpriced if any attempt was, absent `priced` when none said. */
export function sumUsage(parts: Usage[]): Usage {
  const priced = parts.some((u) => u.priced === false)
    ? false
    : parts.some((u) => u.priced === true)
      ? true
      : undefined;
  return { ...sumTokens(parts), ...pricedField(priced) };
}

/**
 * Run one row `runs` times, one attempt after another (rows stay parallel), and give it one verdict:
 * `passed` with at least `needed` passing attempts; else `errored` when the attempts that could not
 * run might still have reached it (a verdict that rests on what was not measured is not a fail);
 * else `failed`. Every attempt runs: stopping once the verdict is settled would lose the flakiness
 * picture. `runs: 1` is `run` itself, with no `attempts` on the row. `run` is `runRow`, or the agentic row.
 */
export async function runRepeats<P extends RowParams>(
  p: P,
  runs: number,
  passThreshold: number,
  run: (p: P) => Promise<RowResult> = runRow,
): Promise<RowResult> {
  if (runs <= 1) return run(p);
  const counts = { runs, pass_threshold: passThreshold, passed: 0, failed: 0, errored: 0 };

  if (p.dryRun) {
    // Nothing runs on a dry run: one estimate, priced for every repeat.
    const one = await run(p);
    const u = one.usage;
    const usage =
      u === undefined
        ? undefined
        : {
            ...u,
            input_tokens: u.input_tokens * runs,
            output_tokens: u.output_tokens * runs,
            cost_usd: u.cost_usd * runs,
          };
    return {
      ...one,
      ...(usage !== undefined ? { usage } : {}),
      attempts: { ...counts, results: [] },
    };
  }

  const rows: RowResult[] = [];
  for (let attempt = 0; attempt < runs; attempt += 1) {
    rows.push(await run({ ...p, attempt }));
  }
  const states = rows.map(rowStatus);
  const passed = states.filter((s) => s === 'passed').length;
  const failed = states.filter((s) => s === 'failed').length;
  const errored = runs - passed - failed;
  const needed = neededPasses(passThreshold, runs);
  const verdict = passed >= needed ? 'passed' : passed + errored >= needed ? 'errored' : 'failed';
  // There is always one: a failed verdict needs a failed attempt, an errored one an errored attempt.
  const shown = rows[states.indexOf(verdict)]!;

  const usages = rows.flatMap((r) => (r.usage !== undefined ? [r.usage] : []));
  const saved = rows.flatMap((r) => (r.cache_saved !== undefined ? [r.cache_saved] : []));
  const latencies = rows.flatMap((r) => (r.latency_ms !== undefined ? [r.latency_ms] : []));
  return {
    vars: p.row.vars,
    output: shown.output,
    cached: rows.every((r) => r.cached),
    ...(usages.length > 0 ? { usage: sumUsage(usages) } : {}),
    ...(latencies.length > 0 ? { latency_ms: latencies.reduce((a, b) => a + b, 0) } : {}),
    ...(saved.length > 0 ? { cache_saved: sumTokens(saved) } : {}),
    ...(shown.error !== undefined ? { error: shown.error } : {}),
    assertions: shown.assertions,
    attempts: { ...counts, passed, failed, errored, results: rows.map(toAttempt) },
    ...(shown.agent !== undefined ? { agent: shown.agent } : {}),
  };
}

// --- runOrchestration: drive evals × rows → RunResult (ADR-OR01/OR02) ---

export interface RunOptions {
  only?: string[];
  dryRun?: boolean;
  concurrency?: number;
  noCache?: boolean;
  bail?: boolean;
  /** `--cache-strict`: every row must come from the cache. Not combinable with `noCache`. */
  cacheStrict?: boolean;
  /** `--cache-max-age`, in ms. */
  cacheMaxAgeMs?: number;
  /** `--runs`: repeats of every row for this run, over `runs` in the config. */
  runs?: number;
}

export interface RunDeps {
  resolveProvider(cfg: ProviderConfig): Provider;
  embedder: Embedder;
  cache: Cache;
  now: () => number;
  loadDataset(ref: DatasetRef, baseDir: string): DatasetRow[];
  baseDir: string;
  /** Opens a session with an `mcp.servers` entry, one per agentic row. Needed only by an eval with `mcp`. */
  connectMcp?: AgentConnect;
}

function selectEvals(evals: EvalConfig[], only: string[] | undefined): EvalConfig[] {
  if (only === undefined || only.length === 0) return evals;
  return evals.filter((ev) =>
    only.some((sel) =>
      sel.startsWith('tag:') ? (ev.tags ?? []).includes(sel.slice(4)) : ev.id === sel,
    ),
  );
}

function resolveTemplate(ev: EvalConfig, baseDir: string): string {
  if (ev.prompt !== undefined) return ev.prompt;
  if (ev.prompt_file !== undefined) {
    try {
      return fs.readFileSync(path.resolve(baseDir, ev.prompt_file), 'utf8');
    } catch {
      throw new RunConfigError(`Eval "${ev.id}": prompt_file not found: ${ev.prompt_file}`);
    }
  }
  throw new RunConfigError(`Eval "${ev.id}" has neither prompt nor prompt_file`);
}

/**
 * The run's counters: every row lands in exactly one of them (plune#1245), by the shared `rowStatus`.
 * `blocked` and `skipped` are always written, so this runner's output never relies on their being
 * optional in the contract.
 */
export function summarize(evals: EvalResult[], durationMs: number): Summary {
  const summary: Required<Omit<Summary, 'cache'>> = {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    blocked: 0,
    skipped: 0,
    cost_usd: 0,
    duration_ms: durationMs,
  };
  const cache: CacheSummary = {
    from_cache: 0,
    from_model: 0,
    missed: 0,
    errored: 0,
    saved: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };
  for (const ev of evals) {
    for (const row of ev.rows) {
      summary.total += 1;
      summary[rowStatus(row)] += 1;
      summary.cost_usd += row.usage?.cost_usd ?? 0;
      // Only a cache hit carries `cache_saved`; a repeated row with some attempts from the cache
      // counts as from the model and still saved what those attempts did not pay.
      cache.saved.input_tokens += row.cache_saved?.input_tokens ?? 0;
      cache.saved.output_tokens += row.cache_saved?.output_tokens ?? 0;
      cache.saved.cost_usd += row.cache_saved?.cost_usd ?? 0;
      if (row.cached) cache.from_cache += 1;
      else if (row.error?.code === CACHE_MISS_CODE) cache.missed += 1;
      else if (row.output !== null) cache.from_model += 1;
      else if (row.error !== undefined) cache.errored += 1;
    }
  }
  return { ...summary, cache };
}

/** The provider of an agentic eval, once the run is known to be able to measure it; a config error otherwise. */
function agenticProvider(
  config: Config,
  ev: EvalConfig,
  deps: RunDeps,
  cacheStrict: boolean,
): Provider {
  if (cacheStrict)
    throw new RunConfigError(
      `Eval "${ev.id}" uses MCP server "${ev.mcp!.server}": its tool loop is never cached, so --cache-strict cannot answer it`,
    );
  const providerConfig: ProviderConfig = { ...config.provider, ...ev.provider };
  const provider = deps.resolveProvider(providerConfig);
  if (provider.respond === undefined)
    throw new RunConfigError(
      `Eval "${ev.id}" uses MCP server "${ev.mcp!.server}", and this provider cannot call tools, so nothing would be measured` +
        ' (under PLUNE_MOCK_PROVIDER=1, PLUNE_MOCK_SCRIPT names the scripted model steps)',
    );
  if (deps.connectMcp === undefined)
    throw new RunConfigError(
      `Eval "${ev.id}" uses MCP server "${ev.mcp!.server}", and this run cannot connect to one`,
    );
  return provider;
}

export async function runOrchestration(
  config: Config,
  options: RunOptions,
  deps: RunDeps,
): Promise<RunResult> {
  const noCache = options.noCache ?? false;
  const cacheStrict = options.cacheStrict ?? false;
  if (noCache && cacheStrict) {
    throw new RunConfigError('--no-cache and --cache-strict cannot be used together');
  }
  if (noCache && options.cacheMaxAgeMs !== undefined) {
    throw new RunConfigError('--no-cache and --cache-max-age cannot be used together');
  }
  if (
    options.runs !== undefined &&
    !(Number.isInteger(options.runs) && options.runs >= 1 && options.runs <= MAX_RUNS)
  ) {
    throw new RunConfigError(`--runs must be a whole number from 1 to ${MAX_RUNS}`);
  }
  const started = deps.now();
  const dryRun = options.dryRun ?? false;
  const evalResults: EvalResult[] = [];

  // Pre-flight (before any provider construction): resolve every template + dataset and validate
  // every prompt. A config error (unknown variable, missing prompt_file) surfaces as exit 2 before
  // a single model call (CLI_SPEC §4.2).
  const prepared = selectEvals(config.evals, options.only).map((ev) => {
    const template = resolveTemplate(ev, deps.baseDir);
    const rows = deps.loadDataset(ev.dataset, deps.baseDir);
    for (const row of rows) {
      resolvePrompt(template, row.vars);
    }
    // An agentic eval is checked here too, so a run that cannot measure it stops before the first model call: its
    // provider must take tools, and it never comes from the cache, so --cache-strict cannot hold for it.
    const agentic =
      ev.mcp === undefined || dryRun ? undefined : agenticProvider(config, ev, deps, cacheStrict);
    return { ev, template, rows, agentic };
  });

  for (const { ev, template, rows, agentic } of prepared) {
    const providerConfig: ProviderConfig = { ...config.provider, ...ev.provider };
    const provider = agentic ?? deps.resolveProvider(providerConfig);
    // Agentic rows call one server whose state they may share: one at a time unless asked otherwise.
    const limit =
      options.concurrency ?? providerConfig.concurrency ?? (ev.mcp !== undefined ? 1 : 4);

    const runs = options.runs ?? ev.runs ?? config.runs ?? 1;
    const passThreshold = ev.pass_threshold ?? config.pass_threshold ?? 1;

    const rowResults = await mapLimit(rows, limit, (row) => {
      const params: RowParams = {
        template,
        // `defaults.assertions` apply to every eval, ahead of its own.
        assertions: [...(config.defaults?.assertions ?? []), ...ev.assertions],
        row,
        providerConfig,
        provider,
        embedder: deps.embedder,
        cache: deps.cache,
        now: deps.now,
        dryRun,
        noCache,
        cacheStrict,
        ...(options.cacheMaxAgeMs !== undefined ? { cacheMaxAgeMs: options.cacheMaxAgeMs } : {}),
      };
      if (ev.mcp === undefined) return runRepeats(params, runs, passThreshold);
      const agentParams: AgentRowParams = {
        ...params,
        server: ev.mcp.server,
        ...(ev.mcp.allowed_tools !== undefined ? { allowedTools: ev.mcp.allowed_tools } : {}),
        limits: mcpLimits(config, ev),
        // A dry run connects nowhere; the loop never calls this then.
        connect: deps.connectMcp ?? (() => Promise.reject(new Error('no MCP connection'))),
      };
      return runRepeats(agentParams, runs, passThreshold, runAgentRow);
    });

    const passed = rowResults.every((r) => rowStatus(r) === 'passed');
    evalResults.push({ id: ev.id, tags: ev.tags ?? [], rows: rowResults, passed });
    if (options.bail === true && !passed) break;
  }

  const finished = deps.now();
  const summary = summarize(evalResults, finished - started);

  return {
    schemaVersion: 1,
    plune_version: PLUNE_VERSION,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
    config_hash: configHash(config),
    summary,
    evals: evalResults,
  };
}
