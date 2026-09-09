// `plune run start · finish · exec · report · delete` — driving a platform run from a shell.
//
// The reporter handles the ordinary case, where one process runs the tests and knows when they are
// done. These commands are for the case it cannot see: a CI job whose shards are separate steps,
// a `merge-reports` stage, a suite split across two runners. Something has to open the run before
// any of them start and close it after all of them finish, and that something is a shell command.
//
// `plune run finish` in particular is not optional: the reporter already tells people to run it
// when a run is left open, and a message pointing at a command that does not exist is worse than
// no message.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { resolveApiUrl, dashboardUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import { createClient } from '../../reporter-core/client.js';
import { readEnv } from '../../reporter-core/env.js';
import { DEFAULT_FALLBACK_PATH } from '../../reporter-core/fallback.js';
import { startRun } from '../../reporter-core/session.js';
import type { PendingResult, ResultSubmission } from '../../reporter-core/types.js';

/** No token anywhere. Exit 2 — the user can fix it. */
export class NoTokenError extends Error {
  constructor() {
    super('Not logged in. Run "plune login" first, or set PLUNE_TOKEN.');
    this.name = 'NoTokenError';
  }
}

/** The platform refused or could not be reached. Exit 1 — not the user's to fix. */
export class RunCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCommandError';
  }
}

export interface RunCommandDeps {
  apiUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  write?: (line: string) => void;
  /** Injected so the exec test does not have to spawn a real process. */
  spawnImpl?: typeof spawn;
  /** Injected so a generated key is predictable in a test. */
  now?: () => number;
}

interface Resolved {
  client: ReturnType<typeof createClient>;
  apiUrl: string;
  write: (line: string) => void;
}

function connect(deps: RunCommandDeps): Resolved {
  const env = readEnv();
  const apiUrl = resolveApiUrl(deps.apiUrl ?? env.config.apiUrl);
  const token = deps.token ?? env.config.token ?? loadToken() ?? '';
  if (token === '') throw new NoTokenError();
  return {
    client: createClient({
      apiUrl,
      token,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    apiUrl,
    write: deps.write ?? ((line: string) => void process.stdout.write(`${line}\n`)),
  };
}

/** Where a person goes to look at this run, when we know the shape of the deployment. */
function runUrl(apiUrl: string, id: string): string {
  const web = dashboardUrl(apiUrl);
  return web === undefined ? `${apiUrl}/v1/runs/${id}` : `${web}/runs/${id}`;
}

export interface StartOptions extends RunCommandDeps {
  /** The key several processes share. Generated when absent, so `exec` always has one to pass on. */
  key?: string;
  kind?: 'automated' | 'manual' | 'mixed' | 'eval';
  json?: boolean;
}

export interface StartResult {
  id: string;
  joined: boolean;
  externalKey: string;
  url: string;
}

/** Open a run — or join the one already carrying this key — and say which it was. */
export async function handleRunStart(options: StartOptions = {}): Promise<StartResult> {
  const { client, apiUrl, write } = connect(options);
  const env = readEnv();
  const externalKey =
    options.key ?? env.config.externalKey ?? `plune-${(options.now ?? Date.now)().toString(36)}`;

  const out = await client.post<{ run: { id: string }; joined: boolean }>('/v1/runs', {
    schemaVersion: 2,
    kind: options.kind ?? 'automated',
    externalKey,
  });
  if (!out.ok) throw new RunCommandError(`Could not start the run — ${out.detail || out.kind}.`);

  const result: StartResult = {
    id: out.body.run.id,
    joined: out.status === 200,
    externalKey,
    url: runUrl(apiUrl, out.body.run.id),
  };
  if (options.json === true) {
    write(JSON.stringify(result));
  } else {
    write(`${result.joined ? 'Joined' : 'Started'} run ${result.id}`);
    write(result.url);
  }
  return result;
}

export interface FinishOptions extends RunCommandDeps {
  reason?: string;
  /** `terminate` says the run was cut short; the platform refuses it on a finished run. */
  terminate?: boolean;
}

/**
 * Close a run.
 *
 * A refusal is reported as what it is. The platform answers a 409 with the transitions it WOULD
 * have accepted, and passing that through is the difference between "try again" and "this run was
 * already finished by the merge step".
 */
export async function handleRunFinish(id: string, options: FinishOptions = {}): Promise<void> {
  const { client, write } = connect(options);
  const event = options.terminate === true ? 'terminate' : 'finish';

  const out = await client.post(`/v1/runs/${id}/events`, {
    event,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  });
  if (!out.ok) {
    throw new RunCommandError(
      out.status === 404
        ? `No run '${id}' — check the id, or whether the token belongs to the same project.`
        : `Could not ${event} run ${id} — ${out.detail || out.kind}.`,
    );
  }
  write(`Run ${id} ${event === 'finish' ? 'finished' : 'terminated'}.`);
}

/**
 * `plune run delete <id>` — undo an import from the surface the import happened on (D17).
 *
 * The command exists because the CLI is where the mistake is made. Onboarding a suite is a loop of
 * `plune run import`, and the person doing it for the first time will point it at the wrong file,
 * the wrong `--key` or the wrong directory with probability near one. Sending them to a dashboard to
 * undo what a terminal did is asking them to change tools mid-mistake.
 *
 * No confirmation prompt, deliberately, and for two reasons rather than one. The platform's rule is
 * that deleting your own data needs no permission from us (spec AC-1), and a prompt would be us
 * asking for it back. And this command's natural home is a CI script or a `for` loop over ids, where
 * a prompt is not caution — it is a hang.
 *
 * What makes that safe is the six months on the server, which is why the second line of output says
 * so. Reassurance after the fact is the only kind this command can offer.
 */
export async function handleRunDelete(id: string, options: RunCommandDeps = {}): Promise<void> {
  const { client, write } = connect(options);

  const out = await client.del(`/v1/runs/${encodeURIComponent(id)}`);
  if (!out.ok) {
    throw new RunCommandError(
      out.status === 404
        ? // Three causes, one answer, and the message names all three because the platform will not:
          // a 404 that distinguished "not yours" from "not there" would tell a stranger which ids
          // exist. The person holding the terminal is better served by the list than by a guess.
          `No run '${id}' — check the id, whether the token belongs to the same project, ` +
          `or whether it is already deleted.`
        : `Could not delete run ${id} — ${out.detail || out.kind}.`,
    );
  }
  write(`Run ${id} deleted, with its results and the review-queue entries it produced.`);
  write('Recoverable for six months — ask Plune to put it back.');
}

export interface ExecOptions extends StartOptions {
  /** The command and its arguments, as given after `--`. */
  argv: string[];
}

/**
 * Open a run, run a command inside it, close the run — whatever the command's exit code.
 *
 * The child is told two things: the run key, so any reporter inside it joins rather than creates,
 * and `PLUNE_PROCEED`, so it does not close a run this command is responsible for. Closing happens
 * here even when the command fails, because a failed test run is still a finished one — leaving it
 * open would say "we never found out", which would be a lie.
 */
export async function handleRunExec(options: ExecOptions): Promise<number> {
  const [command, ...args] = options.argv;
  if (command === undefined) throw new RunCommandError('Nothing to run — pass a command after `--`.');

  const run = await handleRunStart(options);
  const spawnImpl = options.spawnImpl ?? spawn;

  const code = await new Promise<number>((resolve) => {
    const child = spawnImpl(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, PLUNE_RUN: run.externalKey, PLUNE_PROCEED: '1' },
    });
    child.on('close', (exitCode) => resolve(exitCode ?? 1));
    child.on('error', () => resolve(1));
  });

  await handleRunFinish(run.id, options);
  return code;
}

