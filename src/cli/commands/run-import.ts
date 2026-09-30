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
import { ciCommit, readEnv } from '../../reporter-core/env.js';
import type { UnofferedWhy } from '../../reporter-core/types.js';

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
  /** Offered tests the platform made cases of outright, because the project trusts this source. */
  created: number;
  /** Unmatched tests the platform would not take — the work a second import still has to do. */
  unoffered: number;
  /** Why, when there are any: the review queue is full, the project is at its case limit, or another reason. */
  unofferedWhy?: UnofferedWhy;
  deferred: number;
  /** The screenshots the report's files hold, as they went to the accepted results (ADR 0040). */
  screenshots: { uploaded: number; skipped: number; failed: number };
  /** Its JSON and plain-text files, kept by path or as a body, counted the same way and apart (plune-ai/plune#928). */
  textFiles: { uploaded: number; skipped: number; failed: number };
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

  const { format, results, ciUrl, ci } = readReport(source, options.file, options.format);
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
      // The CI run the report names, never this machine's: whoever imports may be another job (#790).
      // The commit and branch likewise, where the report names a commit; a report that names none —
      // JUnit's never does — takes this job's own, which is where the tests ran when import follows
      // them in one job (plune-ai/plune#927).
      meta: { runner: format, ...(ciUrl !== undefined ? { ciUrl } : {}), ...ciCommit(ci) },
      log: write,
    },
    // The file is the complete list of what ran, so the platform can resolve every test in one
    // request and derive what never ran from the same list (AC-09/AC-10) — the lazy path would be
    // a lookup per result.
    results.map((r) => r.keys),
  );

  for (const result of results) await session.add(result);
  // Whether THIS process is the one that ends the run. `--key` says several reports belong to one
  // run; it does not say this is the last of them, and only the caller knows that — so the choice
  // stays with the same two variables the Playwright reporter honours, and the answer is the same
  // here as there. Closing regardless is what made `--key` a promise the import could not keep: the
  // first job finished the run and the second was answered 409, its results going to a fallback
  // file while the step stayed green.
  if (env.keepOpen) await session.leaveOpen();
  else await session.finish();

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
    created: stats.created,
    unoffered: stats.unoffered,
    ...(stats.unofferedWhy !== undefined ? { unofferedWhy: stats.unofferedWhy } : {}),
    deferred: stats.deferred,
    screenshots: { ...stats.screenshots },
    textFiles: { ...stats.textFiles },
    unlocatable: results.filter((r) => r.specRef === undefined).length,
    offering: options.create === true,
  };
  for (const line of describe(result, apiUrl)) write(line);
  return result;
}

/**
 * What to do about the tests that could not be offered, by what refused them (cli#71).
 *
 * A case limit is not a queue: approving an entry makes a case, and the platform refuses that the same
 * way, so emptying the queue helps nothing — the way out is fewer cases or a higher limit, which is
 * what the platform's own answer says too. For anything else the platform's reason is the line the
 * session printed with the failure, and there is nothing to add to it that would not be a guess.
 */
const NEXT: Record<UnofferedWhy, string> = {
  queue:
    'the review queue is full. Approve or reject what is waiting, then import this report again to offer the rest.',
  cases:
    'the project is at its test case limit. Delete cases you no longer need, or ask an operator to raise the limit, then import this report again to offer the rest.',
  other: 'the reason is in the "could not offer" line above.',
};

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
    // `Read`, not `Imported`: the verb describes the FILE, which was read whatever happened next.
    // «Imported 555 result(s): 0 accepted, 0 already there, 0 unmatched» was a sentence whose two
    // halves disagreed, and readers stop at the verb — a run that reached nobody read as one that
    // worked (#622).
    // `not delivered` always, zero included (#790): a number that only appears when it is bad is one
    // nobody learns to look for. The `[0-9]+ unmatched` the workflows read stays whole.
    `Read ${result.parsed} result(s) from a ${result.format} report: ` +
      `${result.accepted} accepted, ${result.duplicate} already there, ${result.unresolved} unmatched, ` +
      `${result.deferred} not delivered.`,
  ];
  // The `::warning::` for what was not delivered is the session's, said with its own summary above.
  if (result.conflict > 0 || result.rejected > 0) {
    lines.push(`${result.conflict} conflicted and ${result.rejected} were refused.`);
  }
  // Only for a report that had screenshots — or text files — at all: a JUnit file never does, and a line of
  // zeros under every such import would say nothing. Why one stayed behind is the session's line, said above.
  for (const [counts, noun] of [
    [result.screenshots, 'screenshot'],
    [result.textFiles, 'text file'],
  ] as const) {
    if (counts.uploaded + counts.skipped + counts.failed > 0) {
      lines.push(
        `${counts.uploaded} ${noun}(s) uploaded to their results` +
          (counts.skipped > 0 ? `, ${counts.skipped} skipped` : '') +
          (counts.failed > 0 ? `, ${counts.failed} could not be uploaded` : '') +
          '.',
      );
    }
  }
  if (result.deferred > 0) {
    lines.push(
      `${result.deferred} could not be sent and are in the fallback file — "plune run report" retries them.`,
    );
  }
  // Before the queue lines, and on its own: a trusted source answers the offer instead of queueing
  // it, so a run where everything was created would otherwise fall through to «nothing new to
  // offer — they are already in the review queue», which names a queue these tests never entered.
  if (result.created > 0) {
    lines.push(
      `${result.created} unknown test(s) became cases without review — this project trusts the ` +
        `source. Change that under Settings → Trusted sources.`,
    );
  }
  if (result.offered > 0) {
    lines.push(`${result.offered} unknown test(s) offered to the review queue.`);
    // Both queue lines below carry `created === 0`: with a trusted source the unmatched tests were
    // dealt with, and advice about a queue they never entered sends a reader to an empty screen.
  } else if (result.unresolved > 0 && result.created === 0 && !result.offering) {
    lines.push('Nothing was offered to the review queue — pass --create to propose the unmatched tests.');
  } else if (result.unresolved > 0 && result.created === 0 && result.unoffered === 0) {
    // Offering WAS asked for and nothing was queued, which means these tests are already in the
    // queue or were refused there. Telling someone to pass the flag they just passed reads as the
    // command not having heard them.
    lines.push('Nothing new to offer — the unmatched tests are already in the review queue.');
  }
  // Said last, and said whatever else happened above: this is the only line that describes work
  // still to do. A first import of a mature suite is bigger than the queue holds, so it stops
  // partway — and the number alone is not the message. Without the second sentence a person reads
  // "some did not fit", empties the queue, and never learns that the rest are waiting on a second
  // import they were never asked for (#627). What that sentence says is what refused them: advice
  // about a queue, said over a project at its case limit, sent people to empty a queue that was not
  // the problem (cli#71).
  if (result.unoffered > 0) {
    lines.push(
      `${result.unoffered} more could not be offered — ${NEXT[result.unofferedWhy ?? 'other']}`,
    );
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
