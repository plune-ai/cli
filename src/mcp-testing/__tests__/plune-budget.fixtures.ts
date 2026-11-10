// A synthetic platform for measuring how big the answers of our read tools are: one project with a hundred and more
// cases, a review queue and missions, shaped like the answers of the platform's HTTP API that src/mcp-tools/execute.ts
// reads. Made up here, not captured from a live project, so a size measured on it is an estimate of the shape; sample
// people are John Doe, user@plune.ai. Deterministic: the same answers on every run.

const AT = '2026-11-10T09:00:00.000Z';
const PROJECT = 'proj-shop';
const SUITES = ['Checkout', 'Cart', 'Catalog', 'Account', 'Payments', 'Search'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];

/** How many cases the project holds: more than a full page of `plune_cases_search` (100), so the page is full. */
export const FIXTURE_CASES = 120;
/** Entries pending in the review queue. */
export const FIXTURE_REVIEW_ITEMS = 25;
export const FIXTURE_MISSION_ID = 'mission-1';

const suite = (i: number) => ({
  id: `suite-${i + 1}`,
  name: SUITES[i],
  parentId: null,
  children: [
    { id: `suite-${i + 1}-1`, name: `${SUITES[i]} · happy path`, parentId: `suite-${i + 1}`, children: [] },
    { id: `suite-${i + 1}-2`, name: `${SUITES[i]} · errors`, parentId: `suite-${i + 1}`, children: [] },
  ],
});

const testCase = (i: number) => {
  const area = SUITES[i % SUITES.length] ?? 'Checkout';
  return {
    id: `case-${String(i + 1).padStart(4, '0')}`,
    title: `${area}: a signed-in user completes step ${i + 1} and sees the confirmation`,
    type: i % 3 === 0 ? 'automated' : 'manual',
    state: 'active',
    priority: PRIORITIES[i % PRIORITIES.length],
    suiteId: `suite-${(i % SUITES.length) + 1}-1`,
    tags: ['smoke', area.toLowerCase()],
    preconditions: 'John Doe is signed in as user@plune.ai with one item in the cart.',
    steps: [
      { action: `Open the ${area} page`, expected: 'The page loads without errors' },
      { action: 'Fill in the form with valid data', expected: 'Every field accepts its value' },
      { action: 'Press Continue', expected: 'The confirmation is shown with the order number' },
    ],
    stability: { passed: 9, failed: 1, flaky: false },
    externalKeys: i % 3 === 0 ? [{ kind: 'path-title', value: `e2e/${area.toLowerCase()}.spec.ts > step ${i + 1}` }] : [],
    createdBy: 'John Doe',
    createdAt: AT,
    updatedAt: AT,
  };
};

const reviewItem = (i: number) => ({
  id: `review-${i + 1}`,
  kind: i % 2 === 0 ? 'proposal' : 'result',
  state: 'pending',
  title: `Proposed: ${SUITES[i % SUITES.length]} rejects an expired card`,
  missionId: FIXTURE_MISSION_ID,
  payload: {
    title: `${SUITES[i % SUITES.length]} rejects an expired card`,
    steps: ['Add an item to the cart', 'Pay with a card that expired last month'],
    expected: 'The payment is refused and the reason is shown next to the card field.',
    technique: 'boundary-value',
    priority: 'high',
    source: { kind: 'requirement', value: `REQ-${100 + i}` },
    rationale: 'Expired cards are a common support ticket.',
  },
  createdBy: 'John Doe',
  createdAt: AT,
  updatedAt: AT,
});

const source = (i: number) => ({
  id: `source-${i + 1}`,
  kind: ['url', 'openapi', 'repo', 'ticket', 'file'][i % 5],
  ref: `https://example.com/shop/docs/${i + 1}`,
  title: `Shop documentation, part ${i + 1}`,
  version: `v1.${i}`,
  addedBy: 'John Doe',
  addedAt: AT,
});

const mission = (i: number, sources: unknown) => ({
  id: `mission-${i + 1}`,
  projectId: PROJECT,
  name: ['Checkout', 'Account', 'Search'][i],
  summary:
    'An online shop where a signed-in user fills a cart, pays by card and follows the order. The mission covers the way from the cart to the confirmation, the refusals of payment and the e-mails sent.',
  url: 'https://shop.example.com',
  state: i === 0 ? 'active' : 'draft',
  documentation: 'provided',
  createdBy: 'John Doe',
  createdAt: AT,
  updatedAt: AT,
  sources,
});

const ANSWERS: Record<string, (q: URLSearchParams) => unknown> = {
  '/v1/projects': () => ({ projects: [{ id: PROJECT, name: 'John Doe shop', createdAt: AT }] }),
  '/v1/suites': () => ({ suites: SUITES.map((_, i) => suite(i)) }),
  '/v1/test-cases': (q) => {
    const limit = Math.min(Number(q.get('limit') ?? '50'), FIXTURE_CASES);
    const nextCursor = limit < FIXTURE_CASES ? `after-${limit}` : null;
    return { testCases: Array.from({ length: limit }, (_, i) => testCase(i)), total: FIXTURE_CASES, matching: FIXTURE_CASES, nextCursor };
  },
  '/v1/missions': () => ({ missions: [0, 1, 2].map((i) => mission(i, 5)) }),
  [`/v1/missions/${FIXTURE_MISSION_ID}`]: () => mission(0, Array.from({ length: 5 }, (_, i) => source(i))),
  '/v1/review-items': (q) => ({
    items: Array.from({ length: Math.min(Number(q.get('limit') ?? '50'), FIXTURE_REVIEW_ITEMS) }, (_, i) => reviewItem(i)),
    nextCursor: null,
  }),
};

/** The synthetic platform as a `fetch`: a known read path answers its fixture, anything else is a 404. Nothing leaves the process. */
export const fixturePlatform = (async (input: string | URL) => {
  const url = new URL(String(input));
  const answer = ANSWERS[url.pathname];
  return new Response(JSON.stringify(answer === undefined ? { error: 'not in the fixture' } : answer(url.searchParams)), {
    status: answer === undefined ? 404 : 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
