import * as path from 'node:path';
import type { ReporterConfig, RunMeta } from './types.js';

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
 *
 * The two sizes the core does hold are not such copies: a results batch's 8 MiB and a failure text's
 * 512 KB (#790, ADR-0006 of that feature) are this client's own transport limits, set under the
 * platform's caps rather than equal to them — the numbers may drift apart and nothing breaks.
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
  // The claim that this run is the whole suite (D20). Same rule: only `1`/`true` means it, and only
  // the job that runs everything should say so — a filtered run with this set detaches the rest.
  const full = flag(env, 'PLUNE_FULL_RUN');

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
      ...(full ? { full } : {}),
    },
    // Two names for two situations that end the same way. `SHARED_RUN` says other processes are
    // reporting into this run; `PROCEED` says the job will close it on its own schedule. Either
    // way this process must not be the one to call it finished.
    keepOpen: flag(env, 'PLUNE_SHARED_RUN') || flag(env, 'PLUNE_PROCEED'),
    ignored: UNSUPPORTED_VARS.filter((name) => value(env, name) !== undefined),
  };
}

/**
 * What a run is called when nobody named it: `plune · 2026-09-15 15:26 · ci`.
 *
 * The three things a row in the list has to say without being opened — whose, when, from where. The
 * job id and the epoch the names used to end in are identifiers for machines: `plune — 34968238614`
 * tells a person nothing about when it ran, and two runs of one day were told apart by nothing. The
 * id keeps living in the external key and the meta, where it is looked up, not read.
 *
 * The clock is the reporting machine's own, to the minute — the one the person who started the run
 * is looking at. The prefix is the directory, which is what they call the project at the prompt;
 * `PLUNE_RUN_TITLE` (or `title` in the config) replaces the whole thing. `ci` / `local` comes from
 * `CI`, which every hosted runner sets, and `GITHUB_ACTIONS` for the one that matters here.
 */
export function defaultRunTitle(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  cwd: string = process.cwd(),
): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ` +
    `${two(now.getHours())}:${two(now.getMinutes())}`;
  const where = flag(env, 'CI') || flag(env, 'GITHUB_ACTIONS') ? 'ci' : 'local';
  return `${path.basename(cwd)} · ${stamp} · ${where}`;
}

/**
 * Where a CI job says its commit and its branch are: the variables of the three CIs Playwright's own
 * `metadata.ci` knows (`ciInfo()`), each found the way Playwright finds it. A variable counts only in a
 * job that says which CI it is (`GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`): `GIT_COMMIT` and
 * `GIT_BRANCH` are names any tool uses, and a laptop that exports them is not running a build.
 *
 * On GitHub a pull request's branch is `GITHUB_HEAD_REF`, which a push leaves empty — the branch is then
 * the ref name; a pull request's `GITHUB_REF_NAME` is `12/merge`. Its `GITHUB_SHA` is the commit GitHub
 * merged to run the checks on, which is what ran, and so what is reported.
 */
const PROVIDERS = [
  { is: 'GITHUB_ACTIONS', sha: 'GITHUB_SHA', branch: ['GITHUB_HEAD_REF', 'GITHUB_REF_NAME'] },
  { is: 'GITLAB_CI', sha: 'CI_COMMIT_SHA', branch: ['CI_COMMIT_REF_NAME'] },
  { is: 'JENKINS_URL', sha: 'GIT_COMMIT', branch: ['GIT_BRANCH'] },
] as const;

/**
 * The commit and the branch a run belongs to (plune-ai/plune#927), for `meta.sha` and `meta.branch`.
 *
 * `reported` is what the runner said about its CI — Playwright's `metadata.ci`, or the copy of it in
 * its JSON report — and outranks the job's variables: it is a project's own word where the CI is one
 * Playwright does not know, and it is where the tests ran when another job imports the report. So a
 * report naming a commit other than this job's gets that commit and no branch of this job's: half of
 * each would be a commit on a branch it is not on. Playwright gives no branch on GitHub at all, which
 * is why the job's variables are read there.
 *
 * Each field is present only when something said it: outside a CI there is nothing to say, and nothing
 * is guessed.
 */
export function ciCommit(
  reported?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Pick<RunMeta, 'sha' | 'branch'> {
  const said =
    typeof reported === 'object' && reported !== null ? (reported as Record<string, unknown>) : {};
  const text = (raw: unknown): string | undefined =>
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  const provider = PROVIDERS.find((p) => value(env, p.is) !== undefined);
  const job = {
    sha: provider === undefined ? undefined : value(env, provider.sha),
    branch: provider?.branch.map((name) => value(env, name)).find((v) => v !== undefined),
  };

  const sha = text(said['commitHash']);
  const sameCommit = sha === undefined || sha === job.sha;
  const commit = sha ?? job.sha;
  const branch = text(said['branch']) ?? (sameCommit ? job.branch : undefined);
  return {
    ...(commit !== undefined ? { sha: commit } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
}
