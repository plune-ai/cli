// The contract snapshot and its classified diff, rule by rule: each rule has a case of its own, so dropping one turns a
// test red.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  diffSnapshots,
  parseSnapshot,
  renderDiffMarkdown,
  renderDiffText,
  serializeSnapshot,
  type ContractChange,
  type SnapshotTool,
  type ToolSnapshot,
} from '../index.js';

type Listed = Record<string, unknown>;

const tool = (extra: Listed = {}): Listed => ({
  name: 'weather_get',
  title: 'Weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      city: { type: 'string', description: 'The city name' },
      units: { type: 'string', enum: ['metric', 'imperial'] },
      days: { type: 'integer' },
    },
    required: ['city'],
  },
  outputSchema: {
    type: 'object',
    properties: { temperature: { type: 'number' }, note: { type: 'string' } },
    required: ['temperature'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  ...extra,
});

const snap = (...tools: Listed[]) => buildSnapshot(tools);

/** The weather tool with its input schema edited by `edit` (a deep copy, so cases never share state). */
function withInput(edit: (s: { properties: Record<string, Record<string, unknown>>; required: string[] } & Listed) => void): Listed {
  const t = structuredClone(tool());
  edit(t['inputSchema'] as never);
  return t;
}
function withOutput(edit: (s: { properties: Record<string, Record<string, unknown>>; required: string[] } & Listed) => void): Listed {
  const t = structuredClone(tool());
  edit(t['outputSchema'] as never);
  return t;
}

const changes = (before: Listed[], after: Listed[]) => diffSnapshots(snap(...before), snap(...after)).changes;
/** The one change of a case, so a case that also produced something else fails. */
function only(before: Listed[], after: Listed[]): ContractChange {
  const all = changes(before, after);
  expect(all, JSON.stringify(all, null, 2)).toHaveLength(1);
  return all[0] as ContractChange;
}
const verdict = (c: ContractChange) => ({ field: c.field, kind: c.kind, classification: c.classification });

