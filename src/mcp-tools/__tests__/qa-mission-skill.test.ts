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
      'plune_source_add',
      'plune_endpoint_propose',
      'plune_report_request',
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
      'plune_endpoint_propose',
      'plune_question_ask',
      'plune_source_add',
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

    const example = /<!-- input: plune_api_request -->\r?\n```json\r?\n([\s\S]*?)\r?\n```/.exec(
      all,
    )![1]!;
    // The route and source kinds of the platform's memory candidates (POST /v1/memory/candidates).
    const call = JSON.parse(example) as {
      method: string;
      path: string;
      body: { source: { kind: string; id: string } };
    };
    expect([call.method, call.path]).toEqual(['POST', '/v1/memory/candidates']);
    expect(['answer', 'decline', 'failure_choice', 'report_lesson']).toContain(
      call.body.source.kind,
    );
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
    for (const basis of ['"source":', '"assumption": true', '"waitingOn":'])
      expect(refs).toContain(basis);
    // Propose first, then write the file from what was accepted, with the proposal id in the log.
    const propose = skill.indexOf('plune_strategy_propose(missionId, content, dry_run)');
    const write = skill.indexOf('write `docs/testing/test-strategy.md`');
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

  describe('the full flow', () => {
    const skill = texts.get('SKILL.md')!;
    const flat = skill.replace(/\s+/g, ' ');
    const at = (needle: string | RegExp, from = 0): number => {
      const i =
        typeof needle === 'string' ? skill.indexOf(needle, from) : skill.slice(from).search(needle);
      expect(i, String(needle)).toBeGreaterThan(-1);
      return typeof needle === 'string' ? i : i + from;
    };

    it('runs the stages of the ISTQB test process in order: analysis, design, implementation, execution, completion', () => {
      let from = 0;
      for (const stage of ['Analysis', 'Design', 'Implementation', 'Execution', 'Completion'])
        from = at(new RegExp(`^## Stage \\d: ${stage}\\b`, 'm'), from) + 1;
      // The stage log has one row per stage, named the same way.
      const log = skill.slice(at('## Stage log'));
      for (const stage of ['Analysis', 'Design', 'Implementation', 'Execution', 'Completion'])
        expect(log).toContain(stage);
    });

    it('puts the mission, its sources, the questions, the strategy, the endpoint catalog and the report in Plune tools, not in files alone', () => {
      const analysis = skill.slice(at('## Stage 1: Analysis'), at('## Stage 2: Design'));
      expect(analysis).toContain('plune_source_add(');
      expect(analysis).toContain('plune_endpoint_propose(');
      expect(analysis).toContain('plune_question_ask(');
      expect(analysis).toContain('plune_mission_create(');
      const completion = skill.slice(at('## Stage 5: Completion'));
      expect(completion).toContain('plune_report_request(missionId, dry_run)');
      // The endpoint tool is not in the first tool list: the skill says how to switch it on.
      expect(pluneTool('plune_endpoint_propose').visibility).toBe('discoverable');
      expect(analysis).toContain('plune_discover_tools(names)');
    });

    it('asks for the report only once the strategy is accepted, as the platform requires', () => {
      const completion = skill.slice(at('## Stage 5: Completion'));
      expect(completion.replace(/\s+/g, ' ')).toMatch(
        /only after a person has accepted the strategy/i,
      );
      expect(pluneTool('plune_report_request').description).toMatch(/accepted strategy/);
    });

    it('sends a product with no documentation to cairn collect-docs and one with no OpenAPI down the source ladder', () => {
      const analysis = skill
        .slice(at('## Stage 1: Analysis'), at('## Stage 2: Design'))
        .replace(/\s+/g, ' ');
      expect(analysis).toContain('cairn collect-docs --url');
      expect(analysis).toContain('`documentation` is `none`');
      // The ladder: a served spec, then a Postman collection or HAR file, then the traffic of an exploring run.
      expect(analysis).toContain('openapi.derived.json');
      const ladder = ['cairn api --base-url', 'cairn api --spec', 'cairn explore --url'].map(
        (s) => {
          expect(analysis, s).toContain(s);
          return analysis.indexOf(s);
        },
      );
      expect(ladder).toEqual([...ladder].sort((a, b) => a - b));
      // Nothing from a third-party package runs without the user's say-so.
      expect(analysis).toMatch(/ask the user before you run/i);
    });

    it('treats a derived endpoint as derived and never as confirmed', () => {
      expect(flat).toMatch(/`trust` `derived`/);
      expect(flat).toMatch(/`source` `traffic`/);
    });

    it('orders the surfaces: API, UI, LLM, docs, security, accessibility, performance', () => {
      const order = ['API', 'UI', 'LLM', 'docs', 'security', 'accessibility', 'performance'].join(
        ', ',
      );
      expect(flat).toContain(`surfaces in this order: ${order}`);
    });

    it('asks fewer questions on a second mission on the same product, from the answers already given', () => {
      const analysis = skill.slice(at('## Stage 1: Analysis'), at('## Stage 2: Design'));
      expect(analysis).toContain('plune_question_list()');
      expect(analysis.replace(/\s+/g, ' ')).toMatch(/answered before|already answered/i);
      expect(pluneTool('plune_question_list').input.shape).toHaveProperty('missionId');
    });

    it('does not run the tests itself', () => {
      const execution = skill
        .slice(at('## Stage 4: Execution'), at('## Stage 5: Completion'))
        .replace(/\s+/g, ' ');
      expect(execution).toMatch(/skipped/);
      expect(execution).toMatch(/do not start a run/i);
    });
  });

  it('never asks the agent to decide its own proposals', () => {
    expect(all).not.toContain('plune_review_decide');
  });
});
