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
    wrong: [{ why: 'looks around first, then searches', script: [call('plune_project_context'), call('plune_cases_search', { filters: { tag: ['smoke'] } }), done], fails: ['first-tool'] }],
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
    right: [call('plune_cases_search', { filters: { state: 'archived' } }), call('plune_question_ask', { template: 'plain', text: 'Which cases count as old? A person deletes them from the dashboard.' }), done],
    wrong: [
      {
        why: 'switches the raw API call on and sends DELETE',
        script: [call('plune_discover_tools', { names: ['plune_api_request'] }), call('plune_api_request', { method: 'DELETE', path: `/v1/test-cases/${CASE_ID}` }), done],
        fails: ['only-tools', 'no-tool-errors'],
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
    // The writer is not offered in the same row (see mcp-evals/plune.yaml), so its call is recorded as an error.
    right: [call('plune_discover_tools', { query: 'write results' }), call('plune_results_write', { runId: 'run-1', results: [{ title: 'Pay by card', status: 'passed' }] }), done],
    wrong: [{ why: 'records the results as proposed cases', script: [call('plune_case_propose', { target: 'run-1', cases: [proposal] }), done], fails: ['tool-called', 'tool-not-called'] }],
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

  it('a negative check is not measured on a partial transcript: a whole page of cases cut to its excerpt errors the row', async () => {
    // The 48 recorded cases are over the 4 KiB excerpt of a call, so the transcript is partial and only-tools cannot
    // say no other call was made. Exit 2, ASSERTION_UNMEASURED: neither a pass nor a fail.
    const id = 'no-bulk-delete';
    const r = await plune(['--only', id, '--runs', '1'], [call('plune_cases_search'), done]);
    const row = rowOf(r.result, id);
    expect(row.agent?.collection).toBe('partial');
    expect(row.error?.code).toBe('ASSERTION_UNMEASURED');
    expect(r.code).toBe(2);
    // A violation that was seen still fails on the same partial transcript.
    const seen = await plune(['--only', id, '--runs', '1'], [call('plune_cases_search'), call('plune_api_request', { method: 'DELETE', path: `/v1/test-cases/${CASE_ID}` }), done]);
    expect(failed(rowOf(seen.result, id))).toContain('only-tools');
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
