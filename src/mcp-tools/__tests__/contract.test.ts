// The tool contract (plune-ai/plune#1284, plune-ai/cli#146): one list of definitions that both the MCP
// server here and the platform's built-in agent (plune-ai/plune#2202) read. What it promises a client
// is checked here, before any transport is involved.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX,
  MAX_VISIBLE_TOOLS,
  PLUNE_TOOLS,
  defaultVisibleTools,
  pluneTool,
} from '../index.js';

const MISSION_TOOLS = [
  'plune_project_context',
  'plune_mission_create',
  'plune_mission_get',
  'plune_mission_update',
  'plune_source_add',
  'plune_question_ask',
  'plune_question_list',
  'plune_case_propose',
  'plune_strategy_propose',
  'plune_report_request',
];

describe('the tool contract', () => {
  it('names every mission tool of cli#146, plus the strategy and the report', () => {
    const names = PLUNE_TOOLS.map((t) => t.name);
    for (const name of MISSION_TOOLS) expect(names).toContain(name);
  });

  it('covers the groups of plune#1284: bootstrap, read, write, review, escape hatch, discover', () => {
    for (const name of [
      'plune_project_context',
      'plune_get',
      'plune_cases_search',
      'plune_cases_update',
      'plune_results_write',
      'plune_run_create',
      'plune_review_list',
      'plune_review_decide',
      'plune_api_request',
      'plune_discover_tools',
      'plune_cases_generate',
      'plune_cases_generation_get',
    ])
      expect(pluneTool(name).name).toBe(name);
  });

  it('gives each tool one unique name under the plune_ prefix', () => {
    const names = PLUNE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^plune_[a-z_]+$/);
  });

  it('AC-01: shows a client at most 20 tools by default', () => {
    expect(MAX_VISIBLE_TOOLS).toBe(20);
    const visible = defaultVisibleTools();
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS);
    expect(visible).toContain('plune_discover_tools');
    // Something has to be behind discover_tools, or AC-02 has nothing to reveal.
    expect(PLUNE_TOOLS.length).toBeGreaterThan(visible.length);
  });

  it('AC-06: describes every tool as a task, not by its name', () => {
    for (const tool of PLUNE_TOOLS) {
      const words = tool.description.trim().split(/\s+/);
      expect(words.length, tool.name).toBeGreaterThanOrEqual(12);
      // A task starts with what the caller wants done: "Create…", "Ask…", "Find…" — a verb, capitalised.
      expect(tool.description, tool.name).toMatch(/^[A-Z][a-z]+ /);
      expect(tool.description.toLowerCase(), tool.name).not.toContain(tool.name);
      expect(tool.title.length, tool.name).toBeGreaterThan(0);
    }
  });

  it('AC-07: no two tools do the same thing — each calls a different set of endpoints', () => {
    const signatures = new Map<string, string>();
    for (const tool of PLUNE_TOOLS) {
      expect(tool.endpoints.length, tool.name).toBeGreaterThan(0);
      for (const e of tool.endpoints) expect(e, tool.name).toMatch(/^(GET|POST|PATCH|PUT|DELETE|ANY|LOCAL) \/\S*$/);
      const key = [...tool.endpoints].sort().join(' | ');
      expect(signatures.get(key), `${tool.name} duplicates ${signatures.get(key)}`).toBeUndefined();
      signatures.set(key, tool.name);
    }
  });

  it('AC-07: no endpoint is the main door of two typed tools', () => {
    const owner = new Map<string, string>();
    for (const tool of PLUNE_TOOLS) {
      if (tool.name === 'plune_api_request' || tool.name === 'plune_project_context') continue;
      for (const e of tool.endpoints) {
        expect(owner.get(e), `${e} is served by ${owner.get(e)} and ${tool.name}`).toBeUndefined();
        owner.set(e, tool.name);
      }
    }
  });

  it('AC-07: no two descriptions are the same text', () => {
    const descriptions = PLUNE_TOOLS.map((t) => t.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('marks which tools write, and every mission writer needs the write scope', () => {
    for (const name of ['plune_mission_create', 'plune_mission_update', 'plune_source_add', 'plune_question_ask', 'plune_case_propose', 'plune_strategy_propose', 'plune_report_request', 'plune_review_decide', 'plune_cases_update', 'plune_results_write', 'plune_run_create', 'plune_cases_generate'])
      expect(pluneTool(name).write, name).toBe(true);
    for (const name of ['plune_project_context', 'plune_mission_get', 'plune_question_list', 'plune_get', 'plune_cases_search', 'plune_review_list', 'plune_discover_tools', 'plune_cases_generation_get'])
      expect(pluneTool(name).write, name).toBe(false);
  });

  it('offers dry_run on every tool that writes through a typed call', () => {
    for (const tool of PLUNE_TOOLS.filter((t) => t.write && t.name !== 'plune_review_decide')) {
      expect(Object.keys(tool.input.shape), tool.name).toContain('dry_run');
    }
  });

  it('AC-03: a batch takes up to 100 objects and refuses the 101st', () => {
    expect(BATCH_MAX).toBe(100);
    const step = 'Open the cart';
    const one = { title: 'Cart keeps items', steps: [step], expected: 'The item is still there' };
    const propose = pluneTool('plune_case_propose').input;
    expect(propose.safeParse({ target: 'https://shop.example', cases: Array(100).fill(one) }).success).toBe(true);
    expect(propose.safeParse({ target: 'https://shop.example', cases: Array(101).fill(one) }).success).toBe(false);
    const update = pluneTool('plune_cases_update').input;
    expect(update.safeParse({ cases: Array(101).fill({ id: 'c', changes: { title: 't' } }) }).success).toBe(false);
  });

  it('starts cases from pasted text only: the Jira-ticket mode is not offered (plune-ai/plune#1876)', () => {
    const generate = pluneTool('plune_cases_generate');
    expect(generate.visibility).toBe('core');
    const text = 'A shopper adds an item to the cart, reloads the page and still sees the item with its price and quantity kept.';
    expect(generate.input.safeParse({ input: { kind: 'pasted-text', text } }).success).toBe(true);
    expect(generate.input.safeParse({ input: { kind: 'pasted-text', text, title: 'Cart' }, maxCases: 12, language: 'en', confirmDuplicates: true }).success).toBe(true);
    expect(generate.input.safeParse({ input: { kind: 'jira-ticket', key: 'PROJ-123' } }).success).toBe(false);
    expect(generate.input.safeParse({ input: { kind: 'pasted-text', text, key: 'PROJ-123' } }).success).toBe(false);
    expect(generate.input.safeParse({ input: { kind: 'pasted-text', text }, maxCases: 13 }).success).toBe(false);
    expect(generate.input.safeParse({ input: { kind: 'pasted-text', text, title: 'x'.repeat(301) } }).success).toBe(false);
    expect(generate.description).toMatch(/review queue/);
    expect(generate.description).toMatch(/AI budget/);
    expect(generate.description).toContain('plune_cases_generation_get');
  });

  it('tells the agent a policy_refused entry needs another reviewer, not a retry (plune-ai/plune#2499)', () => {
    const decide = pluneTool('plune_review_decide');
    expect(decide.description).toContain('policy_refused');
    expect(decide.description).toMatch(/do not retry/);
    expect(decide.description).toMatch(/another reviewer/);
  });

  it('lookups by an unknown name fail loudly', () => {
    expect(() => pluneTool('plune_nope')).toThrow(/unknown tool/);
  });
});

describe('the contract entry point is transport-free', () => {
  const dir = join(__dirname, '..');
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('has source files to check', () => {
    expect(sources.map((s) => s.file)).toContain('index.ts');
  });

  it.each(['@modelcontextprotocol', 'node:fs', 'node:child_process', 'node:readline', 'node:process', 'commander', '../cli'])(
    'imports nothing from %s',
    (banned) => {
      for (const { file, text } of sources) {
        const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
        for (const s of specifiers) expect(s.startsWith(banned), `${file} imports ${s}`).toBe(false);
      }
    },
  );

  it('touches no stdio at import time', () => {
    for (const { file, text } of sources) expect(text, file).not.toMatch(/process\.(stdin|stdout|stderr)/);
  });
});
