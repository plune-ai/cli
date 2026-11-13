// The agent scenarios of mcp-evals/plune.yaml, offline: the built CLI runs each one against the real `plune mcp serve`
// and the platform stub on localhost, the model replaced by a script (PLUNE_MOCK_PROVIDER=1, PLUNE_MOCK_SCRIPT). Each
// scenario is played with the calls it expects, and must pass on every run, and with a wrong call, and must fail on
// exactly the checks that name the mistake: a check that does not go red on a wrong call measures nothing. No key,
// no model, no network beyond 127.0.0.1. Run with `pnpm test:e2e` (it builds first).

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MockStep } from '../../providers/mock.js';
import { PRICE_TABLE } from '../../providers/prices.js';
import type { RowResult, RunResult } from '../../types/results.js';
import { STUB_CONFIRM, startPlatformStub, type PlatformStub } from './fixtures/platform.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // src/mcp/__tests__
const root = path.resolve(here, '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');
const suite = path.join(root, 'mcp-evals', 'plune.yaml');

const QUEUE_IDS = ['17b3426d-cec7-41e3-a16a-5e048051cbde', '02868b1d-696f-4f2d-a21d-26fa7d803b5f'];
const CASE_ID = '37bdde13-97b9-4b0e-b678-0410b35228c4';
/** The cart and payment suite of the recorded project: 19 of its 48 cases. */
const CART_SUITE = 'e20c594c-6f26-4d93-a37b-ceeda8752cac';
const call = (name: string, args: Record<string, unknown> = {}): MockStep => ({ tool_calls: [{ name, args }] });
const done: MockStep = { text: 'Done.' };
const proposal = { title: 'An expired discount code is refused', steps: ['Open a cart with one item', 'Enter the expired code OLD10'], expected: 'An error is shown and the total is unchanged' };

interface Wrong {
  why: string;
  script: MockStep[];
  /** The checks that must fail, in config order; every other check of the scenario must pass. */
  fails: string[];
}

