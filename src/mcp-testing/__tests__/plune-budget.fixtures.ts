// The platform behind the read tools when their answers are measured: live answers of the beta demo account (project
// u-john-doe::default, read-only, 2026-11-10) as src/mcp-tools/execute.ts receives them from the HTTP API, kept in
// fixtures/plune-budget-live.json. Cleaned before they were stored: the user id is u-john-doe, the account's other
// projects carry made-up ids and names; the demo shop's own cases, suites and queue are as captured (in Ukrainian).
// The demo account has no missions, so the one mission `plune_mission_get` reads is synthetic (John Doe, user@plune.ai).
// Deterministic: the same answers on every run, and nothing leaves the process.

import { readFileSync } from 'node:fs';

interface LiveFixture {
  measuredAt: string;
  /** Answers by path and query, exactly as the tools ask for them. */
  answers: Record<string, unknown>;
}

export const LIVE = JSON.parse(readFileSync(new URL('./fixtures/plune-budget-live.json', import.meta.url), 'utf8')) as LiveFixture;

const PAGE = '/v1/test-cases?limit=100&stability=0';
const QUEUE = '/v1/review-items?state=pending&limit=100';

/** Cases in the demo project: fewer than a full page of `plune_cases_search` (100), so the whole project is one page. */
export const FIXTURE_CASES = (LIVE.answers[PAGE] as { testCases: unknown[] }).testCases.length;
/** Entries pending in the review queue. */
export const FIXTURE_REVIEW_ITEMS = (LIVE.answers[QUEUE] as { items: unknown[] }).items.length;
/** Suites and missions `plune_project_context` lists. */
export const FIXTURE_SUITES = (LIVE.answers['/v1/suites'] as { suites: unknown[] }).suites.length;
export const FIXTURE_MISSIONS = (LIVE.answers['/v1/missions'] as { missions: unknown[] }).missions.length;
export const FIXTURE_MISSION_ID = 'mission-1';
export const FIXTURE_MISSION_SOURCES = 5;

const AT = '2026-11-10T09:00:00.000Z';

const source = (i: number) => ({
  id: `source-${i + 1}`,
  kind: ['url', 'openapi', 'repo', 'ticket', 'file'][i % 5],
  ref: `https://example.com/shop/docs/${i + 1}`,
  title: `Shop documentation, part ${i + 1}`,
  version: `v1.${i}`,
  addedBy: 'John Doe',
  addedAt: AT,
});

export const SYNTHETIC_MISSION = {
  id: FIXTURE_MISSION_ID,
  projectId: 'u-john-doe::default',
  name: 'Checkout',
  summary:
    'An online shop where a signed-in user fills a cart, pays by card and follows the order. The mission covers the way from the cart to the confirmation, the refusals of payment and the e-mails sent.',
  url: 'https://shop.example.com',
  state: 'active',
  documentation: 'provided',
  createdBy: 'John Doe',
  createdAt: AT,
  updatedAt: AT,
  sources: Array.from({ length: FIXTURE_MISSION_SOURCES }, (_, i) => source(i)),
};

const ANSWERS: Record<string, unknown> = { ...LIVE.answers, [`/v1/missions/${FIXTURE_MISSION_ID}`]: SYNTHETIC_MISSION };

/** The recorded platform as a `fetch`: a recorded path and query answers as captured, anything else is a 404. */
export const fixturePlatform = (async (input: string | URL) => {
  const url = new URL(String(input));
  const answer = ANSWERS[url.pathname + url.search];
  return new Response(JSON.stringify(answer === undefined ? { error: 'not in the fixture' } : answer), {
    status: answer === undefined ? 404 : 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
