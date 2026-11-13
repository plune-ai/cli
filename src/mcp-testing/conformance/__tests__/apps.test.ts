// The apps suite of `plune mcp conformance`: each check against a server that keeps its requirement and one that breaks
// it. The servers are processes on this machine (../../__tests__/fixtures/apps-server.mjs, plain JSON-RPC so no SDK
// corrects what it sends); the suite only reads (tools/list, resources/list, resources/read) and calls a tool only
// when --fixture names it.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';
import { opensWithDoctype } from '../checks/apps/index.js';
import { PROFILE } from '../profile.js';

const SERVER = fileURLToPath(new URL('../../__tests__/fixtures/apps-server.mjs', import.meta.url));
// Each run starts a server process; a few of them take longer than the default 5 s.
vi.setConfig({ testTimeout: 60_000 });
const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-apps-'));
const APPS = CATALOG.filter((e) => e.suite === 'apps');
const IDS = [
  'apps-ui-resource-uri-scheme',
  'apps-ui-resource-exists',
  'apps-ui-mime-type',
  'apps-ui-content-payload',
  'apps-ui-listed-mime',
  'apps-ui-visibility-values',
  'apps-ui-tool-text-fallback',
  'apps-ui-meta-shapes',
];

async function run(
  mode: string,
  flags: McpConformanceFlags = {},
  era: 'legacy' | 'modern' = 'legacy',
) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance(
    { timeout: '10s', format: 'json', suite: ['apps'], ...flags },
    [process.execPath, SERVER, mode, ...(era === 'modern' ? ['modern'] : [])],
    { out: (s) => (out += s), err: (s) => (err += s), env: {}, cwd: dir, clientVersion: '9.9.9' },
  );
  const json = (flags.format ?? 'json') === 'json' && out !== '';
  return { code, out, err, report: json ? (JSON.parse(out) as McpConformanceReport) : undefined };
}

const states = (r: McpConformanceReport | undefined) =>
  Object.fromEntries(
    (r?.checks ?? []).map((c) => [
      c.id,
      c.reason === undefined ? c.state : `${c.state} (${c.reason})`,
    ]),
  );
const byId = (r: McpConformanceReport | undefined, id: string) =>
  r!.checks.find((c) => c.id === id)!;
const fixtureFile = (calls: unknown) => {
  const path = join(dir, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(calls));
  return path;
};

