// Placeholder interpolation for assertion params (ADR-AP03). Pure — no I/O.
// Resolves {{expected}} (from the dataset row) and {{vars.X}} (from the row's variables).
// Unknown placeholders are left literal; {{expected}} with no value renders as ''.

import type { AssertionContext } from '../types/assertion.js';

type InterpolationCtx = Pick<AssertionContext<unknown>, 'vars' | 'row'>;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

export function interpolate(template: string, ctx: InterpolationCtx): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    if (key === 'expected') {
      return ctx.row.expected ?? '';
    }
    if (key.startsWith('vars.')) {
      const name = key.slice('vars.'.length);
      const value = ctx.vars[name];
      return value === undefined ? match : String(value);
    }
    return match; // unknown placeholder → leave literal
  });
}
