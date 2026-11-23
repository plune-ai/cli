import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { initFromOpenAiEval } from '../init.js';
import { createProgram } from '../../../cli.js';
import { loadConfig } from '../../../config/loader.js';
import { getAssertion } from '../../../assertions/registry.js';
import { convertOpenAiEval, OpenAiEvalImportError } from '../../../config/init/from-openai-eval.js';
import type { AssertionKind, DatasetRow } from '../../../types/config.js';

// The eval, the run and the test data of OpenAI's Evals guide ("IT Ticket Categorization"), as its API returns them.
const EVAL = {
  object: 'eval',
  id: 'eval_1',
  name: 'IT Ticket Categorization',
  data_source_config: { type: 'custom', schema: {} },
  testing_criteria: [
    {
      name: 'Match output to human label',
      type: 'string_check',
      input: '{{ sample.output_text }}',
      reference: '{{ item.correct_label }}',
      operation: 'eq',
    },
  ],
};
const RUN = {
  object: 'eval.run',
  data_source: {
    type: 'responses',
    model: 'gpt-4.1',
    input_messages: {
      type: 'template',
      template: [
        { role: 'developer', content: 'Categorize the ticket as Hardware, Software, or Other.' },
        { role: 'user', content: '{{ item.ticket_text }}' },
      ],
    },
    source: { type: 'file_id', id: 'file_1' },
  },
};
const DATA =
  `{ "item": { "ticket_text": "My monitor won't turn on!", "correct_label": "Hardware" } }\n` +
  `{ "item": { "ticket_text": "I'm in vim and I can't quit!", "correct_label": "Software" } }\n`;

let tmp: string;
let printed: string[];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-init-oai-'));
  printed = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    printed.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const put = (name: string, content: string): string => {
  fs.writeFileSync(path.join(tmp, name), content);
  return name;
};
const grader = (g: Record<string, unknown>) =>
  convertOpenAiEval({ evalObject: { name: 'x', testing_criteria: [{ name: 'g', ...g }] } });
const firstAssertion = (yaml: string): Record<string, unknown> | undefined =>
  (parse(yaml) as { evals: { assertions: Record<string, unknown>[] }[] }).evals[0]!.assertions[0];
const OUT = '{{ sample.output_text }}';

