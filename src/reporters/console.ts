// Console reporter (ADR-RP02). Default: summary + per-eval status + details ONLY for failed/errored
// rows (passing rows collapsed to a count; blocked/skipped rows named, never detailed as failures).
// Color is gated by the injected styler.

import type { RunResult } from '../types/results.js';
import { adviceOf, rowStatus } from '../types/results.js';
import { createStyler } from './style.js';
import { repeatsText, safeLine, truncate } from './helpers.js';
import { buildMatrix, matrixConsole } from './matrix.js';

const DEFAULT_MAX_OUTPUT = 500;

export interface ConsoleOptions {
  color?: boolean;
  maxOutputChars?: number;
}

export function renderConsole(result: RunResult, opts: ConsoleOptions = {}): string {
  const s = createStyler(opts.color ?? false);
  const maxOut = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const { summary } = result;
  const lines: string[] = [];

  if (result.dry_run === true) {
    // Nothing ran: a price and no verdict, so none of the words of a measured run (plune-ai/cli#244).
    lines.push(s.bold('Plune dry run'));
    const matrix = buildMatrix(result);
    // Several models: each cell is priced at its own model's price, and the line says how many there were.
    const across = matrix !== undefined ? ` across ${matrix.models.length} models` : '';
    lines.push(
      `${summary.total} row(s) priced${across}, none measured · estimated $${summary.cost_usd.toFixed(4)}`,
    );
    lines.push('');
    if (matrix !== undefined) lines.push(s.bold('Estimated cost per model'), ...matrixConsole(matrix, true), '');
    for (const ev of result.evals) {
      const tags = ev.tags.length > 0 ? s.dim(` (${ev.tags.join(', ')})`) : '';
      lines.push(`${s.dim('PRICED')} ${s.bold(safeLine(ev.id))}${tags}`);
      for (const row of ev.rows) {
        // Only a repeated row is named: its estimate is one run times `runs`.
        const repeats = repeatsText(row);
        if (repeats === undefined) continue;
        lines.push(`  ${s.dim('vars:')} ${JSON.stringify(row.vars)}`);
        lines.push(`  ${repeats}`);
      }
      lines.push(s.dim(`  ${ev.rows.length} row(s) priced`));
    }
    return lines.join('\n');
  }

  lines.push(s.bold('Plune run'));
  const passedTxt = s.green(`${summary.passed} passed`);
  const failedTxt = summary.failed > 0 ? s.red(`${summary.failed} failed`) : `${summary.failed} failed`;
  const erroredTxt =
    summary.errored > 0 ? s.yellow(`${summary.errored} errored`) : `${summary.errored} errored`;
  // plune#1245: only when not zero, so a run without them reads as it always has.
  const blockedTxt = (summary.blocked ?? 0) > 0 ? ` · ${s.yellow(`${summary.blocked} blocked`)}` : '';
  const skippedTxt = (summary.skipped ?? 0) > 0 ? ` · ${s.dim(`${summary.skipped} skipped`)}` : '';
  lines.push(
    `${passedTxt} · ${failedTxt} · ${erroredTxt}${blockedTxt}${skippedTxt} · ${summary.total} total · $${summary.cost_usd.toFixed(4)} · ${summary.duration_ms}ms`,
  );
  const c = summary.cache;
  if (c !== undefined && c.from_cache + c.from_model + c.missed > 0) {
    const missedTxt = c.missed > 0 ? ` · ${s.yellow(`${c.missed} missed`)}` : '';
    lines.push(
      s.dim(
        `cache: ${c.from_cache} from cache · ${c.from_model} from model${missedTxt} · saved ${c.saved.input_tokens + c.saved.output_tokens} tokens, $${c.saved.cost_usd.toFixed(4)}`,
      ),
    );
  }
  lines.push('');
  const matrix = buildMatrix(result);
  if (matrix !== undefined) lines.push(s.bold('Model matrix'), ...matrixConsole(matrix), '');

  for (const ev of result.evals) {
    const mark = ev.passed ? s.green('PASS') : s.red('FAIL');
    const tags = ev.tags.length > 0 ? s.dim(` (${ev.tags.join(', ')})`) : '';
    lines.push(`${mark} ${s.bold(safeLine(ev.id))}${tags}`);

    let passedCount = 0;
    for (const row of ev.rows) {
      const status = rowStatus(row);
      // A repeated row is always named, a passing one too: its count of passed runs is the result.
      const repeats = repeatsText(row);
      // Heuristic findings: shown on any row, a passing one too, and never a failure.
      const advice = adviceOf(row);
      if (status === 'passed') passedCount += 1;
      if (status === 'passed' && repeats === undefined && advice.length === 0) continue;
      lines.push(`  ${s.dim('vars:')} ${JSON.stringify(row.vars)}`);
      if (repeats !== undefined) lines.push(`  ${repeats}`);
      for (const a of advice)
        lines.push(`  ${s.yellow('advice')} ${safeLine(a.type)}: ${safeLine(a.reason)}`);
      if (status === 'passed') continue;
      if (status === 'blocked' || status === 'skipped') {
        lines.push(`  ${s.yellow(status)} (not judged)`);
        continue;
      }
      if (row.error !== undefined) {
        lines.push(`  ${s.red('error:')} ${row.error.message}`);
        continue;
      }
      const failed = row.assertions.filter((a) => !a.passed);
      if (row.output !== null) {
        lines.push(`  ${s.dim('output:')} ${truncate(row.output, maxOut)}`);
      }
      for (const a of failed) {
        const scoreTxt = a.score !== undefined ? s.dim(` (score ${a.score})`) : '';
        const reasonTxt = a.reason !== undefined ? `: ${a.reason}` : '';
        lines.push(`  ${s.red('x')} ${a.type}${reasonTxt}${scoreTxt}`);
      }
    }
    if (passedCount > 0) {
      lines.push(s.dim(`  ${passedCount} row(s) passed`));
    }
  }

  return lines.join('\n');
}
