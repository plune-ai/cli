// The qa-mission skill (skills/qa-mission) drives the tools of this contract by name. Its text is read here so a
// renamed tool, a dropped argument or a changed case shape fails a test instead of reaching an agent.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPluneToolName, pluneTool } from '../index.js';

const dir = new URL('../../../skills/qa-mission/', import.meta.url);
const files = [
  'SKILL.md',
  ...readdirSync(new URL('references/', dir)).map((f) => `references/${f}`),
];
const texts = new Map(files.map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
const all = [...texts.values()].join('\n');

/** The top-level argument names a tool's input takes. */
const argsOf = (name: string): string[] => Object.keys(pluneTool(name).input.shape);

describe('the qa-mission skill', () => {
  it('has Agent Skills frontmatter: a name that matches its folder and a description', () => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texts.get('SKILL.md')!)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('qa-mission');
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('names only tools the contract has', () => {
    const named = new Set(all.match(/\bplune_[a-z_]+/g));
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(isPluneToolName(name), name).toBe(true);
  });

  it('gives each written call only arguments its tool takes', () => {
    const calls = [...all.matchAll(/`(plune_[a-z_]+)\(([^)]*)\)`/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, name, list] of calls) {
      const args = list!
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      for (const arg of args) expect(argsOf(name!), `${name}(${arg})`).toContain(arg);
    }
  });

  it('drives the mission tools of the flow: context, questions, strategy, cases', () => {
    for (const name of [
      'plune_project_context',
      'plune_mission_get',
      'plune_question_ask',
      'plune_strategy_propose',
      'plune_case_propose',
    ])
      expect(all).toContain(name);
  });

  it('shows example inputs the tools accept as they are written', () => {
    const examples = [
      ...all.matchAll(/<!-- input: (plune_[a-z_]+) -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/g),
    ];
    expect(examples.map((m) => m[1]).sort()).toEqual([
      'plune_api_request',
      'plune_case_propose',
      'plune_question_ask',
      'plune_strategy_propose',
    ]);
    for (const [, name, json] of examples) {
      const parsed = pluneTool(name!).input.safeParse(JSON.parse(json!));
      expect(parsed.error?.issues, name).toBeUndefined();
    }
  });

  it('reads the accepted memory rules at the start and proposes a new one only to the review queue', () => {
    const skill = texts.get('SKILL.md')!;
    const context = skill.indexOf('`plune_project_context()`');
    expect(context).toBeGreaterThan(-1);
    expect(skill.indexOf('memoryRules', context)).toBeGreaterThan(context);
    expect(pluneTool('plune_project_context').output.shape).toHaveProperty('memoryRules');

    const example = /<!-- input: plune_api_request -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/.exec(all)![1]!;
    // The route and source kinds of the platform's memory candidates (POST /v1/memory/candidates).
    const call = JSON.parse(example) as { method: string; path: string; body: { source: { kind: string; id: string } } };
    expect([call.method, call.path]).toEqual(['POST', '/v1/memory/candidates']);
    expect(['answer', 'decline', 'failure_choice', 'report_lesson']).toContain(call.body.source.kind);
    expect(all).toContain('review queue');
  });

  it('ships in the npm package', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });

  it('states the one-of-three rule with an example each, and the order, refusal and headless rules', () => {
    const skill = texts.get('SKILL.md')!;
    const refs = texts.get('references/tool-calls.md')!;
    for (const text of [skill, refs]) {
      expect(text).toMatch(/exactly one of `source`, `assumption` or `waitingOn`/);
    }
    for (const basis of ['"source":', '"assumption": true', '"waitingOn":']) expect(refs).toContain(basis);
    // Propose first, then write the file from what was accepted, with the proposal id in the log.
    const propose = skill.indexOf('plune_strategy_propose(missionId, content, dry_run)');
    const write = skill.indexOf("write `docs/testing/test-strategy.md`");
    expect(propose).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(propose);
    expect(skill).toMatch(/proposal id/i);
    // A refusal: fix what the findings name, try once more, then stop and report.
    const flat = skill.replace(/\s+/g, ' ');
    expect(flat).toMatch(/fix what the findings name/i);
    expect(flat).toMatch(/once more/i);
    expect(flat).toMatch(/then stop and report/i);
    // Headless runs do not wait.
    expect(flat).toMatch(/do not wait for answers/i);
    expect(skill).toContain('waitingOn');
    expect(skill).not.toMatch(/Every item that comes from a source says where it was read/);
  });

  it('never asks the agent to decide its own proposals', () => {
    expect(all).not.toContain('plune_review_decide');
  });
});