describe('plune init --from-openai-eval', () => {
  it('turns the eval of the Evals guide into a config that loads and grades as the eval did', async () => {
    await initFromOpenAiEval({
      cwd: tmp,
      force: false,
      evalPath: put('eval.json', JSON.stringify(EVAL)),
      runPath: put('run.json', JSON.stringify(RUN)),
      dataPath: put('tickets.jsonl', DATA),
    });

    const config = await loadConfig({ cwd: tmp, env: {} });
    const ev = config.evals[0]!;
    expect(config.provider).toMatchObject({ type: 'openai', model: 'gpt-4.1' });
    expect(ev.id).toBe('it-ticket-categorization');
    expect(ev.prompt).toBe(
      'Categorize the ticket as Hardware, Software, or Other.\n\n{{ticket_text}}',
    );
    expect(ev.dataset).toBe('./datasets/it-ticket-categorization.jsonl');

    const rows = fs
      .readFileSync(path.join(tmp, 'datasets', 'it-ticket-categorization.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as DatasetRow);
    expect(rows.map((r) => r.vars.correct_label)).toEqual(['Hardware', 'Software']);

    // The converted check, run on the first row: the row's own label passes, another label fails.
    const { type, ...params } = ev.assertions![0] as { type: AssertionKind } & Record<
      string,
      unknown
    >;
    const ask = (output: string) =>
      getAssertion(type).run({ output, vars: rows[0]!.vars, row: rows[0]!, params });
    expect((await ask('Hardware')).passed).toBe(true);
    expect((await ask('Software')).passed).toBe(false);

    const out = printed.join('');
    expect(out).toContain('converted     Match output to human label [string_check]: exact-match');
    expect(out).toContain('2 messages were joined into one prompt');
    expect(out).toContain('1 converted · 0 approximate · 0 not converted');
    expect(out).toContain('OPENAI_API_KEY');
  });

  it.each([
    ['eq', { type: 'exact-match', value: '{{vars.label}}' }],
    ['like', { type: 'contains', value: '{{vars.label}}' }],
    ['ilike', { type: 'contains', value: '{{vars.label}}', ignore_case: true }],
  ])('string_check %s becomes %o', (operation, expected) => {
    const { yaml, report } = grader({
      type: 'string_check',
      input: OUT,
      reference: '{{ item.label }}',
      operation,
    });
    expect(firstAssertion(yaml)).toEqual(expected);
    expect(report[0]!.status).toBe('converted');
  });

  it.each([
    [
      'string_check ne',
      { type: 'string_check', input: OUT, reference: 'x', operation: 'ne' },
      'no negated check',
    ],
    [
      'text_similarity bleu',
      { type: 'text_similarity', input: OUT, reference: 'x', evaluation_metric: 'bleu' },
      'only cosine has one',
    ],
    ['python', { type: 'python', source: 'def grade(sample, item):\n    return 1.0' }, 'runs code'],
    [
      'a string_check on another field of the sample',
      {
        type: 'string_check',
        input: '{{ sample.output_json.label }}',
        reference: 'x',
        operation: 'eq',
      },
      "reads the model's text answer",
    ],
    [
      'a reference that reads the sample',
      {
        type: 'string_check',
        input: OUT,
        reference: '{{ sample.output_json.x }}',
        operation: 'eq',
      },
      'its reference reads the model sample',
    ],
    ['an unknown type', { type: 'multi' }, 'no check here'],
  ])('%s is not converted, and the report says why', (_name, g, why) => {
    const { yaml, report } = grader(g);
    expect(firstAssertion(yaml)).toBeUndefined();
    expect(report[0]).toMatchObject({ status: 'not converted' });
    expect(report[0]!.note).toContain(why);
    expect(report.find((l) => l.subject === 'checks')!.note).toContain('no grader was converted');
  });

  it('text_similarity cosine becomes semantic-similarity with its threshold, marked approximate', () => {
    const { yaml, report } = grader({
      type: 'text_similarity',
      input: OUT,
      reference: '{{ item.answer }}',
      evaluation_metric: 'cosine',
      pass_threshold: 0.8,
    });
    expect(firstAssertion(yaml)).toEqual({
      type: 'semantic-similarity',
      reference: '{{vars.answer}}',
      threshold: 0.8,
    });
    expect(report[0]!.status).toBe('approximate');
  });

  it('score_model becomes llm-judge: messages as criteria, the threshold rescaled to 0..1, the judge model kept', () => {
    const { yaml, report } = grader({
      type: 'score_model',
      model: 'o4-mini',
      range: [1, 5],
      pass_threshold: 4,
      input: [
        { role: 'system', content: 'Grade the answer against {{ item.reference }}.' },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Answer: {{ sample.output_text }}' }],
        },
      ],
    });
    expect(firstAssertion(yaml)).toEqual({
      type: 'llm-judge',
      criteria: 'Grade the answer against {{vars.reference}}.\n\nAnswer: the OUTPUT',
      pass_threshold: 0.75,
      provider: { type: 'openai', model: 'o4-mini' },
    });
    expect(report[0]!.note).toContain('pass_threshold 4 on 1..5 became 0.75 on 0..1');
  });

  it('label_model becomes llm-judge that scores 1 for a passing label, marked approximate', () => {
    const { yaml, report } = grader({
      type: 'label_model',
      model: 'gpt-4.1',
      labels: ['positive', 'neutral', 'negative'],
      passing_labels: ['positive', 'neutral'],
      // The second message is the sample alone: llm-judge gives the judge the output itself, so it is left out.
      input: [
        { role: 'user', content: 'Classify the tone.' },
        { role: 'user', content: '{{ sample.output_text }}' },
      ],
    });
    expect(firstAssertion(yaml)!.criteria).toBe(
      'Classify the tone.\n\nPick one label for the OUTPUT from: positive, neutral, negative. ' +
        'Score 1 if the label is one of: positive, neutral. Otherwise score 0.',
    );
    expect(report[0]!.status).toBe('approximate');
  });

  it('writes a row value that is not a string, number or boolean as JSON text and names it', () => {
    const { dataset, report } = convertOpenAiEval({
      evalObject: EVAL,
      rows: '{"item": {"q": "a", "n": 2, "tags": ["x", "y"], "meta": {"k": 1}}}\n',
    });
    expect(JSON.parse(dataset!.jsonl)).toEqual({
      vars: { q: 'a', n: 2, tags: '["x","y"]', meta: '{"k":1}' },
    });
    expect(report.find((l) => l.subject === 'test data')!.note).toContain('meta, tags');
  });

  it('with the eval alone, the config still loads: a placeholder prompt, model and row, each named in the report', async () => {
    await initFromOpenAiEval({
      cwd: tmp,
      force: false,
      evalPath: put('eval.json', JSON.stringify(EVAL)),
    });
    const config = await loadConfig({ cwd: tmp, env: {} });
    expect(config.evals[0]!.dataset).toEqual({
      examples: [{ vars: { correct_label: 'replace me' } }],
    });
    const out = printed.join('');
    for (const subject of ['prompt', 'model', 'test data'])
      expect(out).toContain(`check         ${subject}:`);
  });

  it.each([
    ['not JSON', 'not json', 'eval.json is not JSON'],
    ['not an eval object', '{"object":"list","data":[]}', 'no testing_criteria list'],
  ])('refuses an eval file that is %s and writes nothing', async (_name, content, message) => {
    const evalPath = put('eval.json', content);
    await expect(initFromOpenAiEval({ cwd: tmp, force: false, evalPath })).rejects.toThrow(message);
    expect(fs.readdirSync(tmp)).toEqual(['eval.json']);
  });

  it('refuses test data with a line that is not JSON, naming the line, and writes nothing', async () => {
    const evalPath = put('eval.json', JSON.stringify(EVAL));
    const dataPath = put('rows.jsonl', '{"item":{"a":1}}\nnope\n');
    await expect(
      initFromOpenAiEval({ cwd: tmp, force: false, evalPath, dataPath }),
    ).rejects.toThrow(OpenAiEvalImportError);
    await expect(
      initFromOpenAiEval({ cwd: tmp, force: false, evalPath, dataPath }),
    ).rejects.toThrow('line 2');
    expect(fs.readdirSync(tmp).sort()).toEqual(['eval.json', 'rows.jsonl']);
  });

  it('skips an existing plune.yaml unless --force', async () => {
    const evalPath = put('eval.json', JSON.stringify(EVAL));
    put('plune.yaml', 'mine\n');
    await initFromOpenAiEval({ cwd: tmp, force: false, evalPath });
    expect(fs.readFileSync(path.join(tmp, 'plune.yaml'), 'utf8')).toBe('mine\n');
    expect(printed.join('')).toContain('Skipped existing plune.yaml');
    await initFromOpenAiEval({ cwd: tmp, force: true, evalPath });
    expect(fs.readFileSync(path.join(tmp, 'plune.yaml'), 'utf8')).toContain('version: 1');
  });

  it('exits 2 from the command line: a bad eval file, and --run or --data without --from-openai-eval', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);

    await createProgram().parseAsync([
      'node',
      'plune',
      'init',
      '--from-openai-eval',
      'missing.json',
    ]);
    expect(exitSpy).toHaveBeenLastCalledWith(2);
    expect(stderr.join('')).toContain('cannot read missing.json');

    await createProgram().parseAsync(['node', 'plune', 'init', '--data', 'rows.jsonl']);
    expect(exitSpy).toHaveBeenCalledTimes(2);
    expect(stderr.join('')).toContain('--run and --data need --from-openai-eval');
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
