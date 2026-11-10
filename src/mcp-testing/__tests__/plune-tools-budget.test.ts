// The context budget of `plune mcp serve`: what our tool list costs a model on every request, in each list a client
// can be shown, and what the answers of the main read tools cost. Measured on the real server's answers (the same
// in-memory client as the contract snapshot), held to the limits in lint/thresholds.ts from both sides: a list over its
// limit fails, and so does a limit that has drifted too far above what is measured.

import { describe, expect, it } from 'vitest';
import { connectPluneServer, type PluneConnection, type ProtocolEra } from '../plune-snapshot.js';
import { estimateTokens, LINT_THRESHOLDS, toolListSize, type ListedTool } from '../lint/index.js';
import {
  FIXTURE_CASES,
  FIXTURE_MISSION_ID,
  FIXTURE_MISSION_SOURCES,
  FIXTURE_MISSIONS,
  FIXTURE_REVIEW_ITEMS,
  FIXTURE_SUITES,
  fixturePlatform,
  LIVE,
} from './plune-budget.fixtures.js';

const B = LINT_THRESHOLDS.size.budget;

/** Over the limit, or a limit looser than the measure by more than the recorded share: both are failures. */
function overrun(what: string, measured: number, limit: number, biggest = ''): string[] {
  if (measured > limit) return [`${what}: ~${measured} tokens, over its limit of ${limit}${biggest}. Shorten it, or raise the limit on purpose.`];
  if (measured < limit * B.tooLooseShare)
    return [`${what}: limit ${limit} is too loose for the measured ~${measured} (below ${B.tooLooseShare} of it). Set it to the measure plus ${B.headroom * 100}%.`];
  return [];
}

async function withServer<T>(era: ProtocolEra, scope: 'read' | 'write', run: (c: PluneConnection) => Promise<T>, fetchImpl?: typeof fetch): Promise<T> {
  const c = await connectPluneServer({ era, scope, ...(fetchImpl === undefined ? {} : { fetchImpl }) });
  try {
    return await run(c);
  } finally {
    await c.close();
  }
}

// Counts as measured on the server today (see the dated limits). The 2026-07-28 list does not change after
// plune_discover_tools, so its write list is the one listed first; its read list is the same as the 2025 one.
const LISTS = [
  { key: 'writeFirst', name: '2025 era, write scope, as listed first', era: 'legacy', scope: 'write', reveal: false, count: 17 },
  { key: 'writeAll', name: '2025 era, write scope, after plune_discover_tools', era: 'legacy', scope: 'write', reveal: true, count: 22 },
  { key: 'read', name: '2025 era, read scope', era: 'legacy', scope: 'read', reveal: false, count: 8 },
  { key: 'modernWrite', name: '2026-07-28 era, write scope', era: 'modern', scope: 'write', reveal: true, count: 17 },
] as const;

const listOf = (l: (typeof LISTS)[number]) =>
  withServer(l.era, l.scope, async (c) => {
    if (l.reveal) await c.revealHidden();
    return (await c.listTools()) as ListedTool[];
  });

const ANSWERS = [
  { tool: 'plune_project_context', args: {}, items: (d: Record<string, unknown>) => (d['missions'] as unknown[]).length + (d['suites'] as unknown[]).length },
  { tool: 'plune_cases_search', args: { limit: 100 }, items: (d: Record<string, unknown>) => (d['testCases'] as unknown[]).length },
  { tool: 'plune_review_list', args: { state: 'pending', limit: 100 }, items: (d: Record<string, unknown>) => (d['items'] as unknown[]).length },
  { tool: 'plune_mission_get', args: { missionId: FIXTURE_MISSION_ID }, items: (d: Record<string, unknown>) => ((d['mission'] as Record<string, unknown>)['sources'] as unknown[]).length },
] as const;

/** Items each answer must hold, so an empty answer is not measured as a small one. */
const ANSWER_ITEMS: Record<(typeof ANSWERS)[number]['tool'], number> = {
  plune_project_context: FIXTURE_MISSIONS + FIXTURE_SUITES,
  plune_cases_search: Math.min(100, FIXTURE_CASES),
  plune_review_list: FIXTURE_REVIEW_ITEMS,
  plune_mission_get: FIXTURE_MISSION_SOURCES,
};

describe('CLI · mcp budget · Plune tools list', () => {
  it.each(LISTS)('$name: within its limit, the limit not too loose', async (l) => {
    const tools = await listOf(l);
    // Nothing listed is nothing measured, which is not a pass.
    expect(tools.length).toBe(l.count);
    const size = toolListSize(tools);
    const noOutput = toolListSize(tools.map(({ outputSchema: _, ...t }) => t as ListedTool));
    const largest = size.largest;
    expect(size.totalTokens).toBeGreaterThan(0);
    expect(largest).toBeDefined();
    if (largest === undefined) return;
    const top = [...size.tools].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
    console.info(
      `mcp budget · ${l.name}: ${tools.length} tools, ~${size.totalTokens} tokens (limit ${B.lists[l.key]}), ` +
        `~${noOutput.totalTokens} without outputSchema; biggest ${top.map((t) => `${t.name} ~${t.tokens}`).join(', ')} [${size.method}]`,
    );
    expect(overrun(l.name, size.totalTokens, B.lists[l.key], `; biggest tool ${largest.name} ~${largest.tokens}`)).toEqual([]);
  });

  it('the biggest tool of the whole contract: within its limit, the limit not too loose', async () => {
    const largest = toolListSize(await listOf(LISTS[1])).largest;
    expect(largest).toBeDefined();
    if (largest === undefined) return;
    expect(overrun(`biggest tool ${largest.name}`, largest.tokens, B.largestTool)).toEqual([]);
  });

  it.each(ANSWERS)('$tool answers within its limit on the recorded demo project', async (a) => {
    const result = await withServer('legacy', 'write', (c) => c.request('tools/call', { name: a.tool, arguments: a.args }), fixturePlatform);
    expect(result['isError']).toBeFalsy();
    expect(a.items(result['structuredContent'] as Record<string, unknown>)).toBe(ANSWER_ITEMS[a.tool]);
    // What a model reads is the text content; structuredContent carries the same data.
    const text = (result['content'] as { type: string; text: string }[])[0]?.text ?? '';
    const tokens = estimateTokens(text);
    const compact = estimateTokens(JSON.stringify(result['structuredContent']));
    console.info(`mcp budget · ${a.tool} answer: ~${tokens} tokens (limit ${B.answers[a.tool]}), ~${compact} as JSON without indentation`);
    expect(overrun(`${a.tool} answer`, tokens, B.answers[a.tool])).toEqual([]);
  });

  it('the recorded answers hold no address, token or user id but the sample ones', () => {
    const text = JSON.stringify(LIVE);
    expect(text.match(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).toEqual([]);
    expect(text).not.toMatch(/Bearer|plt_\w|plune_[\w-]{20,}/);
    const users = new Set([...text.matchAll(/"(?:createdBy|updatedBy|userId|ownerId|authorId)":"([^"]*)"/g)].map((m) => m[1]));
    expect([...users]).toEqual(['u-john-doe']);
  });

  it('the over and too-loose checks fire', () => {
    expect(overrun('x', 101, 100)).toHaveLength(1);
    expect(overrun('x', 100, 100)).toEqual([]);
    expect(overrun('x', 50, 100)).toHaveLength(1);
  });
});