describe('mcp snapshot · stable text', () => {
  it('two independent builds of the same answer give the same text byte for byte (AC-1)', () => {
    expect(serializeSnapshot(snap(tool(), tool({ name: 'stock_get' })))).toBe(serializeSnapshot(snap(tool(), tool({ name: 'stock_get' }))));
  });

  it('key order, the order of required names and $schema change nothing: the same text and no diff', () => {
    const original = withInput((s) => (s.required = ['city', 'days']));
    const reordered = structuredClone(original);
    const input = reordered['inputSchema'] as Record<string, unknown>;
    reordered['inputSchema'] = {
      required: ['days', 'city'],
      properties: Object.fromEntries(Object.entries(input['properties'] as object).reverse()),
      type: 'object',
    };
    reordered['annotations'] = { openWorldHint: true, destructiveHint: false, readOnlyHint: true };
    const a = snap(original);
    const b = snap(reordered);
    expect(serializeSnapshot(b)).toBe(serializeSnapshot(a));
    expect(diffSnapshots(a, b).changes).toEqual([]);
    expect(serializeSnapshot(a)).not.toContain('$schema');
  });

  it('tools by name, keys sorted at every level, two-space indent, one LF at the end, reads back the same', () => {
    const text = serializeSnapshot(snap(tool({ name: 'z_tool' }), tool({ name: 'a_tool' })));
    const parsed = parseSnapshot(text);
    expect(parsed.tools.map((t) => t.name)).toEqual(['a_tool', 'z_tool']);
    expect(Object.keys(parsed.tools[0] as object)).toEqual(['annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title']);
    expect(text).toMatch(/^\{\n {2}"format"/);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(serializeSnapshot(parsed)).toBe(text);
  });

  it('keeps only the contract fields of an entry, and a property named __proto__ as a property', () => {
    const t = tool({ _meta: { a: 1 }, icons: [] });
    (t['inputSchema'] as { properties: Record<string, unknown> }).properties = JSON.parse('{"__proto__": {"type": "string"}}');
    const [s] = snap(t).tools;
    expect(Object.keys(s as object)).not.toContain('_meta');
    expect(Object.keys((s?.inputSchema as { properties: object }).properties)).toEqual(['__proto__']);
  });

  it('an entry without a name throws; a file that is not a snapshot throws', () => {
    expect(() => buildSnapshot([{ title: 'x' }])).toThrow(/entry 0 has no name/);
    expect(() => parseSnapshot('{"tools": []}')).toThrow(/not a plune-mcp-snapshot/);
    expect(() => parseSnapshot('{"format": "plune-mcp-snapshot/1", "tools": [{}]}')).toThrow(/no name/);
  });
});

describe('mcp snapshot · secrets stay out (AC-9)', () => {
  it('header values, a token, the server address and a home directory do not reach the file', () => {
    const secrets = ['Bearer sk-live-0123456789abcdef', 'plt_9f8e7d6c5b4a', 'https://mcp.internal.example:8443'];
    const t = tool({
      description: `Calls https://mcp.internal.example:8443/v1 with Authorization: Bearer sk-live-0123456789abcdef; config in /home/jdoe/.config/x and C:\\Users\\jdoe\\AppData.`,
    });
    (t['inputSchema'] as { properties: Record<string, unknown> }).properties['token'] = {
      type: 'string',
      default: 'plt_9f8e7d6c5b4a',
      examples: ['plt_9f8e7d6c5b4a', '/Users/jdoe/key.pem'],
    };
    const text = serializeSnapshot(buildSnapshot([t], { secrets }));
    for (const leaked of [...secrets, 'sk-live-0123456789abcdef', 'mcp.internal.example', 'jdoe']) expect(text).not.toContain(leaked);
    expect(text).toContain('[redacted]');
    expect(text).toContain('~/.config/x');
  });

  it('a short value is not taken for a secret, and a /home/ inside a URL path is not a machine path', () => {
    const t = tool({ description: 'Returns 1 page of https://example.com/home/page for the city.' });
    const text = serializeSnapshot(buildSnapshot([t], { secrets: ['1', ''] }));
    expect(text).toContain('Returns 1 page of https://example.com/home/page');
  });
});

describe('mcp snapshot · breaking (AC-2)', () => {
  it('a tool removed', () => {
    expect(verdict(only([tool(), tool({ name: 'stock_get' })], [tool()]))).toEqual({ field: 'tool', kind: 'removed', classification: 'breaking' });
  });
  it('a new required parameter', () => {
    const after = withInput((s) => {
      s.properties['country'] = { type: 'string' };
      s.required.push('country');
    });
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.country', kind: 'added', classification: 'breaking' });
  });
  it('a parameter removed', () => {
    const after = withInput((s) => delete s.properties['days']);
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.days', kind: 'removed', classification: 'breaking' });
  });
  it('a parameter became required', () => {
    const after = withInput((s) => s.required.push('days'));
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.days', kind: 'modified', classification: 'breaking' });
  });
  it('a type changed', () => {
    const after = withInput((s) => (s.properties['days'] = { type: 'string' }));
    const c = only([tool()], [after]);
    expect(verdict(c)).toEqual({ field: 'inputSchema.days', kind: 'modified', classification: 'breaking' });
    expect([c.before, c.after]).toEqual(['integer', 'string']);
  });
  it('an enum narrowed', () => {
    const after = withInput((s) => (s.properties['units'] = { type: 'string', enum: ['metric'] }));
    const c = only([tool()], [after]);
    expect(verdict(c)).toEqual({ field: 'inputSchema.units', kind: 'modified', classification: 'breaking' });
    expect(c.reason).toContain('"imperial"');
  });
  it('an enum put on a free value narrows it', () => {
    const after = withInput((s) => (s.properties['city'] = { type: 'string', description: 'The city name', enum: ['Kyiv'] }));
    expect(only([tool()], [after]).classification).toBe('breaking');
  });
  it('a nested parameter: new required field inside an array of objects', () => {
    const nested = (required: string[]) =>
      withInput((s) => (s.properties['stops'] = { type: 'array', items: { type: 'object', properties: { at: { type: 'string' } }, required } }));
    expect(verdict(only([nested([])], [nested(['at'])]))).toEqual({ field: 'inputSchema.stops[].at', kind: 'modified', classification: 'breaking' });
  });
  it('output: a field removed, a type changed, a field became optional, the schema removed', () => {
    expect(verdict(only([tool()], [withOutput((s) => delete s.properties['note'])]))).toEqual({ field: 'outputSchema.note', kind: 'removed', classification: 'breaking' });
    expect(only([tool()], [withOutput((s) => (s.properties['note'] = { type: 'array' }))]).classification).toBe('breaking');
    expect(verdict(only([tool()], [withOutput((s) => (s.required = []))]))).toEqual({ field: 'outputSchema.temperature', kind: 'modified', classification: 'breaking' });
    expect(verdict(only([tool()], [tool({ outputSchema: undefined })]))).toEqual({ field: 'outputSchema', kind: 'removed', classification: 'breaking' });
  });
});

describe('mcp snapshot · non-breaking (AC-3)', () => {
  it('a new optional parameter', () => {
    const after = withInput((s) => (s.properties['lang'] = { type: 'string' }));
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.lang', kind: 'added', classification: 'non-breaking' });
  });
  it('an enum widened', () => {
    const after = withInput((s) => (s.properties['units'] = { type: 'string', enum: ['metric', 'imperial', 'kelvin'] }));
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.units', kind: 'modified', classification: 'non-breaking' });
  });
  it('an enum only reordered is no change', () => {
    const after = withInput((s) => (s.properties['units'] = { type: 'string', enum: ['imperial', 'metric'] }));
    expect(changes([tool()], [after])).toEqual([]);
  });
  it('a new tool', () => {
    expect(verdict(only([tool()], [tool(), tool({ name: 'stock_get' })]))).toEqual({ field: 'tool', kind: 'added', classification: 'non-breaking' });
  });
  it('a parameter no longer required', () => {
    const after = withInput((s) => (s.required = []));
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'inputSchema.city', kind: 'modified', classification: 'non-breaking' });
  });
  it('output: a field added', () => {
    const after = withOutput((s) => (s.properties['wind'] = { type: 'number' }));
    expect(verdict(only([tool()], [after]))).toEqual({ field: 'outputSchema.wind', kind: 'added', classification: 'non-breaking' });
  });
});

