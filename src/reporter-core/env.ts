import type { ReporterConfig } from './types.js';

/**
 * What a CI job can tell the reporter without editing a config file.
 *
 * A Playwright config is committed; a CI job is not. Everything here exists so a pipeline can set
 * the shared run key, the token and the batch size per job — the things that differ between the
 * laptop the config was written on and the runner it executes on.
 */

/**
 * Names the reporter promises but the platform cannot yet store.
 *
 * They are listed rather than ignored because of how they would fail otherwise: a run's `meta`
 * strips keys it does not know, so sending one there would be accepted, dropped, and look exactly
 * like success. A client believing it saved something the server discarded is the most expensive
 * kind of quiet — cheaper to say "not yet" out loud.
 *
 * `PLUNE_RUN_TITLE`, `PLUNE_ENV` and `PLUNE_LABELS` left this list when D13 gave a run somewhere to
 * put them. `PLUNE_GROUP` stays: a run group is D6's, and a group of one run means nothing.
 */
export const UNSUPPORTED_VARS = ['PLUNE_GROUP'] as const;

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

/**
 * `PLUNE_LABELS=smoke,nightly` — the separator every CI templating language can produce without
 * quoting rules. Blanks are dropped rather than sent: `a,,b` is a template that had nothing for the
 * middle slot, not a request for an empty label.
 *
 * Nothing is capped or truncated here on purpose. The platform states the limits and refuses what
 * exceeds them by name (ADR 0012 — one side owns the contract), and a refusal is loud and costs no
 * results: the run fails to start, the reporter says why, and every result goes to the fallback
 * file. A client-side copy of the caps would be a second place for them to drift.
 */
function list(env: NodeJS.ProcessEnv, name: string): string[] | undefined {
  const raw = value(env, name);
  if (raw === undefined) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  return items.length === 0 ? undefined : items;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvSettings {
  const externalKey = value(env, 'PLUNE_RUN');
  const token = value(env, 'PLUNE_TOKEN');
  const apiUrl = value(env, 'PLUNE_API_URL');
  const fallbackPath = value(env, 'PLUNE_FALLBACK');
  const batchSize = count(env, 'PLUNE_BATCH_SIZE');
  const title = value(env, 'PLUNE_RUN_TITLE');
  const environment = value(env, 'PLUNE_ENV');
  const labels = list(env, 'PLUNE_LABELS');
  // Rung 6 of the C2 ladder, unblocked by D14. Read as a flag rather than by presence for the same
  // reason as the others: `PLUNE_CREATE=0` in one matrix cell must mean off.
  const offerDiscovered = flag(env, 'PLUNE_CREATE');

  return {
    config: {
      ...(externalKey !== undefined ? { externalKey } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(apiUrl !== undefined ? { apiUrl } : {}),
      ...(fallbackPath !== undefined ? { fallbackPath } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(labels !== undefined ? { labels } : {}),
      // Only when set: `false` here would outrank a config file that asked for it, and an unset
      // variable is not an instruction.
      ...(offerDiscovered ? { offerDiscovered } : {}),
    },
    // Two names for two situations that end the same way. `SHARED_RUN` says other processes are
    // reporting into this run; `PROCEED` says the job will close it on its own schedule. Either
    // way this process must not be the one to call it finished.
    keepOpen: flag(env, 'PLUNE_SHARED_RUN') || flag(env, 'PLUNE_PROCEED'),
    ignored: UNSUPPORTED_VARS.filter((name) => value(env, name) !== undefined),
  };
}
