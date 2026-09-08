import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PendingResult, ResultSubmission } from './types.js';

/**
 * What ends up in a deferred batch.
 *
 * Two shapes, because two things can fail. A batch refused by the platform is already resolved
 * (`ResultSubmission`), and replay sends it as it is. A batch deferred because the platform was
 * never reached has not been resolved at all (`PendingResult`), and replay has to look its keys
 * up first. Flattening them into one shape would mean inventing a `testCaseId` for the second
 * case, which is exactly what AC-11 forbids.
 */
export type DeferredResult = ResultSubmission | PendingResult;

/** Beside `last-run.json`, because that is where a Plune user already looks for a run. */
export const DEFAULT_FALLBACK_PATH = path.join('.plune', 'pending-results.jsonl');

/**
 * One batch that could not be sent.
 *
 * A batch rather than a result: the batch is the unit that failed, and it is the unit `plune run
 * report` will re-send unchanged. Splitting it into results here would mean re-grouping them there
 * against a size the platform may have changed in the meantime.
 *
 * `runId: null` is a real state, not a missing value — the platform was unreachable when the run
 * was supposed to be created, so these results have no run yet and replay has to make one.
 */
export interface DeferredBatch {
  runId: string | null;
  externalKey: string | null;
  results: DeferredResult[];
}

/**
 * Append a batch to the fallback file, creating its directory if nobody has yet.
 *
 * JSONL and synchronous, both for the same reason: a run is being abandoned when this is called,
 * and the next thing to happen may be the process dying. A line that is already flushed stays
 * readable no matter what happens to the ones after it, which one large JSON document rewritten
 * on every batch would not.
 *
 * Nothing about the connection goes in — not the token, not the headers, not the config. The line
 * holds who the run was and what did not reach it, which is exactly what replaying needs.
 */
export function appendBatch(file: string, batch: DeferredBatch): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line: DeferredBatch & { ts: string } = {
    ts: new Date().toISOString(),
    runId: batch.runId,
    externalKey: batch.externalKey,
    results: batch.results,
  };
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
}
