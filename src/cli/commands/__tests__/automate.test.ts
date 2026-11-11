import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CairnFailedError,
  CairnMissingError,
  CairnProducedNothingError,
  CaseNotAutomatableError,
  CaseNotFoundError,
  caseToAtcMarkdown,
  handleAutomate,
  newFilesDiff,
  reportAutomateFailure,
  type PlatformCaseDetail,
} from '../automate.js';
import { NotLoggedInError, SyncHttpError } from '../sync.js';

const TOKEN = 'plune_secret_do_not_leak';

/**
 * A stand-in for Cairn: reads `--run <dir>` and `--dump <file>`, writes what it was started with (its environment,
 * the `.env` copy it was pointed at, its argv and cwd) into the dump, then behaves as `STUB_MODE` says.
 */
const STUB = `
import * as fs from 'node:fs';
import * as path from 'node:path';
const argv = process.argv.slice(2);
const at = (f) => argv[argv.indexOf(f) + 1];
const run = at('--run');
fs.writeFileSync(at('--dump'), JSON.stringify({
  argv, cwd: process.cwd(), env: process.env,
  dotenv: fs.readFileSync(process.env.DOTENV_PATH, 'utf8'),
  testcase: fs.readFileSync(path.join(run, 'testcases', 'ATC-PLUNE-001.md'), 'utf8'),
  report: JSON.parse(fs.readFileSync(path.join(run, 'report.json'), 'utf8')),
}));
const mode = process.env.STUB_MODE ?? 'ok';
if (mode === 'fail') process.exit(3);
if (mode === 'ok') {
  fs.mkdirSync(path.join(run, 'tests', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(run, 'tests', 'cart.spec.ts'), "import { test } from '@playwright/test';\\ntest('cart', async () => {});\\n");
  fs.writeFileSync(path.join(run, 'tests', 'pages', 'cart.page.ts'), 'export class CartPage {}');
}
`;

const CASE: PlatformCaseDetail = {
  id: 'case-1',
  type: 'manual',
  title: 'Cart keeps the "item"',
  precondition: 'Signed in\nCart is empty',
  steps: [{ action: 'Add an item\nto the cart' }, { action: 'Reload', expected: 'The item is still there' }],
};

function stubFetch(status: number, body: unknown): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, urls };
}

