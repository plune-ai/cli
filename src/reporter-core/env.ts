import type { ReporterConfig } from './types.js';

/**
 * What a CI job can tell the reporter without editing a config file.
 *
 * A Playwright config is committed; a CI job is not. Everything here exists so a pipeline can set
 * the shared run key, the token and the batch size per job — the things that differ between the
 * laptop the config was written on and the runner it executes on.
 */

/**
 * Names the reporter promises but the platform cannot yet store (feature D13).
 *
 * They are listed rather than ignored because of how they would fail otherwise: a run's `meta`
 * strips keys it does not know, so sending `PLUNE_ENV` there would be accepted, dropped, and look
 * exactly like success. A client believing it saved something the server discarded is the most
 * expensive kind of quiet — cheaper to say "not yet" out loud.
 */
export const UNSUPPORTED_VARS = [
  'PLUNE_RUN_TITLE',
  'PLUNE_ENV',
  'PLUNE_LABELS',
  'PLUNE_GROUP',
] as const;

export interface EnvSettings {
  /** Config fields the environment supplied. Anything passed explicitly outranks these. */
  config: Partial<ReporterConfig>;
  /** This process must not close the run — several share it, or the job closes it itself. */
  keepOpen: boolean;
  /** Variables that were set and have nowhere to land. The caller says so once. */
  ignored: string[];
}

/** A variable that is set but blank is what a CI template leaves when it had no value to give. */
function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

/** By value, not by presence: `PLUNE_PROCEED=0` in a matrix cell means off, not on. */
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = value(env, name)?.toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function count(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = value(env, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvSettings {
  const externalKey = value(env, 'PLUNE_RUN');
  const token = value(env, 'PLUNE_TOKEN');
  const apiUrl = value(env, 'PLUNE_API_URL');
  const fallbackPath = value(env, 'PLUNE_FALLBACK');
  const batchSize = count(env, 'PLUNE_BATCH_SIZE');

  return {
    config: {
      ...(externalKey !== undefined ? { externalKey } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(apiUrl !== undefined ? { apiUrl } : {}),
      ...(fallbackPath !== undefined ? { fallbackPath } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
    },
    // Two names for two situations that end the same way. `SHARED_RUN` says other processes are
    // reporting into this run; `PROCEED` says the job will close it on its own schedule. Either
    // way this process must not be the one to call it finished.
    keepOpen: flag(env, 'PLUNE_SHARED_RUN') || flag(env, 'PLUNE_PROCEED'),
    ignored: UNSUPPORTED_VARS.filter((name) => value(env, name) !== undefined),
  };
}
