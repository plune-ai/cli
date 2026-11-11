/**
 * Pagination: every declared list followed to its end (PAGE_LIMIT pages at most), and a list request with a cursor the
 * server never gave.
 */

import type { ConformanceCheck, ConformanceContext } from './index.js';
import { call, declares, failed, isObject, label, notDeclared, notOffered, passed, said, walk, PAGE_LIMIT } from './wire.js';

/** The lists the declared capabilities give: [capability, method, field]. */
function lists(ctx: ConformanceContext): [string, string, string][] {
  const all: [string, string, string][] = [
    ['tools', 'tools/list', 'tools'],
    ['resources', 'resources/list', 'resources'],
    ['resources', 'resources/templates/list', 'resourceTemplates'],
    ['prompts', 'prompts/list', 'prompts'],
  ];
  return all.filter(([cap]) => declares(ctx, cap));
}

const walkComplete: ConformanceCheck = async (ctx) => {
  const declared = lists(ctx);
  if (declared.length === 0) return notDeclared('tools, resources or prompts');
  const problems: string[] = [];
  const walked: string[] = [];
  for (const [, method, field] of declared) {
    const w = await walk(ctx, method, field);
    if (w.stop !== undefined || w.badPage !== undefined) continue; // another check judges a refused list
    walked.push(`${method} ${w.pages.length} page(s)`);
    if (w.repeatedCursor) problems.push(`${method} gave a nextCursor it had given before`);
    else if (!w.ended) problems.push(`${method} did not end within ${PAGE_LIMIT} pages`);
    // An entry on two pages: the same key on a later page than its first.
    const firstPage = new Map<string, number>();
    const repeated = new Set<string>();
    w.pages.forEach((page, p) =>
      page.forEach((item, i) => {
        const key = isObject(item) ? label(item, i) : undefined;
        if (key === undefined || key.startsWith('#')) return;
        const at = firstPage.get(key);
        if (at === undefined) firstPage.set(key, p);
        else if (at !== p) repeated.add(key);
      }),
    );
    if (repeated.size > 0) problems.push(`${method} gave ${[...repeated].slice(0, 3).join(', ')} on more than one page`);
  }
  if (problems.length > 0)
    return failed(`${problems.join('; ')}.`, 'Give stable cursors: each page continues the last, and the last page has no nextCursor.');
  if (walked.length === 0) return notOffered('No declared list answered with a result to follow.');
  return passed(`Followed to the end, no entry twice: ${walked.join(', ')}.`);
};

const invalidCursor: ConformanceCheck = async (ctx) => {
  const declared = lists(ctx);
  const [, method, field] = declared[0] ?? [];
  if (method === undefined || field === undefined) return notDeclared('tools, resources or prompts');
  const a = await call(ctx, method, { cursor: 'plune-conformance-invalid-cursor' });
  if (a.kind === 'error' && a.code === -32602) return passed(`${method} with an invalid cursor answered error -32602.`);
  if (a.kind === 'result') {
    const paged = (await walk(ctx, method, field)).pages.length > 1;
    if (!paged) return notOffered(`${method} has one page and answers a cursor with that page: it does not page.`);
  }
  return failed(`${method} with an invalid cursor answered ${said(a)}.`, 'Answer a cursor the server never gave with the error -32602 (Invalid params).');
};

export const PAGINATION: Record<string, ConformanceCheck> = {
  'pagination-walk-complete': walkComplete,
  'pagination-invalid-cursor': invalidCursor,
};
