// The whole contract of a server in one snapshot: server, instructions, capabilities, tools, resources, resource
// templates and prompts, and the classified diff of each, one case per rule of the table.

import { describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  diffSnapshots,
  parseSnapshot,
  renderDiffMarkdown,
  renderDiffText,
  serializeSnapshot,
  SnapshotFormatError,
  SNAPSHOT_SCHEMA_VERSION,
  type ContractChange,
  type SnapshotInput,
} from '../index.js';

type Listed = Record<string, unknown>;

const TOOL: Listed = {
  name: 'weather_get',
  description: 'Get the current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const RESOURCE: Listed = {
  uri: 'file:///docs/readme.md',
  name: 'readme',
  description: 'The readme.',
  mimeType: 'text/markdown',
};
const TEMPLATE: Listed = {
  uriTemplate: 'file:///docs/{name}',
  name: 'doc',
  description: 'One doc.',
  mimeType: 'text/markdown',
};
const PROMPT: Listed = {
  name: 'review',
  description: 'Review a change.',
  arguments: [
    { name: 'diff', description: 'The change', required: true },
    { name: 'style', description: 'House style' },
  ],
};

const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  transport: 'stdio',
  serverInfo: { name: 'docs', version: '1.0.0' },
  instructions: 'Use the docs tools.',
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: {},
  },
  tools: [TOOL],
  resources: [RESOURCE],
  resourceTemplates: [TEMPLATE],
  prompts: [PROMPT],
  ...over,
});
const copy = <T>(v: T): T => structuredClone(v);
const changes = (before: SnapshotInput, after: SnapshotInput) =>
  diffSnapshots(buildSnapshot(before), buildSnapshot(after)).changes;
function only(before: SnapshotInput, after: SnapshotInput): ContractChange {
  const all = changes(before, after);
  expect(all, JSON.stringify(all, null, 2)).toHaveLength(1);
  return all[0] as ContractChange;
}
const verdict = (c: ContractChange) => ({
  entity: c.entity,
  field: c.field,
  kind: c.kind,
  classification: c.classification,
});

