// Orchestration pipeline (ADR-OR01/OR02). `runRow` handles one dataset row; `runOrchestration`
// (below) drives evals × rows. Pure given injected deps — no direct I/O here (the CLI composition
// root in cli/commands/run.ts wires the real provider/cache/embedder).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheKey, configHash } from '../util/hash.js';
import { getAssertion } from '../assertions/index.js';
import { buildJudge } from './judge.js';
import { mapLimit } from './concurrency.js';
import { ProviderError, AuthError } from '../providers/errors.js';
import type {
  AssertionResultRecord,
  EvalResult,
  RowResult,
  RunError,
  RunResult,
  Summary,
  Usage,
} from '../types/results.js';
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
  const temperature = p.providerConfig.temperature ?? 0;
  const maxTokens = p.providerConfig.max_tokens ?? DEFAULT_MAX_TOKENS;

  // --dry-run: estimate cost only; never touch the network or cache (FR-8).
  if (p.dryRun) {
    const est = estimateUsage(prompt, maxTokens);
    const usage: Usage = { ...est, cost_usd: p.provider.estimateCost(est).cost_usd };
    return { vars: p.row.vars, output: null, cached: false, usage, assertions: [] };
  }

  const key = cacheKey({
    provider: p.providerConfig.type,
    model: p.providerConfig.model,
    temperature,
    max_tokens: maxTokens,
    prompt_resolved: prompt,
  });

  let output: string;
  let usage: Usage;
  let cached = false;

  const hit = p.noCache ? undefined : p.cache.get(key);
  if (hit !== undefined) {
    output = hit.output;
    cached = true;
    usage = {
      input_tokens: hit.usage.input_tokens,
      output_tokens: hit.usage.output_tokens,
      cost_usd: 0,
    };
  } else {
    try {
      const res = await p.provider.complete({
        provider: p.providerConfig.type,
        model: p.providerConfig.model,
        temperature,
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
      if (!p.noCache) p.cache.set(key, res);
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

function classify(row: RowResult): 'passed' | 'failed' | 'errored' {
  if (row.error !== undefined) return 'errored';
  if (row.assertions.some((a) => !a.passed)) return 'failed';
  return 'passed';
}

export async function runOrchestration(
  config: Config,
  options: RunOptions,
  deps: RunDeps,
): Promise<RunResult> {
  const started = deps.now();
  const dryRun = options.dryRun ?? false;
  const noCache = options.noCache ?? false;
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
      }),
    );

    const passed = rowResults.every((r) => classify(r) === 'passed');
    evalResults.push({ id: ev.id, tags: ev.tags ?? [], rows: rowResults, passed });
    if (options.bail === true && !passed) break;
  }

  const finished = deps.now();
  const summary: Summary = {
    total: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    cost_usd: 0,
    duration_ms: finished - started,
  };
  for (const ev of evalResults) {
    for (const row of ev.rows) {
      summary.total += 1;
      summary[classify(row)] += 1;
      summary.cost_usd += row.usage?.cost_usd ?? 0;
    }
  }

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
