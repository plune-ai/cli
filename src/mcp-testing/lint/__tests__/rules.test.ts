// The lint rules over a `tools/list` answer, rule by rule: a list that sets each one off and a list that does not.
// A rule without both is a test failure, so a rule cannot land, or be dropped from the registry, unnoticed.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LINT_RULES,
  LINT_THRESHOLDS,
  applyExceptions,
  detectLanguage,
  gates,
  lintTools,
  toolListSize,
  type LintException,
  type LintFinding,
  type ListedTool,
} from '../index.js';

/** A tool no rule has anything to say about; each case changes one thing. */
const clean = (name = 'weather_get', extra: Partial<ListedTool> = {}): ListedTool => ({
  name,
  title: 'Weather',
  description: 'Get the current weather for a city. Do not use it for forecasts; use the forecast tool instead.',
  inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'The city name' } }, required: ['city'] },
  outputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ...extra,
});

const withParams = (properties: Record<string, unknown>, extra: Partial<ListedTool> = {}) =>
  clean('weather_get', { inputSchema: { type: 'object', properties, required: [] }, ...extra });

const writer = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const ids = (tools: ListedTool[]) => lintTools(tools).map((f) => f.id);
const one = (tools: ListedTool[], id: string) => lintTools(tools).filter((f) => f.id === id);