describe('CLI · mcp snapshot · the format', () => {
  it('CLI · mcp snapshot · every section is there, keys sorted, kind and schemaVersion on top', () => {
    const s = buildSnapshot(input());
    expect(s).toMatchObject({
      kind: 'plune-mcp-snapshot',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      transport: 'stdio',
    });
    expect(Object.keys(JSON.parse(serializeSnapshot(s)) as object)).toEqual([
      'capabilities',
      'instructions',
      'kind',
      'prompts',
      'resourceTemplates',
      'resources',
      'schemaVersion',
      'server',
      'tools',
      'transport',
    ]);
    expect(s.server).toEqual({ name: 'docs', version: '1.0.0' });
    expect(s.prompts?.[0]?.arguments?.map((a) => a.name)).toEqual(['diff', 'style']);
  });

  it('CLI · mcp snapshot · a capability the server did not declare is null, a declared one with nothing in it is []', () => {
    const s = buildSnapshot({
      transport: 'http',
      serverInfo: { name: 'x', version: '1' },
      capabilities: { tools: {} },
      tools: [],
    });
    expect([s.tools, s.resources, s.resourceTemplates, s.prompts, s.instructions]).toEqual([
      [],
      null,
      null,
      null,
      null,
    ]);
  });

  it('CLI · mcp snapshot · a declared capability without its list given is refused, not written as null', () => {
    expect(() => buildSnapshot({ transport: 'stdio', capabilities: { resources: {} } })).toThrow(
      /declares resources/,
    );
  });

  it('CLI · mcp snapshot · entities sort by code units, not by a locale (upper case, Cyrillic)', () => {
    const names = ['яблуко', 'Zeta', 'alpha', 'Яблуко', 'b', 'Ärger', 'ґанок', 'Alpha'];
    const s = buildSnapshot(input({ tools: names.map((name) => ({ ...TOOL, name })) }));
    expect(s.tools?.map((t) => t.name)).toEqual([
      'Alpha',
      'Zeta',
      'alpha',
      'b',
      'Ärger',
      'Яблуко',
      'яблуко',
      'ґанок',
    ]);
    const prompts = buildSnapshot(input({ prompts: names.map((name) => ({ name })) })).prompts?.map(
      (p) => p.name,
    );
    expect(prompts).toEqual(['Alpha', 'Zeta', 'alpha', 'b', 'Ärger', 'Яблуко', 'яблуко', 'ґанок']);
  });

  it('CLI · mcp snapshot · the order of every list from the server changes nothing (AC-1)', () => {
    const twoResources = [RESOURCE, { ...RESOURCE, uri: 'file:///docs/a.md' }];
    const a = input({ resources: twoResources, tools: [TOOL, { ...TOOL, name: 'a_tool' }] });
    const b = input({
      resources: [...twoResources].reverse(),
      tools: [{ ...TOOL, name: 'a_tool' }, TOOL],
      prompts: [{ ...PROMPT, arguments: [...(PROMPT['arguments'] as unknown[])].reverse() }],
      capabilities: {
        prompts: {},
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
      },
    });
    expect(serializeSnapshot(buildSnapshot(b))).toBe(serializeSnapshot(buildSnapshot(a)));
  });

  it('CLI · mcp snapshot · a name listed twice keeps both entries, in a fixed order', () => {
    const one = { ...TOOL, description: 'one' };
    const two = { ...TOOL, description: 'two' };
    const a = buildSnapshot(input({ tools: [one, two] }));
    const b = buildSnapshot(input({ tools: [two, one] }));
    expect(a.tools?.map((t) => t.description)).toEqual(['one', 'two']);
    expect(serializeSnapshot(b)).toBe(serializeSnapshot(a));
  });

  it('CLI · mcp snapshot · secrets are masked in every section, server text included', () => {
    const secret = 'sk-live-0123456789';
    const text = serializeSnapshot(
      buildSnapshot(
        input({
          serverInfo: { name: `docs ${secret}`, version: '1' },
          instructions: `Token ${secret}`,
          resources: [{ ...RESOURCE, description: `Read with ${secret}` }],
          prompts: [{ ...PROMPT, description: `Use ${secret}` }],
        }),
        { secrets: [secret] },
      ),
    );
    expect(text).not.toContain(secret);
    expect(text.match(/\[redacted\]/g)).toHaveLength(4);
  });

  it('CLI · mcp snapshot · reads back the same; an unknown version names both versions, and broken JSON is a format error', () => {
    const text = serializeSnapshot(buildSnapshot(input()));
    expect(serializeSnapshot(parseSnapshot(text))).toBe(text);
    const future = text.replace(
      `"schemaVersion": ${SNAPSHOT_SCHEMA_VERSION}`,
      '"schemaVersion": 99',
    );
    expect(() => parseSnapshot(future)).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot(future)).toThrow(
      `schemaVersion 99 is not supported: this plune reads schemaVersion ${SNAPSHOT_SCHEMA_VERSION}`,
    );
    expect(() => parseSnapshot('{"format": "plune-mcp-snapshot/1", "tools": []}')).toThrow(
      /schemaVersion 1 is not supported/,
    );
    expect(() => parseSnapshot('{"kind": "plune-mcp-snapshot", "sch')).toThrow(SnapshotFormatError);
    expect(() =>
      parseSnapshot(text.replace('"uri": "file:///docs/readme.md"', '"url": "x"')),
    ).toThrow(/a resource has no uri/);
  });
});

describe('CLI · mcp diff · resources (AC-8)', () => {
  it('CLI · mcp diff · a resource removed is breaking, added is non-breaking', () => {
    expect(verdict(only(input(), input({ resources: [] })))).toEqual({
      entity: 'resource',
      field: 'resource',
      kind: 'removed',
      classification: 'breaking',
    });
    expect(verdict(only(input({ resources: [] }), input()))).toEqual({
      entity: 'resource',
      field: 'resource',
      kind: 'added',
      classification: 'non-breaking',
    });
  });
  it('CLI · mcp diff · a resource mimeType change is breaking', () => {
    const c = only(input(), input({ resources: [{ ...RESOURCE, mimeType: 'text/plain' }] }));
    expect(verdict(c)).toEqual({
      entity: 'resource',
      field: 'mimeType',
      kind: 'modified',
      classification: 'breaking',
    });
    expect(c.name).toBe('file:///docs/readme.md');
  });
  it('CLI · mcp diff · a resource name change is informational; a description change is informational with the security signal', () => {
    const name = only(input(), input({ resources: [{ ...RESOURCE, name: 'README' }] }));
    expect([name.field, name.classification, name.signal]).toEqual([
      'name',
      'informational',
      undefined,
    ]);
    const desc = only(input(), input({ resources: [{ ...RESOURCE, description: 'Other.' }] }));
    expect([desc.field, desc.classification, desc.signal]).toEqual([
      'description',
      'informational',
      'security',
    ]);
  });
});

