// `plune run import <file>` — take a report another runner wrote and make it a run in Plune.
//
// This is the keyless route into the product. Generating checks is what needs an LLM provider key;
// accounting for checks that already ran needs nothing but the results, and until now the only way
// to hand them over was the Playwright reporter — which made a Playwright-shaped suite the price of
// entry for a tool whose whole subject is somebody else's tests (`plune-ai/cli#29`).
//
// Everything after parsing is the reporter core's, unchanged: the same run lifecycle, the same
// lookup, the same fallback file when the platform is down, the same review-queue offer for a test
// nobody has a case for. What this file adds is a parser and a summary.

import * as fs from 'node:fs';
import { startRun } from '../../reporter-core/session.js';
import { readReport, type ImportFormat } from '../../importers/index.js';
import { NoTokenError, RunCommandError, type RunCommandDeps } from './run-lifecycle.js';
import { resolveApiUrl, dashboardUrl } from '../api-url.js';
import { loadToken } from '../credentials.js';
import { readEnv } from '../../reporter-core/env.js';

export interface ImportOptions extends RunCommandDeps {
  file: string;
  /** Omitted means: work it out from the file's contents. */
  format?: ImportFormat;
  /** The key several jobs share so their reports land in one run. */
  key?: string;
  /** Offer tests that resolved to nothing to the review queue (the `PLUNE_CREATE=1` switch, D14). */
  create?: boolean;
}

export interface ImportResult {
  runId: string | null;
  format: ImportFormat;
  /** Results read out of the file — not results accepted, which is the platform's count. */
  parsed: number;
  accepted: number;
  duplicate: number;
  conflict: number;
  rejected: number;
  unresolved: number;
  offered: number;
  deferred: number;
  /** Tests the report gives no location for, so the queue could never show a reviewer where to look. */
  unlocatable: number;
  /** Whether offering was asked for at all — the difference between «nothing was offered» and
   * «nothing was NEW to offer», which read the same in the summary until a real run said so. */
  offering: boolean;
}

/**
 * Read the file, drive a run, report what happened.
 *
 * The token is checked here rather than left to the session on purpose. A session with no token
 * writes everything to the fallback file and calls that a success — correct for a reporter, whose
 * job is to never break a test run, and wrong for a command a person just typed: they would get a
 * cheerful summary and nothing in Plune.
 */
export async function handleRunImport(options: ImportOptions): Promise<ImportResult> {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));

  let source: string;
  try {
    source = fs.readFileSync(options.file, 'utf8');
  } catch {
    throw new RunCommandError(`Cannot read ${options.file}.`);
  }

  const { format, results } = readReport(source, options.file, options.format);
  if (results.length === 0) {
    throw new RunCommandError(`No test cases in ${options.file} — it parsed, but there is nothing in it.`);
  }

  const env = readEnv();
  const apiUrl = resolveApiUrl(options.apiUrl ?? env.config.apiUrl);
  const token = options.token ?? env.config.token ?? loadToken() ?? '';
  if (token === '') throw new NoTokenError();

  const session = await startRun(
    {
      apiUrl,
      token,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.key !== undefined ? { externalKey: options.key } : {}),
      ...(options.create === true ? { offerDiscovered: true } : {}),
      kind: 'automated',
      meta: { runner: format },
      log: write,
    },
    // The file is the complete list of what ran, so the platform can resolve every test in one
    // request and derive what never ran from the same list (AC-09/AC-10) — the lazy path would be
    // a lookup per result.
    results.map((r) => r.keys),
  );

  for (const result of results) await session.add(result);
  await session.finish();

  const stats = session.stats;
  const result: ImportResult = {
    runId: session.runId,
    format,
    parsed: results.length,
    accepted: stats.accepted,
    duplicate: stats.duplicate,
    conflict: stats.conflict,
    rejected: stats.rejected,
    unresolved: stats.unresolved,
    offered: stats.offered,
    deferred: stats.deferred,
    unlocatable: results.filter((r) => r.specRef === undefined).length,
    offering: options.create === true,
  };
  for (const line of describe(result, apiUrl)) write(line);
  return result;
}

/** Where a person goes to look at what just landed. */
function runUrl(apiUrl: string, id: string): string {
  const web = dashboardUrl(apiUrl);
  return web === undefined ? `${apiUrl}/v1/runs/${id}` : `${web}/runs/${id}`;
}

/**
 * The lines a person reads after the command returns.
 *
 * `unresolved` is named as a number to act on rather than as an error: a first import against a
 * fresh project resolves nothing at all, and that is the normal shape of the first day.
 */
function describe(result: ImportResult, apiUrl: string): string[] {
  const lines = [
    `Imported ${result.parsed} result(s) from a ${result.format} report: ` +
      `${result.accepted} accepted, ${result.duplicate} already there, ${result.unresolved} unmatched.`,
  ];
  if (result.conflict > 0 || result.rejected > 0) {
    lines.push(`${result.conflict} conflicted and ${result.rejected} were refused.`);
  }
  if (result.deferred > 0) {
    lines.push(
      `${result.deferred} could not be sent and are in the fallback file — "plune run report" retries them.`,
    );
  }
  if (result.offered > 0) {
    lines.push(`${result.offered} unknown test(s) offered to the review queue.`);
  } else if (result.unresolved > 0 && !result.offering) {
    lines.push('Nothing was offered to the review queue — pass --create to propose the unmatched tests.');
  } else if (result.unresolved > 0) {
    // Offering WAS asked for and nothing was queued, which means these tests are already in the
    // queue or were refused there. Telling someone to pass the flag they just passed reads as the
    // command not having heard them.
    lines.push('Nothing new to offer — the unmatched tests are already in the review queue.');
  }
  if (result.unlocatable > 0) {
    lines.push(
      `${result.unlocatable} test(s) carry no file or class in the report, so they cannot be offered ` +
        'for review — a reviewer would have nowhere to look.',
    );
  }
  if (result.runId !== null) lines.push(runUrl(apiUrl, result.runId));
  return lines;
}
