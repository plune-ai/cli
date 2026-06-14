// Public surface of the reporters module. A pure dispatcher over the three format renderers
// (ADR-RP02). The CLI owns all I/O (reading last-run.json, color detection, writing stdout/-o).

import type { RunResult } from '../types/results.js';
import { renderConsole } from './console.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';

export type ReportFormat = 'console' | 'json' | 'markdown';

export interface RenderOptions {
  color?: boolean;
  maxOutputChars?: number;
}

export function renderReport(
  result: RunResult,
  format: ReportFormat,
  opts: RenderOptions = {},
): string {
  if (format === 'json') return renderJson(result);
  if (format === 'markdown') return renderMarkdown(result, opts);
  return renderConsole(result, opts); // 'console' (default)
}

export { renderConsole } from './console.js';
export { renderJson } from './json.js';
export { renderMarkdown } from './markdown.js';
