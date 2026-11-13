// `plune run` composition root. Loads the config, builds the real dependencies (or injected
// fakes for tests), runs the orchestrator, persists the RunResult for `plune report` (S9) unless it
// is a dry run, and returns it. Exit-code mapping + output live in cli.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { mcpSecretWarnings, resolveMcpServer } from '../../config/mcp.js';
import { selfJudgeWarnings } from '../../config/model-matrix.js';
import { getProvider } from '../../providers/index.js';
import { makeEstimateProvider } from '../../providers/estimate.js';
import { makeMockProvider, parseMockScript, type MockStep } from '../../providers/mock.js';
import { getDefaultEmbedder } from '../../embeddings/index.js';
import { openCache } from '../../cache/index.js';
import {
  runOrchestration,
  loadDataset,
  RunConfigError,
  type AgentConnect,
  type RunDeps,
} from '../../orchestrator/index.js';
import type { Cache } from '../../cache/index.js';
import type { Config } from '../../types/config.js';
import type { AgentRecord, RunResult } from '../../types/results.js';

// Used for --dry-run so the run never opens/creates the cache file (FR-8).
const NOOP_CACHE: Cache = { get: () => undefined, set: () => {}, delete: () => {}, clear: () => {}, close: () => {} };

/**
 * True when the E2E mock provider is active (PLUNE_MOCK_PROVIDER=1). In this mode buildRealDeps
 * resolves a deterministic, network-free provider for ANY config (ADR-S10-04) — the registry and
 * pure core stay untouched; the switch lives only here, at the dirty edge.
 */
export function isMockMode(env: NodeJS.ProcessEnv): boolean {
  return env['PLUNE_MOCK_PROVIDER'] === '1';
}

export interface RunOptions {
  dryRun: boolean;
  configPath?: string;
  only?: string[];
  concurrency?: number;
  noCache?: boolean;
  bail?: boolean;
  cacheStrict?: boolean;
  /** Milliseconds; parsed from `--cache-max-age` by the caller. */
  cacheMaxAgeMs?: number;
  /** `--runs`: every row runs this many times (1–100), over `runs` in the config. */
  runs?: number;
  /** `--tool-description`, each as typed: `<tool>=<text>` or `<tool>=@<file>`. */
  toolDescription?: string[];
}

/** The most of one description the model is shown from `--tool-description`: it goes into every request. */
export const MAX_DESCRIPTION_BYTES = 64 * 1024;

/** `--tool-description` values to tool name → text; a bad one is a config error (exit 2). `@file` is read from the working directory. */
export function parseToolDescriptions(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const eq = v.indexOf('=');
    const tool = eq < 0 ? '' : v.slice(0, eq).trim();
    let text = eq < 0 ? '' : v.slice(eq + 1);
    if (tool === '' || text === '')
      throw new RunConfigError(
        `--tool-description must be <tool>=<text> or <tool>=@<file> (got "${tool === '' ? v : tool + '='}")`,
      );
    if (Object.hasOwn(out, tool))
      throw new RunConfigError(`--tool-description names "${tool}" twice`);
    if (text.startsWith('@')) {
      const file = text.slice(1);
      try {
        const full = path.resolve(file);
        const stat = fs.statSync(full);
        if (!stat.isFile())
          throw new RunConfigError(`--tool-description ${tool}: ${file} is not a file`);
        // Checked before the read, so a huge file is never loaded.
        if (stat.size > MAX_DESCRIPTION_BYTES)
          throw new RunConfigError(`--tool-description ${tool}: ${file} is over 64 KB`);
        text = fs.readFileSync(full, 'utf8').replace(/\r?\n$/, '');
      } catch (err) {
        if (err instanceof RunConfigError) throw err;
        throw new RunConfigError(`--tool-description ${tool}: cannot read ${file}`);
      }
      if (text === '') throw new RunConfigError(`--tool-description ${tool}: ${file} is empty`);
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_DESCRIPTION_BYTES)
      throw new RunConfigError(`--tool-description ${tool}: the text is over 64 KB`);
    out[tool] = text;
  }
  return out;
}

/** `PLUNE_MOCK_SCRIPT`: the scripted model steps of an agentic eval under the mock provider; a config error if unreadable. */
function mockScript(env: NodeJS.ProcessEnv): MockStep[] | undefined {
  const file = env['PLUNE_MOCK_SCRIPT'];
  if (file === undefined || file === '') return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    throw new RunConfigError(`PLUNE_MOCK_SCRIPT: cannot read ${file}`);
  }
  try {
    return parseMockScript(text);
  } catch (err) {
    throw new RunConfigError(`PLUNE_MOCK_SCRIPT: ${file} ${(err as Error).message}`);
  }
}

/**
 * One session per agentic row with a server of `mcp.servers`, through the connection core of `plune mcp`. The core
 * (and the MCP client) is loaded on the first row that needs it, so a run without `mcp` never loads it. The only
 * network it opens is the server's: a stdio process, or the `url` the config names, which alone gets the headers.
 */
