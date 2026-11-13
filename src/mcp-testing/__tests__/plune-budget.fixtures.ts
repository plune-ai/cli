// The platform behind the read tools when their answers are measured: live answers of the beta demo account (project
// u-john-doe::default, read-only, 2026-11-10) as src/mcp-tools/execute.ts receives them from the HTTP API, kept in
// fixtures/plune-budget-live.json. Cleaned before they were stored: the user id is u-john-doe, the account's other
// projects carry made-up ids and names; the demo shop's own cases, suites and queue are as captured (in Ukrainian).
// The demo account has no missions, so the one mission `plune_mission_get` reads was captured on 2026-11-14 from a
// throwaway mission of a beta test project, removed after (fixtures/plune-mission-live.json): its ids, the project's
// and the user's are placeholders of the same length (00000000-0000-4000-8000-0000000000NN), the rest is as answered.
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

/** The live mission: five sources, one of each kind. */
export const LIVE_MISSION = JSON.parse(readFileSync(new URL('./fixtures/plune-mission-live.json', import.meta.url), 'utf8')) as {
  id: string;
  sources: unknown[];
};
export const FIXTURE_MISSION_ID = LIVE_MISSION.id;
export const FIXTURE_MISSION_SOURCES = LIVE_MISSION.sources.length;

const ANSWERS: Record<string, unknown> = { ...LIVE.answers, [`/v1/missions/${FIXTURE_MISSION_ID}`]: LIVE_MISSION };

/** The recorded platform as a `fetch`: a recorded path and query answers as captured, anything else is a 404. */
export const fixturePlatform = (async (input: string | URL) => {
  const url = new URL(String(input));
  const answer = ANSWERS[url.pathname + url.search];
  return new Response(JSON.stringify(answer === undefined ? { error: 'not in the fixture' } : answer), {
    status: answer === undefined ? 404 : 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
