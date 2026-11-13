import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AUTOMATION_FILE_MAX_BYTES,
  AUTOMATION_FILES_MAX,
  CairnFailedError,
  CairnMissingError,
  CairnProducedNothingError,
  CaseNotAutomatableError,
  CaseNotFoundError,
  automationProposal,
  caseToAtcMarkdown,
  findTestCall,
  formatSent,
  handleAutomate,
  newFilesDiff,
  NoTestCallError,
  ProposalBoundsError,
  ProposalRefusedError,
  reportAutomateFailure,
  sendAutomation,
  type AutomateResult,
  type PlatformCaseDetail,
} from '../automate.js';
import { NotLoggedInError, SyncHttpError } from '../sync.js';

const TOKEN = 'plune_secret_do_not_leak';

/**
 * A stand-in for Cairn: reads `--run <dir>` and `--dump <file>`, writes what it was started with (its environment,
 * the `.env` copy it was pointed at, its argv and cwd) into the dump, then behaves as `STUB_MODE` says. Started with
 * `--version`, it writes its environment to `STUB_VERSION_DUMP` and prints its version.
 */
const STUB = `
import * as fs from 'node:fs';
import * as path from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  if (process.env.STUB_VERSION_DUMP) fs.writeFileSync(process.env.STUB_VERSION_DUMP, JSON.stringify(process.env));
  console.log('0.10.0');
  process.exit(0);
}
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

const run = (
  over: { mode?: string; env?: NodeJS.ProcessEnv; fetch?: ReturnType<typeof stubFetch>; cairn?: string; withCairnVersion?: boolean } = {},
) =>
  handleAutomate({
    withCairnVersion: over.withCairnVersion ?? false,
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
    const versionDump = path.join(dir, 'version-env.json');
    // As `--send` runs it: `cairn --version` is a second start of Cairn, and it gets the same environment.
    const out = await run({
      withCairnVersion: true,
      env: {
        PLUNE_TOKEN: TOKEN,
        PLUNE_API_URL: 'https://api.test',
        plune_run: 'rk_1',
        ELSEWHERE: `Bearer ${TOKEN}`,
        KEEP: 'yes',
        STUB_VERSION_DUMP: versionDump,
      },
    });
    expect(out.cairnVersion).toBe('0.10.0');
    const d = dumped();
    const leaked = Object.entries(d.env).filter(([k, v]) => /^PLUNE_/i.test(k) || v.includes(TOKEN));
    expect(leaked).toEqual([]);
    const versionEnv = JSON.parse(fs.readFileSync(versionDump, 'utf8')) as Record<string, string>;
    expect(Object.keys(versionEnv).filter((k) => /^PLUNE_/i.test(k))).toEqual([]);
    expect(fs.readFileSync(versionDump, 'utf8')).not.toContain(TOKEN);
    expect(versionEnv['KEEP']).toBe('yes');
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

/**
 * `automationInputSchema` of the platform's `src/contracts/review-item.ts`, as it stands: strict, so a field the
 * server does not store fails here as it would there. Kept by hand; a change on the server's side is a change here.
 */
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const automationInputContract = z
  .object({
    testCaseId: z.string().min(1),
    caseFile: z.string().min(1),
    snapshot: z.string().refine((t) => t.trim() !== ''),
    specRef: z.string().min(1).max(400),
    files: z
      .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
      .min(1)
      .max(10)
      .refine((f) => new Set(f.map((x) => x.path)).size === f.length),
    baseHash: sha.optional(),
    origin: z
      .object({
        tool: z.string().trim().min(1).max(32),
        version: z.string().trim().min(1).max(32),
        cliVersion: z.string().trim().min(1).max(32).optional(),
      })
      .strict(),
    runCost: z.object({ tokens: z.number(), cases: z.number() }).optional(),
  })
  .strict()
  .refine((v) => v.files.some((f) => f.path === v.caseFile));

const HASH = 'a'.repeat(64);
const SPEC =
  "import { test, expect } from '@playwright/test';\n\ntest('cart keeps the item', async ({ page }) => {\n  await expect(page).toHaveURL(/cart/);\n});\n";
const result = (files: { path: string; content: string }[], over: Partial<PlatformCaseDetail> = {}): AutomateResult => ({
  case: { ...CASE, ...over },
  files,
  diff: newFilesDiff(files),
  cairnVersion: '0.10.0',
});

/** A fetch that records each request and answers every one with `status` and `body`. */
function recordingFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}
const send = async (f: ReturnType<typeof recordingFetch>, out = result([{ path: 'cart.spec.ts', content: SPEC }])) =>
  sendAutomation(automationProposal(out, '0.36.0'), { apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: f.fn });

describe('plune automate --send', () => {
  it('posts the files the diff shows, the spec file and its test() as the case code, in the contract shape', async () => {
    // What Cairn wrote, end to end through the stub: the diff and the proposal name the same files.
    const out = await run({ withCairnVersion: true });
    const f = recordingFetch(201, { id: 'ri-1', automation: { refused: [] } });
    await sendAutomation(automationProposal({ ...out, case: { ...out.case, codeSnapshotHash: HASH } }, '0.36.0'), {
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: f.fn,
    });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://api.test/v1/review-items/automations');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` });
    const body = JSON.parse(String(init.body)) as z.infer<typeof automationInputContract>;
    expect(automationInputContract.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      testCaseId: 'case-1',
      caseFile: 'tests/cart.spec.ts',
      snapshot: "test('cart', async () => {})",
      specRef: 'tests/cart.spec.ts:2',
      files: out.files.map((x) => ({ path: `tests/${x.path}`, content: x.content })),
      baseHash: HASH,
      origin: { tool: 'cairn', version: '0.10.0', cliVersion: '0.36.0' },
    });
    // Every file of the proposal is a file of the diff, whole; and the snapshot is in the case file word for word.
    for (const file of body.files) expect(out.diff).toContain(`+++ b/${file.path}\n`);
    expect(body.files.find((x) => x.path === body.caseFile)!.content).toContain(body.snapshot);
  });

  it('a case with no code yet sends no baseHash', () => {
    expect(automationProposal(result([{ path: 'cart.spec.ts', content: SPEC }]), '0.36.0')).not.toHaveProperty('baseHash');
  });

  it('refuses over the bounds before anything is sent, naming each one', async () => {
    const f = recordingFetch(201, {});
    const many = Array.from({ length: AUTOMATION_FILES_MAX + 1 }, (_, i) => ({ path: `p${i}.ts`, content: 'x' }));
    const big = { path: 'big.ts', content: 'x'.repeat(AUTOMATION_FILE_MAX_BYTES + 1) };
    // Five files of 16 384 bytes (two-byte characters): each one fits, together they are over 64 KiB.
    const total = Array.from({ length: 5 }, (_, i) => ({ path: `t${i}.ts`, content: 'é'.repeat(AUTOMATION_FILE_MAX_BYTES / 2) }));
    const spec = { path: 'cart.spec.ts', content: SPEC };
    await expect(send(f, result([spec, ...many]))).rejects.toThrow(/12 files, at most 10/);
    await expect(send(f, result([spec, big]))).rejects.toThrow(/tests\/big\.ts: 16385 bytes, at most 16384 a file/);
    await expect(send(f, result([spec, ...total]))).rejects.toThrow(/bytes in all, at most 65536/);
    await expect(send(f, result([spec, big]))).rejects.toBeInstanceOf(ProposalBoundsError);
    expect(f.calls).toEqual([]);
  });

  it("refuses Cairn's files when none has a test() call", () => {
    expect(() =>
      automationProposal(result([{ path: 'pages/cart.page.ts', content: 'export class CartPage {}' }]), '0.36.0'),
    ).toThrow(NoTestCallError);
  });

  it('201 is a new entry, 200 the waiting one replaced; each says so', async () => {
    const created = await send(recordingFetch(201, { id: 'ri-1', revision: 1, automation: { refused: [] } }));
    expect(created).toEqual({ id: 'ri-1', replaced: false, revision: 1, refused: [] });
    expect(formatSent(created, 'Cart')).toBe("Queued a new proposal for 'Cart': review item ri-1.\n");

    const replaced = await send(
      recordingFetch(200, {
        id: 'ri-1',
        revision: 3,
        automation: { refused: [{ path: 'tests/big.ts', bytes: 20000, reason: 'too-big' }] },
      }),
    );
    expect(replaced.replaced).toBe(true);
    expect(formatSent(replaced, 'Cart')).toBe(
      "Replaced the proposal waiting for 'Cart': review item ri-1, now revision 3.\n  not kept by the server: tests/big.ts (20000 bytes, too-big)\n",
    );
  });

  it("a refusal prints the server's status, code and words, exit 1; a rejected token is exit 2", async () => {
    const lines: string[] = [];
    const w = (s: string) => void lines.push(s);
    const refused = await send(recordingFetch(409, { error: 'the case file did not arrive', code: 'code_refused' })).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ProposalRefusedError);
    expect(reportAutomateFailure(refused, w)).toBe(1);
    expect(lines.pop()).toBe('The platform refused the proposal — HTTP 409 code_refused: the case file did not arrive.\n');

    const invalid = await send(recordingFetch(400, { error: 'validation failed — snapshot: not in caseFile' })).catch(
      (e: unknown) => e,
    );
    expect(reportAutomateFailure(invalid, w)).toBe(1);
    expect(lines.pop()).toBe('The platform refused the proposal — HTTP 400: validation failed — snapshot: not in caseFile.\n');

    expect(reportAutomateFailure(await send(recordingFetch(401, { error: 'no' })).catch((e: unknown) => e), w)).toBe(2);
    expect(reportAutomateFailure(new ProposalBoundsError(['x']), w)).toBe(2);
    expect(reportAutomateFailure(new NoTestCallError(), w)).toBe(1);
    expect(lines.join('')).not.toContain(TOKEN);
  });
});

describe('findTestCall', () => {
  it('takes the whole call, past parentheses in strings, templates, regexes and comments', () => {
    const src = [
      "import { test } from '@playwright/test';",
      '// test("not this one", () => {})',
      "test.describe('cart', () => {",
      "  test.skip(({ browserName }) => browserName === 'webkit', 'no (webkit)');",
      "  test('keeps (the) item', async ({ page }) => {",
      '    await page.goto(`/cart?x=${encodeURIComponent(")")}`);',
      '    await expect(page).toHaveURL(/\\)$/);',
      "    /* ) */ const s = ')';",
      '  });',
      '});',
    ].join('\n');
    const call = findTestCall(src)!;
    expect(call.line).toBe(5);
    expect(call.text.startsWith("test('keeps (the) item'")).toBe(true);
    expect(call.text.endsWith("const s = ')';\n  })")).toBe(true);
  });

  it('a file with no test() call has none', () => {
    expect(findTestCall('export const testing = () => test2();')).toBeUndefined();
  });
});