export function makeMcpConnect(config: Config, baseDir: string, env: NodeJS.ProcessEnv): AgentConnect {
  return async (name, timeoutMs) => {
    const server = config.mcp?.servers[name];
    if (server === undefined) throw new Error(`mcp.servers has no "${name}"`);
    const target = resolveMcpServer(server, env, baseDir);
    const [{ openSession }, { listAll, callTool }] = await Promise.all([
      import('../../mcp-testing/connect/session.js'),
      import('../../mcp-testing/connect/tools.js'),
    ]);
    const session = await openSession({ target, timeoutMs });
    return {
      redact: session.redact,
      listTools: async (ms) => (await listAll(session, 'tools/list', 'tools', { timeoutMs: ms })).items,
      callTool: (tool, args, ms) => callTool(session, tool, ms, args),
      close: () => session.close(),
    };
  };
}

function resolveProviderFor(config: Config, dryRun: boolean): RunDeps['resolveProvider'] {
  if (isMockMode(process.env)) {
    const script = mockScript(process.env);
    return () => makeMockProvider(script);
  }
  // A dry run prices a call and never makes one (FR-8), so it has no use for a provider key (#49).
  if (dryRun) return (cfg) => makeEstimateProvider(cfg, config.pricing);
  return (cfg) => getProvider(cfg, process.env, config.pricing);
}

function buildRealDeps(config: Config, baseDir: string, dryRun: boolean): RunDeps {
  const dir = path.join(baseDir, '.plune');
  fs.mkdirSync(dir, { recursive: true });
  return {
    resolveProvider: resolveProviderFor(config, dryRun),
    embedder: getDefaultEmbedder(),
    cache: dryRun ? NOOP_CACHE : openCache(path.join(dir, 'cache.db')),
    now: Date.now,
    loadDataset,
    baseDir,
    connectMcp: makeMcpConnect(config, baseDir, process.env),
  };
}

function persist(result: RunResult, baseDir: string): void {
  const dir = path.join(baseDir, '.plune');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'last-run.json'), JSON.stringify(result, null, 2));
}

export async function handleRun(
  options: RunOptions,
  depsFactory?: (config: Config, baseDir: string) => RunDeps,
): Promise<RunResult> {
  const config = await loadConfig(
    options.configPath !== undefined ? { configPath: options.configPath } : {},
  );
  const baseDir =
    options.configPath !== undefined
      ? path.dirname(path.resolve(options.configPath))
      : process.cwd();
  // Advice, never a gate: it does not change the exit code.
  for (const warning of [...mcpSecretWarnings(config), ...selfJudgeWarnings(config)])
    process.stderr.write(`warning: ${warning}\n`);

  const toolDescriptions =
    options.toolDescription !== undefined && options.toolDescription.length > 0
      ? parseToolDescriptions(options.toolDescription)
      : undefined;
  const factory = depsFactory ?? ((c, d) => buildRealDeps(c, d, options.dryRun));
  const deps = factory(config, baseDir);
  try {
    // Once per run, on stderr so a --format json report on stdout stays clean.
    const stale = deps.cache.staleEntries ?? 0;
    if (stale > 0) {
      process.stderr.write(`cache policy changed, ${stale} entries are stale (dropped)\n`);
    }
    const result = await runOrchestration(
      config,
      {
        dryRun: options.dryRun,
        ...(options.only !== undefined ? { only: options.only } : {}),
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(options.noCache !== undefined ? { noCache: options.noCache } : {}),
        ...(options.bail !== undefined ? { bail: options.bail } : {}),
        ...(options.cacheStrict === true ? { cacheStrict: true } : {}),
        ...(options.cacheMaxAgeMs !== undefined ? { cacheMaxAgeMs: options.cacheMaxAgeMs } : {}),
        ...(options.runs !== undefined ? { runs: options.runs } : {}),
        ...(toolDescriptions !== undefined ? { toolDescriptions } : {}),
      },
      deps,
    );
    // A name no row's server offered changed nothing: said, so an experiment is not read as run when it was not.
    for (const tool of Object.keys(toolDescriptions ?? {})) {
      const used = result.evals.some((ev) =>
        ev.rows.some((r) =>
          ((r.agent as AgentRecord | undefined)?.description_overrides ?? []).some(
            (o) => o.tool === tool,
          ),
        ),
      );
      if (!used && !options.dryRun)
        process.stderr.write(
          `warning: --tool-description ${tool}: no row offered a tool of that name, nothing was replaced\n`,
        );
    }
    if (options.dryRun) {
      const agentic = new Set(config.evals.filter((ev) => ev.mcp !== undefined).map((ev) => ev.id));
      if (result.evals.some((ev) => agentic.has(ev.id)))
        process.stderr.write(
          'dry run: an eval with mcp is priced as max_steps model calls of its prompt; tool schemas and tool results are not counted\n',
        );
    }
    // A dry run measured nothing, so it is not the last run: what `plune report`, `sync` and `diff`
    // read stays the last measured one (plune-ai/cli#244).
    if (result.dry_run !== true) persist(result, baseDir);
    return result;
  } finally {
    deps.cache.close();
  }
}