let dir: string;
let repo: string;
let stub: string;
let dump: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automate-test-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  stub = path.join(dir, 'cairn-stub.mjs');
  fs.writeFileSync(stub, STUB);
  dump = path.join(dir, 'dump.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (over: { mode?: string; env?: NodeJS.ProcessEnv; fetch?: ReturnType<typeof stubFetch>; cairn?: string } = {}) =>
  handleAutomate({
    caseId: 'case-1',
    repo,
    cairn: over.cairn ?? stub,
    url: 'https://app.test',
    cairnArgs: ['--dump', dump],
    apiUrl: 'https://api.test',
    loadToken: () => TOKEN,
    fetchImpl: (over.fetch ?? stubFetch(200, CASE)).fn,
    env: { PATH: process.env['PATH'] ?? '', STUB_MODE: over.mode ?? 'ok', ...over.env },
  });

const dumped = (): { argv: string[]; cwd: string; env: Record<string, string>; dotenv: string; testcase: string; report: { url: string; mode: string } } =>
  JSON.parse(fs.readFileSync(dump, 'utf8'));

describe('plune automate', () => {
  it('fetches the case, runs Cairn on it in the repo, and returns its files as a new-file diff', async () => {
    const f = stubFetch(200, CASE);
    const out = await run({ fetch: f });
    expect(f.urls).toEqual(['https://api.test/v1/test-cases/case-1']);
    expect(out.files.map((x) => x.path)).toEqual(['cart.spec.ts', 'pages/cart.page.ts']);
    expect(out.diff).toContain('diff --git a/tests/cart.spec.ts b/tests/cart.spec.ts\nnew file mode 100644\n--- /dev/null\n+++ b/tests/cart.spec.ts\n@@ -0,0 +1,2 @@\n+import');
    expect(out.diff).toContain('+export class CartPage {}\n\\ No newline at end of file\n');
    const d = dumped();
    expect(d.argv.slice(0, 2)).toEqual(['automate', '--run']);
    expect(fs.realpathSync(d.cwd)).toBe(fs.realpathSync(repo));
    expect(d.report).toEqual({ url: 'https://app.test', mode: 'design' });
    expect(d.testcase).toContain('execution: auto');
    expect(d.testcase).toContain('1. Add an item to the cart\n2. Reload (expected: The item is still there)');
    // The run folder is temporary: nothing is left behind, and nothing is written into the repo.
    expect(fs.existsSync(path.dirname(d.argv[2]!))).toBe(false);
    expect(fs.readdirSync(repo)).toEqual([]);
  });

  it('starts Cairn with no PLUNE_ key and no value holding the token, and hides them in the .env it reads', async () => {
    fs.writeFileSync(
      path.join(repo, '.env'),
      `ANTHROPIC_API_KEY=sk-test\nPLUNE_TOKEN=${TOKEN}\nexport plune_api_url=https://api.test\nCOPY=${TOKEN}\n`,
    );
    await run({
      env: { PLUNE_TOKEN: TOKEN, PLUNE_API_URL: 'https://api.test', plune_run: 'rk_1', ELSEWHERE: `Bearer ${TOKEN}`, KEEP: 'yes' },
    });
    const d = dumped();
    const leaked = Object.entries(d.env).filter(([k, v]) => /^PLUNE_/i.test(k) || v.includes(TOKEN));
    expect(leaked).toEqual([]);
    expect(d.env['KEEP']).toBe('yes');
    expect(d.dotenv).toBe('ANTHROPIC_API_KEY=sk-test\n');
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('says Cairn is missing before it asks the platform anything', async () => {
    const f = stubFetch(200, CASE);
    await expect(run({ fetch: f, cairn: path.join(dir, 'no-cairn-here.mjs') })).rejects.toBeInstanceOf(CairnMissingError);
    await expect(run({ fetch: f, cairn: 'no-such-cairn-on-path' })).rejects.toBeInstanceOf(CairnMissingError);
    expect(f.urls).toEqual([]);
  });

  it('a case the platform does not have is CaseNotFoundError; another refusal stays as it was', async () => {
    await expect(run({ fetch: stubFetch(404, { error: 'not found' }) })).rejects.toBeInstanceOf(CaseNotFoundError);
    await expect(run({ fetch: stubFetch(500, { error: 'boom' }) })).rejects.toBeInstanceOf(SyncHttpError);
  });

  it('refuses a case with no steps without starting Cairn', async () => {
    await expect(run({ fetch: stubFetch(200, { id: 'case-1', type: 'automated', title: 't', specRef: 'a.spec.ts:1' }) })).rejects.toBeInstanceOf(CaseNotAutomatableError);
    expect(fs.existsSync(dump)).toBe(false);
  });

  it('Cairn failing and Cairn writing nothing are two different errors', async () => {
    await expect(run({ mode: 'fail' })).rejects.toBeInstanceOf(CairnFailedError);
    await expect(run({ mode: 'empty' })).rejects.toBeInstanceOf(CairnProducedNothingError);
  });

  it('keeps the run folder and the repo its own: --run and --into-project are refused', async () => {
    await expect(
      handleAutomate({ caseId: 'c', repo, cairn: stub, cairnArgs: ['--into-project'], loadToken: () => TOKEN }),
    ).rejects.toThrow(/does not write into the repo/);
  });

  it('maps each failure to its exit code', () => {
    const lines: string[] = [];
    const w = (s: string) => void lines.push(s);
    expect(reportAutomateFailure(new CairnMissingError('cairn'), w)).toBe(2);
    expect(reportAutomateFailure(new CaseNotFoundError('c'), w)).toBe(2);
    expect(reportAutomateFailure(new CaseNotAutomatableError('c', 'eval'), w)).toBe(2);
    expect(reportAutomateFailure(new CairnFailedError(3), w)).toBe(1);
    expect(reportAutomateFailure(new CairnProducedNothingError(), w)).toBe(1);
    expect(reportAutomateFailure(new NotLoggedInError(), w)).toBe(2);
    expect(reportAutomateFailure(new Error('x'), w)).toBeNull();
    expect(lines.join('')).not.toContain(TOKEN);
  });
});

describe('caseToAtcMarkdown', () => {
  it("writes the case in Cairn's ATC format, quotes made safe, the case's own expected result first", () => {
    const md = caseToAtcMarkdown({ ...CASE, expected: 'Saved' });
    expect(md).toContain('stableId: case-1\ntitle: "Cart keeps the \'item\'"');
    expect(md).toContain('## Preconditions\n\n- Signed in\n- Cart is empty\n');
    expect(md).toContain('## Expected Result\n\n- Saved\n');
    expect(caseToAtcMarkdown({ ...CASE, precondition: '' })).toContain('- (none)');
  });
});

describe('newFilesDiff', () => {
  it('an empty file has a header and no hunk', () => {
    expect(newFilesDiff([{ path: 'a.ts', content: '' }])).toBe(
      'diff --git a/tests/a.ts b/tests/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/tests/a.ts\n',
    );
  });
});
