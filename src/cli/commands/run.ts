// `plune run` composition root. Loads the config, builds the real dependencies (or injected
// fakes for tests), runs the orchestrator, persists the RunResult for `plune report` (S9), and
// returns it. Exit-code mapping + output live in cli.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { getProvider } from '../../providers/index.js';
import { makeMockProvider } from '../../providers/mock.js';
import { getDefaultEmbedder } from '../../embeddings/index.js';
import { openCache } from '../../cache/index.js';
import { runOrchestration, loadDataset, type RunDeps } from '../../orchestrator/index.js';
import type { Cache } from '../../cache/index.js';
import type { Config } from '../../types/config.js';
import type { RunResult } from '../../types/results.js';

// Used for --dry-run so the run never opens/creates the cache file (FR-8).
const NOOP_CACHE: Cache = { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} };

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
}

function buildRealDeps(config: Config, baseDir: string, dryRun: boolean): RunDeps {
  const dir = path.join(baseDir, '.plune');
  fs.mkdirSync(dir, { recursive: true });
  return {
    resolveProvider: isMockMode(process.env)
      ? () => makeMockProvider()
      : (cfg) => getProvider(cfg, process.env, config.pricing),
    embedder: getDefaultEmbedder(),
    cache: dryRun ? NOOP_CACHE : openCache(path.join(dir, 'cache.db')),
    now: Date.now,
    loadDataset,
    baseDir,
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

  const factory = depsFactory ?? ((c, d) => buildRealDeps(c, d, options.dryRun));
  const deps = factory(config, baseDir);
  try {
    const result = await runOrchestration(
      config,
      {
        dryRun: options.dryRun,
        ...(options.only !== undefined ? { only: options.only } : {}),
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(options.noCache !== undefined ? { noCache: options.noCache } : {}),
        ...(options.bail !== undefined ? { bail: options.bail } : {}),
      },
      deps,
    );
    persist(result, baseDir);
    return result;
  } finally {
    deps.cache.close();
  }
}
