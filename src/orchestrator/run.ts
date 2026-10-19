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
}

/** The code on a row left unanswered by `--cache-strict`; the CLI turns these into its own exit code. */
export const CACHE_MISS_CODE = 'CACHE_MISS';

/**
 * Format check for a completion, before it is cached or replayed: an eval with a `json-schema`
 * assertion needs an answer that holds JSON. Whether the JSON fits the schema is a content verdict
 * and is not asked here (ADR 0002 of the completion cache).
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

function toRunError(err: unknown): RunError {
  if (err instanceof ProviderError || err instanceof AuthError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'ERROR', message: err instanceof Error ? err.message : String(err) };
}

function estimateUsage(
  prompt: string,
  maxTokens: number,
): { input_tokens: number; output_tokens: number } {
  return { input_tokens: Math.ceil(prompt.length / 4), output_tokens: maxTokens };
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
    const usage: Usage = { ...est, cost_usd: p.provider.estimateCost(est).cost_usd };
    return { vars: p.row.vars, output: null, cached: false, usage, assertions: [] };
  }

  // The key keeps the old default so a cache written before the change still answers.
  const key = cacheKey(
    {
      provider: p.providerConfig.type,
      model: p.providerConfig.model,
      temperature: temperature ?? 0,
      max_tokens: maxTokens,
      prompt_resolved: prompt,
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
    p.cache.delete(key);
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
      usage = {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        // Prefer the provider-reported actual cost (res.cost_usd) when present; resolveCost still
        // lets a config pricing override win, else falls back to the table estimate (ADR-PRC01).
        cost_usd: p.provider.estimateCost(res.usage, res.cost_usd).cost_usd,
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

  // Row-local judge so judge-call cost is attributed to this row (ADR-OR02).
  let judgeCost = 0;
  const judge = buildJudge(p.provider, p.providerConfig, (u) => {
    judgeCost += p.provider.estimateCost(u).cost_usd;
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

  const finalUsage: Usage = { ...usage, cost_usd: usage.cost_usd + judgeCost };
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
}

export interface RunDeps {
  resolveProvider(cfg: ProviderConfig): Provider;
  embedder: Embedder;
  cache: Cache;
  now: () => number;
  loadDataset(ref: DatasetRef, baseDir: string): DatasetRow[];
  baseDir: string;
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
    saved: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  };
  for (const ev of evals) {
    for (const row of ev.rows) {
      summary.total += 1;
      summary[rowStatus(row)] += 1;
      summary.cost_usd += row.usage?.cost_usd ?? 0;
      if (row.cached) {
        cache.from_cache += 1;
        cache.saved.input_tokens += row.cache_saved?.input_tokens ?? 0;
        cache.saved.output_tokens += row.cache_saved?.output_tokens ?? 0;
        cache.saved.cost_usd += row.cache_saved?.cost_usd ?? 0;
      } else if (row.error?.code === CACHE_MISS_CODE) cache.missed += 1;
      else if (row.output !== null) cache.from_model += 1;
    }
  }
  return { ...summary, cache };
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
    return { ev, template, rows };
  });

  for (const { ev, template, rows } of prepared) {
    const providerConfig: ProviderConfig = { ...config.provider, ...ev.provider };
    const provider = deps.resolveProvider(providerConfig);
    const limit = options.concurrency ?? providerConfig.concurrency ?? 4;

    const rowResults = await mapLimit(rows, limit, (row) =>
      runRow({
        template,
        assertions: ev.assertions,
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
      }),
    );

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