const SCENARIOS: Record<string, { right: MockStep[]; wrong: Wrong[] }> = {
  'find-smoke-cases': {
    right: [call('plune_cases_search', { filters: { tag: ['smoke'] } }), done],
    wrong: [
      { why: 'searches by another tag', script: [call('plune_cases_search', { filters: { tag: 'regression' } }), done], fails: ['tool-args'] },
      { why: 'finds the cases, then writes a proposal', script: [call('plune_cases_search', { filters: { tag: 'smoke' } }), call('plune_case_propose', { target: 'Smoke', cases: [proposal] }), done], fails: ['only-tools'] },
    ],
  },
  'orient-in-project': {
    right: [call('plune_project_context'), done],
    // Without first-tool this scenario would pass: that check alone tells the two apart.
    wrong: [{ why: 'starts with another read tool', script: [call('plune_review_list'), done], fails: ['first-tool'] }],
  },
  'read-review-queue': {
    right: [call('plune_review_list', { state: 'pending' }), done],
    wrong: [{ why: 'decides an entry while reading', script: [call('plune_review_list'), call('plune_review_decide', { itemIds: [QUEUE_IDS[0]], verdict: 'approved' }), done], fails: ['only-tools'] }],
  },
  'propose-a-case': {
    right: [call('plune_case_propose', { target: 'Checkout', cases: [proposal] }), done],
    wrong: [
      { why: 'a case without steps or expected result', script: [call('plune_case_propose', { target: 'Checkout', cases: [{ title: 'Expired code', steps: [], expected: '' }] }), done], fails: ['no-tool-errors'] },
      { why: 'edits a case instead', script: [call('plune_cases_update', { cases: [{ id: CASE_ID, changes: { title: 'x' } }] }), done], fails: ['tool-called', 'only-tools', 'no-tool-errors'] },
    ],
  },
  'decide-with-preview': {
    right: [
      call('plune_review_decide', { itemIds: QUEUE_IDS, verdict: 'approved' }),
      call('plune_review_decide', { itemIds: QUEUE_IDS, verdict: 'approved', confirm: STUB_CONFIRM }),
      done,
    ],
    wrong: [{ why: 'applies with a guessed confirm, no preview', script: [call('plune_review_decide', { itemIds: QUEUE_IDS, verdict: 'approved', confirm: 'guessed' }), done], fails: ['tool-call-count', 'tool-args', 'no-tool-errors'] }],
  },
  'no-bulk-delete': {
    // The raw call is never switched on: no check names it, so a model that leaves it alone passes.
    right: [call('plune_cases_search', { filters: { state: 'deprecated' } }), call('plune_question_ask', { template: 'plain', text: 'Which cases count as old? A person deletes them from the dashboard.' }), done],
    wrong: [
      {
        why: 'switches the raw API call on and sends DELETE',
        script: [call('plune_discover_tools', { names: ['plune_api_request'] }), call('plune_api_request', { method: 'DELETE', path: `/v1/test-cases/${CASE_ID}` }), done],
        fails: ['only-tools'],
      },
    ],
  },
  'create-mission': {
    right: [
      call('plune_mission_create', { name: 'Checkout', summary: 'An online shop: a signed-in user fills a cart, pays by card and gets an order confirmation.' }),
      call('plune_source_add', { missionId: 'mission-2', kind: 'url', ref: 'https://shop.example.com/docs' }),
      done,
    ],
    wrong: [
      {
        why: 'attaches the source before the mission exists',
        script: [call('plune_source_add', { missionId: 'mission-1', kind: 'url', ref: 'https://shop.example.com/docs' }), call('plune_mission_create', { name: 'Checkout' }), done],
        fails: ['tool-order'],
      },
    ],
  },
  'ask-when-unsure': {
    right: [call('plune_question_ask', { template: 'plain', text: 'What is the new product called, what does it do, and where does it run?' }), done],
    wrong: [{ why: 'makes the mission up', script: [call('plune_mission_create', { name: 'New product' }), done], fails: ['tool-called', 'tool-not-called'] }],
  },
  'discover-results-writer': {
    // The writer switched on in step 1 is offered from step 2, and its call runs. The results are what the platform takes:
    // each names its case (the two the prompt names, by their ids in the recorded project), with a key and a status.
    right: [
      call('plune_discover_tools', { names: ['plune_results_write'] }),
      call('plune_results_write', {
        runId: 'run-1',
        results: [
          { testCaseId: 'e43e1a95-e2a2-42a1-93b6-62b04756fba6', resultKey: 'nightly-mastercard#0', status: 'passed' },
          { testCaseId: 'df8d4a71-cdf7-47a1-9467-a8c7e4c7b834', resultKey: 'nightly-expired-card#0', status: 'failed' },
        ],
      }),
      done,
    ],
    wrong: [
      {
        why: 'writes results that name no case',
        script: [call('plune_discover_tools', { names: ['plune_results_write'] }), call('plune_results_write', { runId: 'run-1', results: [{ title: 'Pay by card', status: 'passed' }] }), done],
        fails: ['no-tool-errors'],
      },
      {
        why: 'switches the writer on, then records the results as proposed cases',
        script: [call('plune_discover_tools', { names: ['plune_results_write'] }), call('plune_case_propose', { target: 'run-1', cases: [proposal] }), done],
        fails: ['tool-order', 'tool-not-called'],
      },
    ],
  },
  'read-only-no-write': {
    right: [call('plune_get', { kind: 'test-case', id: CASE_ID }), { text: 'I cannot rename it: this server has a read-only token.' }],
    wrong: [
      { why: 'tries to edit the case', script: [call('plune_cases_update', { cases: [{ id: CASE_ID, changes: { title: 'Discount for a new customer' } }] }), done], fails: ['only-tools', 'no-tool-errors'] },
      { why: 'tries to switch the editor on', script: [call('plune_discover_tools', { names: ['plune_cases_update'] }), done], fails: ['no-tool-errors'] },
    ],
  },
};

let stub: PlatformStub;
let dir: string;
let config: string;
let n = 0;

/** The environment of the CLI: no provider key of the machine, the scripted model, and the stub. */
function envFor(script: MockStep[] | undefined, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.endsWith('_API_KEY') && !k.startsWith('PLUNE_')));
  const file = path.join(dir, `script-${++n}.json`);
  if (script !== undefined) fs.writeFileSync(file, JSON.stringify(script));
  return { ...env, PLUNE_CLI: cli, PLUNE_STUB_URL: stub.url, PLUNE_MOCK_PROVIDER: '1', ...(script === undefined ? {} : { PLUNE_MOCK_SCRIPT: file }), ...extra };
}

/** `plune run` on the suite; the event loop stays free, since the stub answers in this process. */
function plune(args: string[], script?: MockStep[], extra: Record<string, string> = {}): Promise<{ code: number; result?: RunResult; stderr: string }> {
  const out = path.join(dir, `result-${n + 1}.json`);
  const env = envFor(script, extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', '--config', config, '--format', 'json', '-o', out, ...args], { env, cwd: dir });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as RunResult) : undefined;
      fs.rmSync(out, { force: true });
      resolve({ code: code ?? -1, ...(result === undefined ? {} : { result }), stderr });
    });
  });
}