describe('CLI · mcp diff · resource templates (AC-8)', () => {
  it('CLI · mcp diff · a changed uriTemplate is one removed and one added', () => {
    const all = changes(
      input(),
      input({ resourceTemplates: [{ ...TEMPLATE, uriTemplate: 'file:///docs/{slug}' }] }),
    );
    expect(all.map((c) => [c.entity, c.name, c.kind, c.classification])).toEqual([
      ['resourceTemplate', 'file:///docs/{name}', 'removed', 'breaking'],
      ['resourceTemplate', 'file:///docs/{slug}', 'added', 'non-breaking'],
    ]);
  });
  it('CLI · mcp diff · a template mimeType change is breaking, its description is informational with the signal', () => {
    expect(
      only(input(), input({ resourceTemplates: [{ ...TEMPLATE, mimeType: 'text/html' }] }))
        .classification,
    ).toBe('breaking');
    expect(
      only(input(), input({ resourceTemplates: [{ ...TEMPLATE, description: 'x' }] })).signal,
    ).toBe('security');
  });
});

describe('CLI · mcp diff · prompts (AC-8)', () => {
  const withArgs = (args: unknown[]) => input({ prompts: [{ ...PROMPT, arguments: args }] });
  const ARGS = PROMPT['arguments'] as Listed[];
  it('CLI · mcp diff · a prompt removed is breaking', () => {
    expect(verdict(only(input(), input({ prompts: [] })))).toEqual({
      entity: 'prompt',
      field: 'prompt',
      kind: 'removed',
      classification: 'breaking',
    });
  });
  it('CLI · mcp diff · a new required argument is breaking, a new optional one non-breaking', () => {
    expect(verdict(only(input(), withArgs([...ARGS, { name: 'lang', required: true }])))).toEqual({
      entity: 'prompt',
      field: 'arguments.lang',
      kind: 'added',
      classification: 'breaking',
    });
    expect(only(input(), withArgs([...ARGS, { name: 'lang' }])).classification).toBe(
      'non-breaking',
    );
  });
  it('CLI · mcp diff · an argument removed is breaking', () => {
    expect(verdict(only(input(), withArgs([ARGS[0]])))).toEqual({
      entity: 'prompt',
      field: 'arguments.style',
      kind: 'removed',
      classification: 'breaking',
    });
  });
  it('CLI · mcp diff · a prompt description change is informational with the security signal', () => {
    const c = only(input(), input({ prompts: [{ ...PROMPT, description: 'Review it.' }] }));
    expect([c.field, c.classification, c.signal]).toEqual([
      'description',
      'informational',
      'security',
    ]);
  });
  it('CLI · mcp diff · an argument that became required is breaking', () => {
    expect(only(input(), withArgs([ARGS[0], { ...ARGS[1], required: true }])).classification).toBe(
      'breaking',
    );
  });
});

