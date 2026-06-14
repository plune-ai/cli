// Console reporter (ADR-RP02). Default: summary + per-eval status + details ONLY for failed/errored
// rows (passing rows collapsed to a count). Color is gated by the injected styler.

import type { RunResult } from '../types/results.js';
import { createStyler } from './style.js';
import { truncate } from './helpers.js';

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

  lines.push(s.bold('Plune run'));
  const passedTxt = s.green(`${summary.passed} passed`);
  const failedTxt = summary.failed > 0 ? s.red(`${summary.failed} failed`) : `${summary.failed} failed`;
  const erroredTxt =
    summary.errored > 0 ? s.yellow(`${summary.errored} errored`) : `${summary.errored} errored`;
  lines.push(
    `${passedTxt} · ${failedTxt} · ${erroredTxt} · ${summary.total} total · $${summary.cost_usd.toFixed(4)} · ${summary.duration_ms}ms`,
  );
  lines.push('');

  for (const ev of result.evals) {
    const mark = ev.passed ? s.green('PASS') : s.red('FAIL');
    const tags = ev.tags.length > 0 ? s.dim(` (${ev.tags.join(', ')})`) : '';
    lines.push(`${mark} ${s.bold(ev.id)}${tags}`);

    let passedCount = 0;
    for (const row of ev.rows) {
      if (row.error !== undefined) {
        lines.push(`  ${s.dim('vars:')} ${JSON.stringify(row.vars)}`);
        lines.push(`  ${s.red('error:')} ${row.error.message}`);
        continue;
      }
      const failed = row.assertions.filter((a) => !a.passed);
      if (failed.length === 0) {
        passedCount += 1;
        continue;
      }
      lines.push(`  ${s.dim('vars:')} ${JSON.stringify(row.vars)}`);
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