describe('mcp snapshot · description, title, annotations, x-plune', () => {
  it('a description change is its own informational record marked security; a title change is not marked (AC-4)', () => {
    const all = changes([tool()], [tool({ description: 'Get the current weather for any city.', title: 'Weather now' })]);
    expect(all.map((c) => [c.field, c.classification, c.security === true])).toEqual([
      ['title', 'informational', false],
      ['description', 'informational', true],
    ]);
  });
  it('a parameter description change is marked security too', () => {
    const after = withInput((s) => (s.properties['city'] = { type: 'string', description: 'Any city' }));
    const c = only([tool()], [after]);
    expect([c.field, c.classification, c.security]).toEqual(['inputSchema.city', 'informational', true]);
  });
  it('readOnlyHint true to false is breaking; false to true is informational (AC-5)', () => {
    const writer = tool({ annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } });
    expect(verdict(only([tool()], [writer]))).toEqual({ field: 'annotations.readOnlyHint', kind: 'modified', classification: 'breaking' });
    expect(verdict(only([writer], [tool()]))).toEqual({ field: 'annotations.readOnlyHint', kind: 'modified', classification: 'informational' });
  });
  it('readOnlyHint true to unset is breaking: unset means false', () => {
    expect(only([tool()], [tool({ annotations: { destructiveHint: false, openWorldHint: true } })]).classification).toBe('breaking');
  });
  it('destructiveHint false to true is breaking; other hints are informational', () => {
    expect(only([tool()], [tool({ annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true } })]).classification).toBe('breaking');
    const c = only([tool()], [tool({ annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })]);
    expect([c.field, c.classification, c.unclassified]).toEqual(['annotations.openWorldHint', 'informational', undefined]);
  });
  it('x-plune: write false to true and visibility core to discoverable are breaking; the reverse is informational', () => {
    const plune = (visibility: 'core' | 'discoverable', write: boolean): ToolSnapshot => ({
      format: 'plune-mcp-snapshot/1',
      tools: [{ ...(snap(tool()).tools[0] as SnapshotTool), 'x-plune': { visibility, write } }],
    });
    const d = (a: ToolSnapshot, b: ToolSnapshot) => diffSnapshots(a, b).changes.map((c) => [c.field, c.classification]);
    expect(d(plune('core', false), plune('core', true))).toEqual([['x-plune.write', 'breaking']]);
    expect(d(plune('core', false), plune('discoverable', false))).toEqual([['x-plune.visibility', 'breaking']]);
    expect(d(plune('discoverable', true), plune('core', false))).toEqual([
      ['x-plune.visibility', 'informational'],
      ['x-plune.write', 'informational'],
    ]);
  });
});