describe('CLI · mcp diff · capabilities and the server (AC-8)', () => {
  const caps = (capabilities: Record<string, unknown>, over: Partial<SnapshotInput> = {}) =>
    input({ capabilities, ...over });
  it('CLI · mcp diff · a capability removed is breaking, added is non-breaking', () => {
    const before = caps({
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: {},
      logging: {},
    });
    expect(verdict(only(before, input()))).toEqual({
      entity: 'capability',
      field: 'capability',
      kind: 'removed',
      classification: 'breaking',
    });
    expect(verdict(only(input(), before))).toEqual({
      entity: 'capability',
      field: 'capability',
      kind: 'added',
      classification: 'non-breaking',
    });
  });
  it('CLI · mcp diff · listChanged and subscribe: removed is breaking, added is non-breaking', () => {
    const noList = caps({
      tools: {},
      resources: { subscribe: true, listChanged: true },
      prompts: {},
    });
    expect(verdict(only(input(), noList))).toEqual({
      entity: 'capability',
      field: 'listChanged',
      kind: 'removed',
      classification: 'breaking',
    });
    expect(only(noList, input()).classification).toBe('non-breaking');
    const noSub = caps({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: {},
    });
    expect(verdict(only(input(), noSub))).toEqual({
      entity: 'capability',
      field: 'subscribe',
      kind: 'removed',
      classification: 'breaking',
    });
    expect(only(noSub, input()).classification).toBe('non-breaking');
  });
  it('CLI · mcp diff · server.name is informational with its own mark; server.version is informational', () => {
    const name = only(input(), input({ serverInfo: { name: 'docs2', version: '1.0.0' } }));
    expect([name.entity, name.field, name.classification, name.signal]).toEqual([
      'server',
      'name',
      'informational',
      'identity',
    ]);
    const version = only(input(), input({ serverInfo: { name: 'docs', version: '1.0.1' } }));
    expect([version.field, version.classification, version.signal]).toEqual([
      'version',
      'informational',
      undefined,
    ]);
  });
  it('CLI · mcp diff · changed instructions are informational with the security signal', () => {
    const c = only(input(), input({ instructions: 'Use the docs tools first.' }));
    expect([c.entity, c.classification, c.signal]).toEqual([
      'instructions',
      'informational',
      'security',
    ]);
  });
});

describe('CLI · mcp diff · security signals on tools (AC-9)', () => {
  const tool = (annotations: Listed, extra: Listed = {}) =>
    input({ tools: [{ ...TOOL, annotations, ...extra }] });
  it('CLI · mcp diff · readOnlyHint true to false and destructiveHint to true carry the signal', () => {
    const ro = only(input(), tool({ readOnlyHint: false, destructiveHint: false }));
    expect([ro.field, ro.signal]).toEqual(['annotations.readOnlyHint', 'security']);
    const destructive = only(input(), tool({ readOnlyHint: true, destructiveHint: true }));
    expect([destructive.field, destructive.signal]).toEqual([
      'annotations.destructiveHint',
      'security',
    ]);
  });
  it('CLI · mcp diff · a new tool without readOnlyHint is non-breaking with the signal; with it, no signal', () => {
    const bare = changes(
      input(),
      input({ tools: [TOOL, { name: 'shell_run', description: 'Run a command.' }] }),
    );
    expect(bare.map((c) => [c.name, c.classification, c.signal])).toEqual([
      ['shell_run', 'non-breaking', 'security'],
    ]);
    const safe = changes(input(), input({ tools: [TOOL, { ...TOOL, name: 'a_get' }] }));
    expect(safe.map((c) => [c.name, c.classification, c.signal])).toEqual([
      ['a_get', 'non-breaking', undefined],
    ]);
  });
  it('CLI · mcp diff · the human rendering shows the signal as a badge', () => {
    const diff = diffSnapshots(
      buildSnapshot(input()),
      buildSnapshot(tool({ readOnlyHint: false })),
    );
    expect(renderDiffText(diff)).toMatch(/annotations\.readOnlyHint +modified \[security\]/);
  });
});

describe('CLI · mcp diff · a name listed twice', () => {
  it('CLI · mcp diff · a duplicate that appears is breaking, never a silent overwrite', () => {
    const c = only(input(), input({ tools: [TOOL, { ...TOOL, description: 'Another one.' }] }));
    expect([c.entity, c.name, c.field, c.classification]).toEqual([
      'tool',
      'weather_get',
      'duplicate',
      'breaking',
    ]);
    expect(c.reason).toContain('2 times');
  });
  it('CLI · mcp diff · the same duplicates on both sides are no change', () => {
    const twice = input({ tools: [TOOL, { ...TOOL, description: 'Another one.' }] });
    expect(changes(twice, copy(twice))).toEqual([]);
  });
});