describe('CLI · mcp conformance · apps · catalog', () => {
  it('holds the eight ids, each with a level, a quoted requirement, a cited section and a link to the extension text', () => {
    expect(APPS.map((e) => e.id)).toEqual(IDS);
    for (const e of APPS) {
      expect(e.level, e.id).not.toBeNull();
      expect((e.derivation ?? '').trim(), e.id).not.toBe('');
      expect(e.specRefs.length, e.id).toBeGreaterThan(0);
      for (const r of e.specRefs)
        expect(r.url, e.id).toMatch(/^https:\/\/github\.com\/modelcontextprotocol\/ext-apps\//);
      expect(e.transports).toEqual(['stdio', 'http']);
      expect(e.eras).toEqual(['legacy', 'modern']);
    }
  });

  it('a level without a keyword in the text is derived and at most SHOULD; the one check that calls a tool needs a fixture', () => {
    const entry = (id: string) => APPS.find((e) => e.id === id)!;
    for (const id of ['apps-ui-visibility-values', 'apps-ui-meta-shapes']) {
      expect(entry(id).level, id).toBe('SHOULD');
      expect(entry(id).derived, id).toBe(true);
    }
    expect(entry('apps-ui-listed-mime').level).toBe('SHOULD');
    expect(APPS.filter((e) => e.needsFixture).map((e) => e.id)).toEqual([
      'apps-ui-tool-text-fallback',
    ]);
  });

  it('--list-checks --suite apps lists them, and --explain prints the quoted sentence', async () => {
    let out = '';
    await handleMcpConformance({ listChecks: true, suite: ['apps'] }, [], {
      out: (s) => (out += s),
      err: () => {},
      env: {},
    });
    expect(out).toContain(`${IDS.length} checks.`);
    for (const id of IDS) expect(out).toContain(id);
    expect(out).not.toContain('life-initialize-result');
    out = '';
    await handleMcpConformance({ explain: 'apps-ui-mime-type' }, [], {
      out: (s) => (out += s),
      err: () => {},
      env: {},
    });
    expect(out).toContain('`mimeType` MUST be `text/html;profile=mcp-app`');
    expect(out).toContain(
      'https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx',
    );
  });

  it('the checks are not in the frozen profile', () => {
    expect(PROFILE.checks.filter((id) => id.startsWith('apps-'))).toEqual([]);
  });
});

describe('CLI · mcp conformance · apps · a server that keeps its requirements', () => {
  it('passes every check it can be asked without a fixture; the text fallback needs one', async () => {
    const { report } = await run('good');
    expect(states(report)).toEqual({
      'apps-ui-resource-uri-scheme': 'passed',
      'apps-ui-resource-exists': 'passed',
      'apps-ui-mime-type': 'passed',
      'apps-ui-content-payload': 'passed',
      'apps-ui-listed-mime': 'passed',
      'apps-ui-visibility-values': 'passed',
      'apps-ui-tool-text-fallback': 'could-not-run (needs-input)',
      'apps-ui-meta-shapes': 'passed',
    });
  });

  it('passes in the modern revision, where the extension is declared in server/discover', async () => {
    const { report } = await run('good', { protocolVersion: '2026-07-28' }, 'modern');
    expect(report?.era).toBe('modern');
    expect(Object.values(states(report)).filter((s) => s === 'passed')).toHaveLength(7);
  });

  it('takes the HTML given as base64', async () => {
    const { report } = await run('blob-good');
    expect(states(report)['apps-ui-content-payload']).toBe('passed');
  });

  it('shows its verdicts but counts for nothing: a MUST outside the profile is pending, and the run is exit 3', async () => {
    const { report, code } = await run('good');
    expect(report?.summary.pending).toEqual(
      expect.arrayContaining(['apps-ui-resource-exists', 'apps-ui-mime-type']),
    );
    expect(report?.summary.advisories).toEqual(
      expect.arrayContaining([
        'apps-ui-listed-mime',
        'apps-ui-visibility-values',
        'apps-ui-meta-shapes',
      ]),
    );
    expect(code).toBe(3);
  });

  it('a run without --suite is the protocol suite as before: no apps id in it', async () => {
    const { report } = await run('good', { suite: undefined, check: ['life-initialize-result'] });
    expect(report?.suites).toEqual(['protocol']);
    expect(report?.checks.some((c) => c.id.startsWith('apps-'))).toBe(false);
  });

  it('--suite protocol --suite apps runs both in one session', async () => {
    const { report } = await run('good', {
      suite: ['protocol', 'apps'],
      check: ['life-initialize-result', 'apps-ui-mime-type'],
    });
    expect(report?.suites).toEqual(['protocol', 'apps']);
    expect(states(report)['life-initialize-result']).toBe('passed');
    expect(states(report)['apps-ui-mime-type']).toBe('passed');
  });

  it('--suite apps with --suite oauth is refused, as the oauth suite is for now', async () => {
    const { code, err } = await run('good', { suite: ['apps', 'oauth'] });
    expect(code).toBe(2);
    expect(err).toContain('--suite oauth cannot be run together');
  });
});

describe('CLI · mcp conformance · apps · a server with no UI', () => {
  it('is not-applicable on every check, never passed', async () => {
    const { report } = await run('no-ui');
    expect(Object.values(states(report))).toEqual(
      IDS.map(() => 'not-applicable (capability-not-declared)'),
    );
    expect(byId(report, 'apps-ui-mime-type').actual).toContain('no tool has _meta.ui');
  });

  it('is not-applicable in the modern revision too, where it declares no extension', async () => {
    const { report } = await run('no-ui', { protocolVersion: '2026-07-28' }, 'modern');
    expect(Object.values(states(report))).toEqual(
      IDS.map(() => 'not-applicable (capability-not-declared)'),
    );
  });

  it('declaring the extension without a tool that has a UI leaves nothing to read: not-offered', async () => {
    const { report } = await run('ext-only');
    expect(Object.values(states(report))).toEqual(IDS.map(() => 'not-applicable (not-offered)'));
  });
});

describe('CLI · mcp conformance · apps · each requirement broken on its own', () => {
  const cases: [string, string, string, string][] = [
    [
      'a tool names a resource that is not under ui://',
      'wrong-scheme',
      'apps-ui-resource-uri-scheme',
      'failed',
    ],
    ['a resource that is not found', 'missing', 'apps-ui-resource-exists', 'failed'],
    ['text/html instead of the MCP Apps media type', 'wrong-mime', 'apps-ui-mime-type', 'failed'],
    ['both text and blob', 'both', 'apps-ui-content-payload', 'failed'],
    ['neither text nor blob', 'neither', 'apps-ui-content-payload', 'failed'],
    ['a blob that is not base64', 'blob-bad', 'apps-ui-content-payload', 'failed'],
    ['a document with no HTML5 doctype', 'not-html', 'apps-ui-content-payload', 'failed'],
    ['text/html in resources/list', 'wrong-mime', 'apps-ui-listed-mime', 'failed'],
    [
      'a visibility value that is neither model nor app',
      'bad-visibility',
      'apps-ui-visibility-values',
      'failed',
    ],
    [
      'csp, permissions, domain and prefersBorder of the wrong type',
      'bad-meta',
      'apps-ui-meta-shapes',
      'failed',
    ],
  ];
  for (const [what, mode, id, state] of cases)
    it(`${what}: ${id} is ${state}`, async () => {
      const { report } = await run(mode);
      expect(byId(report, id).state).toBe(state);
      expect(byId(report, id).actual).not.toBe('');
      expect(byId(report, id).fix).not.toBe('');
    });

  it('a listed resource of the MCP Apps media type outside ui:// is named, as the tool is', async () => {
    const { report } = await run('wrong-scheme');
    const actual = byId(report, 'apps-ui-resource-uri-scheme').actual;
    expect(actual).toContain('"weather": "https://apps.example/weather"');
    expect(actual).toContain('listed "https://apps.example/other"');
  });

  it('the broken servers leave the checks they do not break alone', async () => {
    expect(states((await run('wrong-mime')).report)['apps-ui-content-payload']).toBe('passed');
    expect(states((await run('not-html')).report)['apps-ui-mime-type']).toBe('passed');
    expect(states((await run('bad-meta')).report)['apps-ui-mime-type']).toBe('passed');
    // Nothing is read, so nothing exists to be judged: not-offered, not a pass.
    expect(states((await run('wrong-scheme')).report)['apps-ui-resource-exists']).toBe(
      'not-applicable (not-offered)',
    );
  });

  it('a failed check does not move the exit code: the run is exit 3 whatever the apps checks say', async () => {
    const { report, code } = await run('missing');
    expect(byId(report, 'apps-ui-resource-exists').state).toBe('failed');
    expect(report?.summary.failed).toEqual([]);
    expect(code).toBe(3);
  });
});

describe('CLI · mcp conformance · apps · what could not be measured', () => {
  it('a resource over the limit is could-not-run, not failed, and says why', async () => {
    const { report } = await run('huge');
    expect(states(report)['apps-ui-content-payload']).toBe('could-not-run (prerequisite-failed)');
    expect(byId(report, 'apps-ui-content-payload').actual).toContain('4 MiB');
    expect(states(report)['apps-ui-mime-type']).toBe('passed');
  });

  it('a read that is never answered is could-not-run (timeout)', async () => {
    const { report } = await run('silent-read', { timeout: '1s' });
    expect(states(report)['apps-ui-resource-exists']).toBe('could-not-run (timeout)');
    expect(states(report)['apps-ui-resource-uri-scheme']).toBe('passed');
  });
});

describe('CLI · mcp conformance · apps · the text fallback needs a tool called, and only a fixture calls one', () => {
  const log = (name: string) => join(dir, `calls-${name}.log`);
  const withLog = async (name: string, mode: string, flags: McpConformanceFlags = {}) => {
    // The server process gets only what --env names.
    return run(mode, { ...flags, env: [`APPS_CALL_LOG=${log(name)}`] });
  };

  it('without --fixture no tool is called at all', async () => {
    const { report } = await withLog('none', 'good');
    expect(states(report)['apps-ui-tool-text-fallback']).toBe('could-not-run (needs-input)');
    expect(existsSync(log('none'))).toBe(false);
  });

  it('a fixture that names no tool with a UI is needs-input as well, and calls nothing else of the suite', async () => {
    const { report } = await withLog('plain', 'good', {
      fixture: fixtureFile([{ tool: 'plain', arguments: {} }]),
    });
    expect(states(report)['apps-ui-tool-text-fallback']).toBe('could-not-run (needs-input)');
    expect(existsSync(log('plain'))).toBe(false);
  });

  it('a content with text passes, and only the tool the fixture names is called', async () => {
    const fixture = fixtureFile([
      { tool: 'weather', arguments: {} },
      { tool: 'plain', arguments: {} },
    ]);
    const { report } = await withLog('weather', 'good', { fixture });
    expect(states(report)['apps-ui-tool-text-fallback']).toBe('passed');
    expect(readFileSync(log('weather'), 'utf8').trim().split('\n')).toEqual(['weather']);
  });

  it('an empty content array fails, and so does a blank text block', async () => {
    const fixture = fixtureFile([{ tool: 'weather', arguments: {} }]);
    expect(
      states((await run('no-fallback', { fixture })).report)['apps-ui-tool-text-fallback'],
    ).toBe('failed');
    expect(
      states((await run('blank-fallback', { fixture })).report)['apps-ui-tool-text-fallback'],
    ).toBe('failed');
  });
});

describe('CLI · mcp conformance · apps · what the server sends is never printed whole', () => {
  it('a long address, HTML and texts that start with :: stay out of the result, in JSON and for a person', async () => {
    for (const format of ['json', 'human']) {
      const { out, err } = await run('hostile', { format });
      const all = `${out}\n${err}`;
      expect(all, format).not.toContain('HTML-BODY-MARKER');
      expect(all, format).not.toContain('<script>');
      expect(all, format).not.toContain('A'.repeat(200));
      expect(all, format).not.toContain('T'.repeat(200));
      expect(all, format).not.toContain('M'.repeat(100));
      expect(all, format).toContain('apps-ui-content-payload');
      for (const line of all.split('\n'))
        expect(line.trimStart().startsWith('::'), `${format}: ${line.slice(0, 40)}`).toBe(false);
    }
  });

  it('what it says of the long address is cut and quoted', async () => {
    const { report } = await run('hostile');
    for (const c of report!.checks) expect(c.actual.length, c.id).toBeLessThanOrEqual(500 + 80);
    expect(byId(report, 'apps-ui-mime-type').state).toBe('failed');
  });
});

describe('CLI · mcp conformance · apps · after review', () => {
  it('a missing resource is the error of its revision: -32002 before 2026-07-28, -32602 from it; the code of the other revision is could-not-run', async () => {
    const id = 'apps-ui-resource-exists';
    expect(states((await run('missing')).report)[id]).toBe('failed');
    expect(
      states((await run('missing', { protocolVersion: '2026-07-28' }, 'modern')).report)[id],
    ).toBe('failed');
    expect(states((await run('missing-other-code')).report)[id]).toBe(
      'could-not-run (prerequisite-failed)',
    );
    expect(
      states((await run('missing-other-code', { protocolVersion: '2026-07-28' }, 'modern')).report)[
        id
      ],
    ).toBe('could-not-run (prerequisite-failed)');
  });

  it('a complete empty comment <!--> or <!---> before the doctype is skipped', () => {
    expect(opensWithDoctype('<!--><!doctype html>')).toBe('yes');
    expect(opensWithDoctype('<!---><!doctype html>')).toBe('yes');
    expect(opensWithDoctype('<!----><!doctype html>')).toBe('yes');
    const t0 = Date.now();
    expect(opensWithDoctype(`${'<!---->'.repeat(290)}x`)).toBe('no');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a secret inside an address is masked before the address is cut, not left as a prefix', async () => {
    const secret = 'Zq7vK2mXpL9wR4tY8nB3cD6fG1hJ5sA0eU2iO';
    for (const format of ['json', 'human']) {
      const { out, err, report } = await run('secret-uri', {
        format,
        env: [`APPS_SECRET=${secret}`],
      });
      const all = `${out}
${err}`;
      expect(all, format).toContain('apps-ui-resource-uri-scheme');
      if (format === 'json') expect(states(report)['apps-ui-resource-uri-scheme']).toBe('failed');
      for (let i = 0; i + 8 <= secret.length; i++)
        expect(all, `${format} ${i}`).not.toContain(secret.slice(i, i + 8));
    }
  });

  it('the visibility quote is the saved text, character for character', () => {
    const e = APPS.find((x) => x.id === 'apps-ui-visibility-values');
    expect(e?.derivation).toContain('`"model"`: Tool is visible to and callable by the agent');
    expect(e?.derivation).toContain(
      '`"app"`: Tool is callable by the app from the same server connection only',
    );
  });

  it('the doctype is found without backtracking: 290 comments then x is failed, then a doctype is passed, fast', async () => {
    const t0 = Date.now();
    const x = await run('comments-x');
    expect(states(x.report)['apps-ui-content-payload']).toBe('failed');
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(states((await run('comments-doctype')).report)['apps-ui-content-payload']).toBe(
      'passed',
    );
    expect(states((await run('comment-unclosed')).report)['apps-ui-content-payload']).toBe(
      'failed',
    );
  }, 20_000);

  it('comments that run past the first 2048 characters are not judged: could-not-run, not failed', async () => {
    const { report } = await run('comments-far');
    expect(states(report)['apps-ui-content-payload']).toBe('could-not-run (prerequisite-failed)');
  });

  it('only -32002 says a resource is not there: an internal error, method-not-found or an empty list is could-not-run', async () => {
    for (const mode of ['error-internal', 'error-method', 'empty-contents'])
      expect(states((await run(mode)).report)['apps-ui-resource-exists'], mode).toBe(
        'could-not-run (prerequisite-failed)',
      );
    expect(states((await run('missing')).report)['apps-ui-resource-exists']).toBe('failed');
  });

  it('over 32 addresses, the checks that read are could-not-run and name how many were not read', async () => {
    const { report } = await run('many');
    for (const id of [
      'apps-ui-resource-exists',
      'apps-ui-mime-type',
      'apps-ui-content-payload',
      'apps-ui-meta-shapes',
    ]) {
      expect(states(report)[id], id).toBe('could-not-run (prerequisite-failed)');
      expect(byId(report, id).actual, id).toMatch(/1 of 33 addresses were not read/);
    }
  });

  it('a tool with only the flat _meta["ui/resourceUri"] is not failed for a missing _meta.ui; any other non-object is', async () => {
    const flat = await run('flat-key');
    expect(states(flat.report)['apps-ui-meta-shapes']).toBe('passed');
    expect(states(flat.report)['apps-ui-resource-uri-scheme']).toBe('passed');
    for (const mode of ['ui-string', 'ui-null', 'ui-array'])
      expect(states((await run(mode)).report)['apps-ui-meta-shapes'], mode).toBe('failed');
  });

  it('a resources/list that cannot be read is said, and the checks that rest on it are could-not-run', async () => {
    const { report } = await run('list-fails');
    for (const id of [
      'apps-ui-resource-uri-scheme',
      'apps-ui-meta-shapes',
      'apps-ui-mime-type',
      'apps-ui-content-payload',
    ]) {
      expect(states(report)[id], id).toBe('could-not-run (prerequisite-failed)');
      expect(byId(report, id).actual, id).toContain('resources/list');
    }
    expect(states(report)['apps-ui-resource-exists']).toBe('passed');
  });

  it('a listed resource with no mimeType is not judged (not-offered); a different one still fails', async () => {
    expect(states((await run('list-no-mime')).report)['apps-ui-listed-mime']).toBe(
      'not-applicable (not-offered)',
    );
    expect(states((await run('wrong-mime')).report)['apps-ui-listed-mime']).toBe('failed');
  });

  it('a media type is compared without letter case and the spaces around ";"', async () => {
    expect(states((await run('mime-case')).report)['apps-ui-mime-type']).toBe('passed');
  });

  it('the same address on several tools and in the list is read once', async () => {
    const readLog = join(dir, 'reads.log');
    await run('good', { env: [`APPS_READ_LOG=${readLog}`] });
    expect(readFileSync(readLog, 'utf8').trim().split('\n')).toEqual(['ui://apps/weather']);
  });
});