describe('mcp snapshot · nothing is lost (AC-6)', () => {
  it('an unknown change is informational with "Could not classify", counted apart', () => {
    const after = withInput((s) => (s.properties['days'] = { type: 'integer', maximum: 7 }));
    const diff = diffSnapshots(snap(tool()), snap(after));
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ field: 'inputSchema.days', classification: 'informational', unclassified: true });
    expect(diff.changes[0]?.reason).toMatch(/^Could not classify: `maximum` changed/);
    expect(diff.summary).toMatchObject({ informational: 1, unclassified: 1, overall: 'informational' });
  });
  it('an enum changed both ways cannot be compared: informational, not classified', () => {
    const after = withInput((s) => (s.properties['units'] = { type: 'string', enum: ['metric', 'kelvin'] }));
    expect(only([tool()], [after])).toMatchObject({ classification: 'informational', unclassified: true });
  });
  it('an output enum, an unknown annotation and an unknown x-plune field are not dropped', () => {
    const out = withOutput((s) => (s.properties['note'] = { type: 'string', enum: ['a'] }));
    expect(only([tool()], [out])).toMatchObject({ unclassified: true });
    expect(only([tool()], [tool({ annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, x: 1 } })])).toMatchObject({
      field: 'annotations.x',
      unclassified: true,
    });
  });
  it('the summary counts every class, the worst is overall, and both renderings list each change', () => {
    const after = [
      withInput((s) => {
        delete s.properties['days'];
        s.properties['lang'] = { type: 'string' };
      }),
    ];
    after[0]!['description'] = 'Other | words';
    const diff = diffSnapshots(snap(tool()), snap(...after));
    expect(diff.summary).toEqual({ breaking: 1, 'non-breaking': 1, informational: 1, unclassified: 0, security: 1, overall: 'breaking' });
    const text = renderDiffText(diff);
    expect(text).toContain('3 change(s) to the tool contract, overall breaking: 1 breaking, 1 non-breaking, 1 informational (0 not classified, 1 security)');
    expect(text).toContain('description  modified [security]');
    const md = renderDiffMarkdown(diff);
    expect(md).toContain('| breaking | `weather_get` | `inputSchema.days` | removed |');
    expect(md).toContain('| informational (security) | `weather_get` | `description` | modified |');
    expect(renderDiffText({ changes: [], summary: diffSnapshots(snap(), snap()).summary })).toBe('No changes to the tool contract.');
    expect(diffSnapshots(snap(), snap()).summary.overall).toBe('none');
  });
});

describe('mcp snapshot · the module stands alone', () => {
  const dir = join(__dirname, '..');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));
  const specifiers = (text: string) =>
    [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|^import\s+'([^']+)'|\b(?:import|require)\(\s*'([^']+)'/gm)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? '',
    );

  it('has source files to check', () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['index.ts', 'snapshot.ts', 'diff.ts']));
  });

  it('imports nothing but its own files', () => {
    for (const { file, text } of sources) {
      for (const s of specifiers(text)) expect(s.startsWith('./'), `${file} imports ${s}`).toBe(true);
    }
  });
});