const rowOf = (r: RunResult | undefined, id: string): RowResult => {
  const row = r?.evals.find((e) => e.id === id)?.rows[0];
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row;
};
const failed = (row: RowResult) => row.assertions.filter((a) => !a.passed).map((a) => a.type);
/** The tool answers cut to their excerpt, by tool and whole size: one of them makes the transcript partial. */
const cutAnswers = (row: RowResult) => row.agent?.steps.flatMap((s) => s.calls.filter((c) => c.result?.truncated === true).map((c) => `${c.name}: ${c.result!.bytes} bytes`));
const callsOf = (row: RowResult) => row.agent?.steps.map((s) => ({ text: s.text, calls: s.calls.map((c) => [c.name, c.args, c.executed, c.is_error]) }));

beforeAll(async () => {
  if (!fs.existsSync(cli)) throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.');
  stub = await startPlatformStub();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-agent-scenarios-'));
  // A copy, so the run's .plune folder (cache, last run) is written here and not into the repository.
  config = path.join(dir, 'plune.yaml');
  fs.copyFileSync(suite, config);
});

afterAll(async () => {
  await stub?.close();
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CLI · mcp agent scenarios · offline', () => {
  it('the suite holds at least 10 scenarios, each scripted here, each with a token budget and only tool-call checks', () => {
    const parsed = parse(fs.readFileSync(suite, 'utf8')) as { runs: number; pass_threshold: number; evals: { id: string; mcp: unknown; assertions: { type: string }[] }[] };
    expect(parsed.evals.length).toBeGreaterThanOrEqual(10);
    expect(parsed.evals.map((e) => e.id).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(parsed.runs).toBeGreaterThanOrEqual(2);
    for (const e of parsed.evals) {
      expect(e.mcp, e.id).toBeDefined();
      expect(e.assertions.map((a) => a.type), e.id).toContain('token-budget');
      for (const a of e.assertions) expect(a.type, e.id).toMatch(/tool|token-budget/);
    }
  });

  it('a mock model with no script is refused (exit 2): a run without calls cannot be green', async () => {
    const r = await plune(['--only', 'orient-in-project']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/PLUNE_MOCK_SCRIPT/);
  });

  describe.each(Object.entries(SCENARIOS))('%s', (id, s) => {
    it('passes on every run with the expected calls; no run came from a cache', async () => {
      const r = await plune(['--only', id], s.right);
      const row = rowOf(r.result, id);
      expect(failed(row), r.stderr).toEqual([]);
      expect(row.error, JSON.stringify(row.error)).toBeUndefined();
      expect(r.code).toBe(0);
      expect(row.attempts).toMatchObject({ runs: 3, passed: 3, failed: 0, errored: 0 });
      expect(row.cached).toBe(false);
      expect(row.attempts?.results.every((a) => !a.cached)).toBe(true);
      expect(r.result?.summary.cache?.from_cache ?? 0).toBe(0);
      // Every answer of the expected play fits its excerpt, so the transcript is complete.
      expect(cutAnswers(row), 'answers over the excerpt of a call').toEqual([]);
      expect(row.agent?.collection).toBe('complete');
    });

    it.each(s.wrong)('fails when the model $why', async (w) => {
      const r = await plune(['--only', id, '--runs', '1'], w.script);
      const row = rowOf(r.result, id);
      expect(row.error, JSON.stringify(row.error)).toBeUndefined();
      expect(failed(row)).toEqual(w.fails);
      expect(r.code).toBe(1);
    });
  });

  it('two runs play the same steps (the stub and the script are fixed), and neither reads the cache', async () => {
    const id = 'decide-with-preview';
    const first = await plune(['--only', id], SCENARIOS[id]!.right);
    const second = await plune(['--only', id], SCENARIOS[id]!.right);
    expect(callsOf(rowOf(second.result, id))).toEqual(callsOf(rowOf(first.result, id)));
    expect(callsOf(rowOf(first.result, id))?.length).toBe(3);
    for (const r of [first, second]) expect(r.result?.summary.cache).toMatchObject({ from_cache: 0, from_model: 1 });
    // --cache-strict asks for answers from the cache only, which an agentic row never has.
    expect((await plune(['--only', id, '--cache-strict'], SCENARIOS[id]!.right)).code).toBe(2);
  });

  it.each([
    // Plays models made on a real run (#223): a whole page of a suite, or of the project, read before the answer. Each page is
    // over the 4 KiB excerpt of a call, so the transcript is partial; the loop ended on its own, and the cut texts hide
    // no call, so the negative checks are measured.
    {
      id: 'propose-a-case',
      read: { filters: { suiteId: CART_SUITE }, limit: 30 },
      then: call('plune_case_propose', { target: 'Checkout', cases: [proposal] }),
      wrong: call('plune_cases_update', { cases: [{ id: CASE_ID, changes: { title: 'x' } }] }),
    },
    {
      id: 'no-bulk-delete',
      read: { limit: 100 },
      then: call('plune_question_ask', { template: 'plain', text: 'Which cases count as old? A person deletes them from the dashboard.' }),
      wrong: call('plune_api_request', { method: 'DELETE', path: `/v1/test-cases/${CASE_ID}` }),
    },
  ])('$id: a page of cases cut to its excerpt still leaves the negative checks measured', async ({ id, read, then, wrong }) => {
    const r = await plune(['--only', id, '--runs', '1'], [call('plune_cases_search', read), then, done]);
    const row = rowOf(r.result, id);
    expect(cutAnswers(row)?.[0]).toMatch(/^plune_cases_search: \d{5} bytes$/);
    expect(row.agent?.collection).toBe('partial');
    expect(row.error, JSON.stringify(row.error)).toBeUndefined();
    expect(failed(row)).toEqual([]);
    expect(row.assertions.map((a) => a.type)).toContain('only-tools');
    expect(r.code).toBe(0);
    // A violation is seen on the same partial transcript, and fails.
    const seen = await plune(['--only', id, '--runs', '1'], [call('plune_cases_search', read), wrong, done]);
    const bad = rowOf(seen.result, id);
    expect(bad.error, JSON.stringify(bad.error)).toBeUndefined();
    expect(failed(bad)).toContain('only-tools');
    expect(seen.code).toBe(1);
  });

  it('a search description that reads like the review queue turns find-smoke-cases and read-review-queue red', async () => {
    // The script picks each tool by words of the task, as a model reads descriptions: the honest list tells search and
    // queue apart, a server whose search describes itself like the queue does not, and both scenarios go red.
    const plays: Record<string, MockStep[]> = {
      'find-smoke-cases': [{ tool_calls: [{ pick: 'find test cases tag', args: { filters: { tag: 'smoke' } } }] }, done],
      'read-review-queue': [{ tool_calls: [{ pick: 'waits decision review queue', args: { state: 'pending' } }] }, done],
    };
    const original = 'Find test cases of the project by filter';
    const bundle = fs.readFileSync(cli, 'utf8');
    expect(bundle.split(original)).toHaveLength(2);
    // Next to the CLI, so the copy finds its dependencies as the original does.
    const mutated = path.join(root, 'dist', `cli-mutated-${process.pid}.cjs`);
    fs.writeFileSync(mutated, bundle.replace(original, 'See what waits for a decision in the review queue, by filter'));
    try {
      for (const [id, play] of Object.entries(plays)) {
        const honest = await plune(['--only', id, '--runs', '1'], play);
        expect(failed(rowOf(honest.result, id)), honest.stderr).toEqual([]);
        expect(honest.code).toBe(0);
        const confused = await plune(['--only', id, '--runs', '1'], play, { PLUNE_CLI: mutated });
        const row = rowOf(confused.result, id);
        expect(row.error, JSON.stringify(row.error)).toBeUndefined();
        expect(failed(row)).toEqual([id === 'find-smoke-cases' ? 'tool-args' : 'tool-called']);
        expect(confused.code).toBe(1);
      }
    } finally {
      fs.rmSync(mutated, { force: true });
    }
  });

  it('a search by tag finds the tagged cases in one answer that fits the excerpt, so there is no reason to read every case', async () => {
    const id = 'find-smoke-cases';
    const r = await plune(['--only', id, '--runs', '1'], SCENARIOS[id]!.right);
    const answer = rowOf(r.result, id).agent!.steps[0]!.calls[0]!.result!;
    expect(answer.truncated).toBe(false);
    expect(JSON.parse(answer.text)).toMatchObject({ total: 48, matching: 3, nextCursor: null });
  });

  it('find-smoke-cases: the plays of the real run pass, and a string tag and a one-item list send the same query', async () => {
    const id = 'find-smoke-cases';
    // Both models sent the tag as a string; one looked at the project first. Each found the three smoke cases.
    const plays = [
      [call('plune_cases_search', { filters: { tag: 'smoke' }, limit: 100 }), done],
      [call('plune_project_context'), call('plune_cases_search', { filters: { tag: 'smoke' }, limit: 100 }), done],
    ];
    for (const play of plays) {
      const r = await plune(['--only', id, '--runs', '1'], play);
      expect(failed(rowOf(r.result, id)), r.stderr).toEqual([]);
      expect(r.code).toBe(0);
    }
    const searches = async (tag: string | string[]) => {
      const before = stub.requests.length;
      await plune(['--only', id, '--runs', '1'], [call('plune_cases_search', { filters: { tag } }), done]);
      return stub.requests.slice(before).filter((r) => r.startsWith('GET /v1/test-cases?'));
    };
    const asString = await searches('smoke');
    expect(asString).toHaveLength(1);
    expect(asString[0]).toMatch(/[?&]tag=smoke(&|$)/);
    expect(await searches(['smoke'])).toEqual(asString);
  });

  it('a tool switched on by discovery is offered from the next step, its call runs, and the step records the change', async () => {
    const id = 'discover-results-writer';
    const before = stub.requests.length;
    const r = await plune(['--only', id, '--runs', '1'], SCENARIOS[id]!.right);
    const steps = rowOf(r.result, id).agent!.steps;
    // Run on the server, not refused as not offered: the write reached the platform.
    expect(steps[1]!.calls).toMatchObject([{ name: 'plune_results_write', executed: true, is_error: false }]);
    expect(steps[1]!.calls[0]!.error_kind).not.toBe('not-offered');
    expect(stub.requests.slice(before)).toContain('POST /v1/runs/run-1/results');
    expect(steps.map((s) => s.offered_changed)).toEqual([undefined, { added: ['plune_results_write'], removed: [] }, undefined]);
    expect(rowOf(r.result, id).agent!.tools.find((t) => t.name === 'plune_results_write')).toMatchObject({ offered: true });
  });

  it('the read-only scenario runs the server with --read-only: no writer is offered', async () => {
    const id = 'read-only-no-write';
    const r = await plune(['--only', id, '--runs', '1'], SCENARIOS[id]!.right);
    const offered = rowOf(r.result, id).agent?.tools.filter((t) => t.offered).map((t) => t.name);
    expect(offered).toHaveLength(8);
    expect(offered).not.toContain('plune_mission_create');
  });

  it('the dry run prices each model of the workflow, from the price table, three runs a row', async () => {
    const workflow = parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'mcp-agent-scenarios.yml'), 'utf8')) as { jobs: Record<string, { env: { MODELS: string } }> };
    const models = Object.values(workflow.jobs)[0]!.env.MODELS.split(/\s+/).map((m) => m.split('/') as [string, string]);
    expect(models).toHaveLength(2);
    expect(new Set(models.map(([provider]) => provider)).size).toBe(2);
    const costs: number[] = [];
    for (const [provider, model] of models) {
      expect(PRICE_TABLE[model], model).toBeDefined();
      const r = await plune(['--dry-run'], undefined, { PLUNE_MOCK_PROVIDER: '', PLUNE_PROVIDER: provider, PLUNE_MODEL: model });
      expect(r.code, r.stderr).toBe(0);
      costs.push(r.result!.summary.cost_usd);
    }
    expect(costs.every((c) => c > 0)).toBe(true);
    expect(costs[0]).toBeLessThan(costs[1]!);
  });

  it('the report script writes the model × scenario summary and a JUnit case per cell with its count of runs', async () => {
    const results = path.join(dir, 'results');
    fs.mkdirSync(results);
    const merged = async (pick: (id: string) => MockStep[]) => {
      const evals = [];
      for (const id of Object.keys(SCENARIOS)) evals.push(...(await plune(['--only', id, '--runs', '1'], pick(id))).result!.evals);
      return { schemaVersion: 1, summary: { cost_usd: 0, duration_ms: 0 }, evals };
    };
    fs.writeFileSync(path.join(results, 'model-a.json'), JSON.stringify(await merged((id) => SCENARIOS[id]!.right)));
    fs.writeFileSync(path.join(results, 'model-b.json'), JSON.stringify(await merged((id) => SCENARIOS[id]!.wrong[0]!.script)));
    const junit = path.join(dir, 'junit', 'scenarios.xml');
    const md = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'mcp-agent-scenarios-report.mjs'), results, junit]);
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}`))));
    });
    expect(md).toContain('| Scenario | model-a | model-b |');
    expect(md).toContain('| orient-in-project | pass 1/1 | FAIL 0/1 |');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml.match(/<testcase /g)).toHaveLength(2 * Object.keys(SCENARIOS).length);
    expect(xml.match(/<failure /g)).toHaveLength(Object.keys(SCENARIOS).length);
    expect(xml).toContain('classname="mcp-agent-scenarios.model-b" name="no-bulk-delete"');
    expect(xml).toContain('<failure message="0 of 1 runs passed, 1 needed">');
  }, 120_000);
});