describe('CLI · mcp diff · review round: rules that must not be fooled', () => {
  const obj = (properties: Listed, required: string[]) => ({
    type: 'object',
    properties,
    required,
  });
  const t = (inputSchema: unknown, extra: Listed = {}): Listed => ({
    name: 't',
    description: 'd',
    inputSchema,
    annotations: { readOnlyHint: true },
    ...extra,
  });
  const tools = (...list: Listed[]) => input({ tools: list });

  it('CLI · mcp diff · several equal entries to one: the one is compared with each and the worst class is kept', () => {
    const before = t(obj({ a: { type: 'string', enum: ['x', 'y', 'z'] } }, ['a']));
    const after = t(obj({ a: { type: 'string', enum: ['x'] }, b: { type: 'string' } }, ['a', 'b']));
    const diff = diffSnapshots(buildSnapshot(tools(before, before)), buildSnapshot(tools(after)));
    expect(diff.summary.overall).toBe('breaking');
    expect(diff.changes.map((c) => [c.field, c.classification])).toEqual(
      expect.arrayContaining([
        ['inputSchema.a', 'breaking'],
        ['inputSchema.b', 'breaking'],
      ]),
    );
  });

  it('CLI · mcp diff · several different entries to one: the comparison with the worst outcome is reported', () => {
    const a = t(obj({ a: { type: 'string' } }, []));
    const b = t(obj({ a: { type: 'string' }, z: { type: 'string', format: 'x' } }, []));
    // The one left is `a`: against `a` no change, against `b` a parameter removed (breaking).
    const diff = diffSnapshots(buildSnapshot(tools(a, b)), buildSnapshot(tools(a)));
    expect(diff.summary.breaking).toBe(1);
    expect(diff.changes.find((c) => c.classification === 'breaking')?.field).toBe('inputSchema.z');
  });

  it('CLI · mcp diff · markdown escapes server text: no comment, tag or backtick from the server survives', () => {
    const name = 'a`<img src=x>`<!-- plune-eval-diff -->';
    const e = (values: string[]) => ({
      ...t(obj({ e: { type: 'string', enum: values } }, ['e'])),
      name,
    });
    const md = renderDiffMarkdown(
      diffSnapshots(
        buildSnapshot(
          tools(e(['<!-- plune-eval-diff -->', '<a href="https://e.example">ok</a>', 'k'])),
        ),
        buildSnapshot(tools(e(['k']))),
      ),
    );
    expect(md).not.toContain('<!--');
    expect(md).not.toContain('<img');
    expect(md).not.toContain('<a ');
    expect(md).not.toContain('`a');
    expect(md).toContain('&lt;img src=x&gt;');
    expect(md).toContain('&#96;');
  });

  it('CLI · mcp diff · a file nested far too deep is a format error, not a crash', () => {
    const nested = `${'['.repeat(200_000)}1${']'.repeat(200_000)}`;
    const deep = `{"kind": "plune-mcp-snapshot", "schemaVersion": 2, "transport": "stdio", "server": null, "instructions": null, "capabilities": {}, "tools": [{"name": "t", "inputSchema": {"examples": ${nested}}}], "resources": null, "resourceTemplates": null, "prompts": null}`;
    expect(() => parseSnapshot(deep)).toThrow(SnapshotFormatError);
    expect(() => parseSnapshot(deep)).toThrow(/nested deeper than/);
  });

  it('CLI · mcp diff · execution is kept; taskSupport becoming required is breaking, other execution changes not classified', () => {
    const ex = (execution: unknown) =>
      tools(t(obj({}, []), execution === undefined ? {} : { execution }));
    expect(buildSnapshot(ex({ taskSupport: 'optional' })).tools?.[0]).toMatchObject({
      execution: { taskSupport: 'optional' },
    });
    for (const from of [undefined, { taskSupport: 'optional' }, { taskSupport: 'forbidden' }]) {
      const c = only(ex(from), ex({ taskSupport: 'required' }));
      expect([c.field, c.classification, c.unclassified], JSON.stringify(from)).toEqual([
        'execution.taskSupport',
        'breaking',
        undefined,
      ]);
    }
    const other = only(ex({ taskSupport: 'required' }), ex({ taskSupport: 'optional' }));
    expect([other.field, other.unclassified]).toEqual(['execution.taskSupport', true]);
  });

  it('CLI · mcp snapshot · arrays inside data keywords (default, const, examples, enum) keep their order', () => {
    const s = buildSnapshot(
      tools(
        t(
          obj(
            {
              a: {
                type: 'object',
                default: { type: ['b', 'a'], required: ['z', 'y'] },
                examples: [{ type: ['d', 'c'] }],
              },
            },
            [],
          ),
        ),
      ),
    );
    const a = (s.tools?.[0]?.inputSchema as { properties: { a: Listed } }).properties.a;
    expect(a['default']).toEqual({ type: ['b', 'a'], required: ['z', 'y'] });
    expect(a['examples']).toEqual([{ type: ['d', 'c'] }]);
    // A property named like a data keyword is still a schema, and its sets are still sorted.
    const named = buildSnapshot(tools(t(obj({ default: { type: ['string', 'null'] } }, []))));
    const prop = (named.tools?.[0]?.inputSchema as { properties: { default: Listed } }).properties
      .default;
    expect(prop['type']).toEqual(['null', 'string']);
  });

  it('CLI · mcp snapshot · only the home directory given is replaced, so other users stay apart', () => {
    const p = (values: string[]) => t(obj({ p: { type: 'string', enum: values } }, ['p']));
    const opts = { home: '/home/carol' };
    const c = diffSnapshots(
      buildSnapshot(tools(p(['/home/alice', '/home/bob'])), opts),
      buildSnapshot(tools(p(['/home/alice'])), opts),
    ).changes;
    expect(c.map((x) => [x.field, x.classification])).toEqual([['inputSchema.p', 'breaking']]);
    const text = serializeSnapshot(
      buildSnapshot(
        tools(t(obj({}, []), { description: 'Reads /home/carol/x and /home/carolyn/z' })),
        opts,
      ),
    );
    expect(text).toContain('Reads ~/x and /home/carolyn/z');
    const win = serializeSnapshot(
      buildSnapshot(tools(t(obj({}, []), { description: 'Reads c:\\users\\Carol\\y' })), {
        home: 'C:\\Users\\carol',
      }),
    );
    expect(win).toContain('Reads ~\\\\y');
  });

  it('CLI · mcp diff · server keys named like Object members are not taken for hints or flags', () => {
    const ctor = only(
      tools(t(obj({}, []))),
      tools(t(obj({}, []), { annotations: { readOnlyHint: true, constructor: 'x' } })),
    );
    expect([ctor.field, ctor.unclassified]).toEqual(['annotations.constructor', true]);
    const caps = (flag: boolean) =>
      input({
        capabilities: {
          tools: { toString: flag },
          resources: { subscribe: true, listChanged: true },
          prompts: {},
        },
      });
    const flag = only(caps(false), caps(true));
    expect([flag.entity, flag.field, flag.unclassified]).toEqual(['capability', 'toString', true]);
  });

  it('CLI · mcp diff · a new prompt argument whose required is not a boolean is not classified', () => {
    const withArgs = (args: unknown[]) => input({ prompts: [{ name: 'p', arguments: args }] });
    const c = only(withArgs([]), withArgs([{ name: 'x', required: 'true' }]));
    expect([c.field, c.unclassified]).toEqual(['arguments.x', true]);
  });

  it('CLI · mcp snapshot · a declared resources capability without a template list gives resourceTemplates null', () => {
    const s = buildSnapshot(input({ resourceTemplates: null }));
    expect(s.resourceTemplates).toBeNull();
    expect(s.resources).toHaveLength(1);
  });

  it('CLI · mcp snapshot · a credential is masked at any length; other secrets from 4 characters', () => {
    const text = serializeSnapshot(
      buildSnapshot(input({ instructions: 'key k9z and ab' }), {
        credentials: ['k9z'],
        secrets: ['ab'],
      }),
    );
    expect(text).toContain('"key [redacted] and ab"');
  });
});