interface DeferredLine {
  runId: string | null;
  externalKey: string | null;
  results: (ResultSubmission | PendingResult)[];
}

const isPending = (r: ResultSubmission | PendingResult): r is PendingResult => 'keys' in r;

export interface ReportOptions extends RunCommandDeps {
  /** The JSONL the reporter wrote when it could not send. */
  file?: string;
}

export interface ReportResult {
  batches: number;
  sent: number;
  failed: number;
}

/**
 * Send what the reporter could not.
 *
 * Without this the fallback file is a graveyard: "nothing is lost" would mean the results are on
 * disk in a shape only this codebase understands, which is not the same as not losing them.
 *
 * A line is replayed in whichever shape it was written. One that already has a run and resolved
 * results goes back to that run as it is; one that never reached the platform at all has to open a
 * run and look its tests up first — which is exactly what a session does, so it uses one.
 */
export async function handleRunReport(options: ReportOptions = {}): Promise<ReportResult> {
  const file = options.file ?? DEFAULT_FALLBACK_PATH;
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new RunCommandError(`Nothing to send — no file at ${file}.`);
  }
  const lines = raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as DeferredLine);
  if (lines.length === 0) throw new RunCommandError(`Nothing to send — ${file} is empty.`);

  const { client } = connect(options);
  const result: ReportResult = { batches: lines.length, sent: 0, failed: 0 };

  for (const line of lines) {
    const pending = line.results.filter(isPending);
    const ready = line.results.filter((r): r is ResultSubmission => !isPending(r));

    if (line.runId !== null && ready.length > 0) {
      const out = await client.post(`/v1/runs/${line.runId}/results`, { results: ready });
      if (out.ok) result.sent += ready.length;
      else {
        result.failed += ready.length;
        write(`Could not send ${ready.length} result(s) to run ${line.runId} — ${out.detail || out.kind}.`);
      }
    }

    if (pending.length > 0) {
      // No run, or results that never got as far as a lookup: a session does the whole dance.
      const session = await startRun({
        ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
        ...(options.token !== undefined ? { token: options.token } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(line.externalKey !== null ? { externalKey: line.externalKey } : {}),
        // The replay does not know whether the run is complete, so it must not say that it is.
        log: write,
      });
      for (const r of pending) await session.add(r);
      await session.leaveOpen();
      result.sent += session.stats.accepted + session.stats.duplicate;
      result.failed += session.stats.deferred + session.stats.unresolved;
    }
  }

  // Kept, not deleted: a replay that partly failed must not be the reason the rest disappears.
  // Removing it is the operator's call once the numbers say everything landed.
  write(`Replayed ${result.batches} batch(es) from ${file}: ${result.sent} sent, ${result.failed} not.`);
  return result;
}