const RULE_CASES: Record<string, { fires: ListedTool[][]; quiet: ListedTool[][] }> = {
  'input-schema-not-object': {
    fires: [[clean('weather_get', { inputSchema: { type: 'array' } })], [clean('weather_get', { inputSchema: null })]],
    quiet: [[clean()], [clean('weather_get', { inputSchema: { type: 'object', additionalProperties: false } })]],
  },
  'output-schema-not-object': {
    fires: [[clean('weather_get', { outputSchema: { type: 'string' } })]],
    quiet: [[clean()], [clean('weather_get', { outputSchema: undefined })]],
  },
  'required-unknown-property': {
    // Only a closed node (additionalProperties: false, no composition) can make a required name unsatisfiable.
    fires: [
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'The city' } }, required: ['town'], additionalProperties: false } })],
      [withParams({ days: { type: 'array', description: 'Days', items: { type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['day'], additionalProperties: false } } })],
    ],
    quiet: [
      [clean()],
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['town'] } })],
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['town'], additionalProperties: { type: 'string' } } })],
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['town'], additionalProperties: false, allOf: [{ properties: { town: { type: 'string' } } }] } })],
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['town'], additionalProperties: false, $ref: '#/$defs/town' } })],
      [clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['town'], additionalProperties: false, patternProperties: { '^t': { type: 'string' } } } })],
    ],
  },
  'name-duplicate': {
    fires: [[clean(), clean()]],
    quiet: [[clean('weather_get'), clean('stock_get')]],
  },
  'name-invalid': {
    fires: [[clean('weather get!')], [clean('w'.repeat(LINT_THRESHOLDS.names.maxLength + 1))]],
    quiet: [[clean('admin.tools-list_v2')], [clean('w'.repeat(LINT_THRESHOLDS.names.maxLength))]],
  },
  'desc-missing': {
    fires: [[clean('weather_get', { description: '   ' })], [clean('weather_get', { description: undefined })]],
    quiet: [[clean()]],
  },
  'desc-short': {
    fires: [[clean('weather_get', { description: 'Get the weather.' })]],
    quiet: [[clean()], [clean('weather_get', { description: undefined })]],
  },
  'desc-long': {
    fires: [[clean('weather_get', { description: `Do not use it for forecasts. ${'x'.repeat(LINT_THRESHOLDS.description.maxLength)}` })]],
    quiet: [[clean()]],
  },
  'desc-no-when-not': {
    fires: [[clean('weather_get', { description: 'Get the current weather for a city, with the temperature and the wind.' })]],
    quiet: [
      [clean()],
      // German is not a listed language: the rule stays silent rather than demand an English phrase.
      [clean('weather_get', { description: 'Liefert das aktuelle Wetter einer Stadt mit Temperatur und Wind.' })],
    ],
  },
  'tools-similar': {
    fires: [
      [clean('weather_get'), clean('get_weather', { description: 'Read the weather of a town now. Never call it for a forecast.' })],
      [clean('weather_get'), clean('stock_get')],
    ],
    quiet: [
      [clean('weather_get'), clean('stock_quote', { description: 'Look up the latest price of a stock ticker on its exchange. Not for funds.' })],
    ],
  },
  'param-enum-in-text': {
    fires: [[withParams({ unit: { type: 'string', description: 'The unit, one of celsius or fahrenheit' } })]],
    quiet: [[withParams({ unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'The unit, one of celsius or fahrenheit' } })], [clean()]],
  },
  'param-type-by-name': {
    fires: [
      [withParams({ maxCount: { type: 'string', description: 'How many' } })],
      [withParams({ isActive: { type: 'string', description: 'Whether active' } })],
      [withParams({ homepageUrl: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The page' } })],
    ],
    quiet: [
      [withParams({ maxCount: { type: 'integer', description: 'How many' } })],
      [withParams({ homepageUrl: { type: 'string', format: 'uri', description: 'The page' } })],
      [withParams({ thisIsIt: { type: 'string', description: 'A word, not a flag' } })],
    ],
  },
  'param-desc-missing': {
    fires: [[withParams({ city: { type: 'string' } })]],
    quiet: [[clean()]],
  },
  'param-example-missing': {
    fires: [
      [withParams({ filters: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query filters of the list' } })],
      [withParams({ cases: { type: 'array', description: 'Cases', items: { type: 'object', properties: { changes: { type: 'object' } } } } })],
      [withParams({ results: { type: 'array', description: 'Results as the API takes them', items: { type: 'object' } } })],
    ],
    quiet: [
      [withParams({ filters: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query filters, e.g. {"tag": "smoke"}' } })],
      [withParams({ filters: { type: 'object', examples: [{ tag: 'smoke' }], description: 'Query filters' } })],
      [withParams({ filters: { type: 'object', additionalProperties: false, description: 'Nothing' } })],
    ],
  },
  'required-missing': {
    fires: [[clean('weather_get', { inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'The city' } } } })]],
    quiet: [[clean()], [clean('weather_get', { inputSchema: { type: 'object' } })]],
  },
  'name-style-mismatch': {
    fires: [[clean('weather_get'), clean('stock_get', { description: 'Read the price of a stock. Not for funds.' }), clean('fundQuote', { description: 'Read the price of a fund. Not for stocks.' })]],
    quiet: [[clean('weather_get'), clean('stock_get', { description: 'Read the price of a stock. Not for funds.' })]],
  },
  'name-not-snake': {
    fires: [[clean('getWeather')]],
    quiet: [[clean()]],
  },
  'annotations-missing': {
    fires: [[clean('weather_get', { annotations: undefined })]],
    quiet: [[clean()]],
  },
  'hint-readonly-writes': {
    fires: [[clean('weather_update')]],
    quiet: [[clean()], [clean('weather_update', { annotations: writer })]],
  },
  'hint-destructive-understated': {
    fires: [[clean('weather_update', { annotations: { ...writer, destructiveHint: false } })]],
    quiet: [[clean('weather_update', { annotations: writer })], [clean('weather_create', { annotations: { ...writer, destructiveHint: false } })]],
  },
  'hint-idempotent-missing': {
    fires: [[clean('weather_update', { annotations: { readOnlyHint: false } })]],
    quiet: [[clean()], [clean('weather_update', { annotations: writer })]],
  },
  'list-no-paging': {
    fires: [[clean('cities_list')]],
    quiet: [[clean('cities_list', { inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Page size' }, cursor: { type: 'string', description: 'Next page' } }, required: [] } })], [clean()]],
  },
  'list-size': {
    fires: [[clean(), clean('stock_get', { description: `Read a stock. Not for funds. ${'x'.repeat(LINT_THRESHOLDS.size.maxListTokens * LINT_THRESHOLDS.size.charsPerToken)}` })]],
    quiet: [[clean()]],
  },
};

describe('mcp lint · rule registry', () => {
  it('has one entry per id, each with a class, a level and a fix; every deterministic rule cites the specification', () => {
    const seen = new Set<string>();
    for (const rule of LINT_RULES) {
      expect(seen.has(rule.id), rule.id).toBe(false);
      seen.add(rule.id);
      expect(rule.id, rule.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(['measure', 'deterministic', 'heuristic'], rule.id).toContain(rule.class);
      expect(['error', 'warn', 'info'], rule.id).toContain(rule.level);
      expect(rule.fix.trim().length, `${rule.id} has no fix`).toBeGreaterThan(0);
      expect(typeof rule.specRef, rule.id).toBe('string');
      if (rule.class === 'deterministic') expect(rule.specRef, rule.id).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\//);
    }
  });

  it('has a firing and a quiet case for every rule, and no case for a rule that does not exist', () => {
    expect(Object.keys(RULE_CASES).sort()).toEqual(LINT_RULES.map((r) => r.id).sort());
    for (const [id, c] of Object.entries(RULE_CASES)) {
      expect(c.fires.length, id).toBeGreaterThan(0);
      expect(c.quiet.length, id).toBeGreaterThan(0);
    }
  });
});

describe('mcp lint · rules', () => {
  for (const [id, c] of Object.entries(RULE_CASES)) {
    it.each(c.fires.map((tools, i) => [i, tools] as const))(`${id} fires on case %i`, (_i, tools) => {
      const found = one(tools, id);
      expect(found.length, `${id} on ${JSON.stringify(tools.map((t) => t.name))}: ${JSON.stringify(ids(tools))}`).toBeGreaterThan(0);
      for (const f of found) {
        expect(f.state).toBe('failed');
        expect(f.message.length).toBeGreaterThan(0);
        expect(f.target.tool.length).toBeGreaterThan(0);
      }
    });
    it.each(c.quiet.map((tools, i) => [i, tools] as const))(`${id} stays quiet on case %i`, (_i, tools) => {
      expect(one(tools, id)).toEqual([]);
    });
  }

  it('a clean tool sets off no rule at all', () => {
    expect(lintTools([clean()])).toEqual([]);
  });

  it('names a nested parameter by its path', () => {
    const [f] = one(RULE_CASES['param-example-missing']!.fires[1]!, 'param-example-missing');
    expect(f?.target).toEqual({ tool: 'weather_get', param: 'cases[].changes' });
    const [r] = one(RULE_CASES['required-unknown-property']!.fires[1]!, 'required-unknown-property');
    expect(r?.target).toEqual({ tool: 'weather_get', param: 'days[].day' });
  });

  it('desc-no-when-not is a warning when a similar tool exists', () => {
    const plain = 'Get the current weather for a city, with the temperature and the wind.';
    const [alone] = one([clean('weather_get', { description: plain })], 'desc-no-when-not');
    expect(alone?.level).toBe('info');
    const pair = [clean('weather_get', { description: plain }), clean('weather_now', { description: `${plain} Now.` })];
    expect(one(pair, 'desc-no-when-not').map((f) => f.level)).toEqual(['warn', 'warn']);
  });

  it('list-size names the biggest tool', () => {
    const [f] = one(RULE_CASES['list-size']!.fires[0]!, 'list-size');
    expect(f?.target.tool).toBe('stock_get');
    expect(f?.message).toContain('stock_get');
    expect(f?.class).toBe('measure');
  });

  it('a shared server prefix does not make every pair of names look alike', () => {
    const tools = [clean('acme_weather_get'), clean('acme_stock_quote', { description: 'Look up the latest price of a stock ticker on its exchange. Not for funds.' })];
    expect(one(tools, 'tools-similar')).toEqual([]);
  });
});

describe('mcp lint · Ukrainian descriptions', () => {
  const pairs: [string, string, string][] = [
    [
      'a description with "when not to use"',
      'Get the current weather for a city. Do not use it for forecasts; use the forecast tool instead.',
      'Повертає поточну погоду для міста. Не використовуйте його для прогнозу: замість нього є інструмент прогнозу.',
    ],
    [
      'a description without it',
      'Get the current weather for a city, with the temperature and the wind in it.',
      'Повертає поточну погоду для міста, з температурою і вітром у ній.',
    ],
    ['a description with "only"', 'Get the weather of a city; only for the current hour.', 'Повертає погоду для міста; лише для поточної години.'],
  ];

  it.each(pairs)('%s gives the same verdict in both languages', (_what, en, uk) => {
    expect(ids([clean('weather_get', { description: uk })])).toEqual(ids([clean('weather_get', { description: en })]));
  });

  it('a closed set named in Ukrainian is caught like the English one', () => {
    const en = withParams({ unit: { type: 'string', description: 'The unit of measure, one of celsius or fahrenheit' } });
    const uk = withParams({ unit: { type: 'string', description: 'Одиниця вимірювання, одне з: celsius або fahrenheit' } });
    expect(one([uk], 'param-enum-in-text')).toHaveLength(1);
    expect(ids([uk])).toEqual(ids([en]));
  });

  it('an example given in Ukrainian counts as an example', () => {
    const en = withParams({ filters: { type: 'object', description: 'The filters of the list, for example {"tag": "smoke"}' } });
    const uk = withParams({ filters: { type: 'object', description: 'Фільтри списку, наприклад {"tag": "smoke"} і {"suiteId": "s1"}' } });
    expect(ids([uk])).toEqual(ids([en]));
    expect(ids([uk])).not.toContain('param-example-missing');
  });

  it('a language that is not listed keeps the word rules silent', () => {
    const ru = 'Возвращает текущую погоду для города, с температурой и ветром.';
    expect(detectLanguage(ru)).toBeUndefined();
    expect(one([clean('weather_get', { description: ru })], 'desc-no-when-not')).toEqual([]);
    const free = withParams({ filters: { type: 'object', description: 'Фильтры списка задач по тегу' } });
    expect(one([free], 'param-example-missing')).toEqual([]);
  });

  it('detects the language by its alphabet and stop words', () => {
    expect(detectLanguage('Get the weather for a city')).toBe('en');
    expect(detectLanguage('Повертає погоду для міста і його району')).toBe('uk');
    expect(detectLanguage('Wetter für eine Stadt')).toBeUndefined();
    expect(detectLanguage('12345 — ...')).toBeUndefined();
  });
});

describe('mcp lint · gates', () => {
  const finding = (over: Partial<LintFinding>): LintFinding => ({
    id: 'x',
    class: 'deterministic',
    level: 'error',
    state: 'failed',
    target: { tool: 't' },
    message: 'm',
    expected: 'e',
    actual: 'a',
    fix: 'f',
    specRef: '',
    ...over,
  });

  it('a heuristic never gates, even at error', () => {
    expect(gates(finding({ class: 'heuristic' }))).toBe(false);
    expect(gates(finding({ class: 'heuristic' }), 'info')).toBe(false);
  });

  it('a deterministic or measured error gates, and could-not-run is never a pass', () => {
    expect(gates(finding({}))).toBe(true);
    expect(gates(finding({ class: 'measure' }))).toBe(true);
    expect(gates(finding({ state: 'could-not-run' }))).toBe(true);
  });

  it('passed, not-applicable and pending do not gate; a warning gates only when asked', () => {
    for (const state of ['passed', 'not-applicable', 'pending'] as const) expect(gates(finding({ state }))).toBe(false);
    expect(gates(finding({ level: 'warn' }))).toBe(false);
    expect(gates(finding({ level: 'warn' }), 'warn')).toBe(true);
    expect(gates(finding({ level: 'info' }), 'warn')).toBe(false);
  });
});

describe('mcp lint · exceptions', () => {
  const findings = lintTools([clean('weather_get', { annotations: undefined })]);
  const exception: LintException = { id: 'annotations-missing', target: { tool: 'weather_get' }, reason: 'The client ignores hints.' };

  it('sets a finding aside only with a reason', () => {
    const applied = applyExceptions(findings, [exception]);
    expect(applied.findings).toEqual([]);
    expect(applied.excepted.map((e) => e.finding.id)).toEqual(['annotations-missing']);
    expect(applied.unused).toEqual([]);
  });

  it('refuses an exception without a reason', () => {
    expect(() => applyExceptions(findings, [{ ...exception, reason: '  ' }])).toThrow(/needs a reason: annotations-missing on weather_get/);
    expect(() => applyExceptions(findings, [{ ...exception, target: { tool: 'weather_get', param: 'city' }, reason: '' }])).toThrow(/weather_get\.city/);
  });

  it('reports an exception that no longer matches anything', () => {
    const stale = { ...exception, target: { tool: 'gone_get' } };
    const applied = applyExceptions(findings, [stale]);
    expect(applied.findings.map((f) => f.id)).toEqual(['annotations-missing']);
    expect(applied.unused).toEqual([stale]);
  });
});

describe('mcp lint · size', () => {
  it('sums a per-tool estimate and names the biggest tool', () => {
    const tools = [clean(), clean('stock_get', { description: 'y'.repeat(400) })];
    const size = toolListSize(tools);
    const each = tools.map((t) => Math.ceil(JSON.stringify(t).length / LINT_THRESHOLDS.size.charsPerToken));
    expect(size.tools.map((t) => t.tokens)).toEqual(each);
    expect(size.totalTokens).toBe(each[0]! + each[1]!);
    expect(size.largest?.name).toBe('stock_get');
    expect(toolListSize([]).largest).toBeUndefined();
  });
});

describe('mcp lint · the module stands alone', () => {
  const dir = join(__dirname, '..');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('has source files to check', () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['index.ts', 'rules.ts', 'thresholds.ts', 'types.ts']));
  });

  it('imports nothing but its own files', () => {
    for (const { file, text } of sources) {
      const specifiers = [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'/gm)].map((m) => m[1] ?? m[2] ?? '');
      for (const s of specifiers) expect(s.startsWith('./'), `${file} imports ${s}`).toBe(true);
    }
  });

  it('keeps every threshold in the table: the rule bodies hold no numeric literal but 0 and 1', () => {
    const rules = sources.find((s) => s.file === 'rules.ts')?.text ?? '';
    const code = rules
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
    const numbers = [...code.matchAll(/(?<![\w$.])\d[\d_]*(?:\.\d+)?(?![\w])/g)].map((m) => m[0]);
    expect(numbers.filter((n) => n !== '0' && n !== '1')).toEqual([]);
  });
});
