// `plune init --from-openai-eval`: an exported OpenAI eval becomes a plune.yaml. Pure: text in, text out;
// the files are read and written by the command (cli/commands/init.ts).
//
// The shapes are the ones in OpenAI's API reference: the eval object with `testing_criteria`, a run with
// `data_source.input_messages` and `data_source.model`, and test data as one `{"item": {...}}` per line.
// A grader either has a check here that means the same, or it is reported as not converted with the
// reason. Nothing is dropped without a line in the report.

import { stringify } from 'yaml';

export class OpenAiEvalImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiEvalImportError';
  }
}

export type ReportStatus = 'converted' | 'approximate' | 'not converted' | 'check';

/** One line of what happened to a grader, the prompt or the data. `check` is something the person must look at. */
export interface ReportLine {
  status: ReportStatus;
  subject: string;
  note: string;
}

export interface ConvertInput {
  /** The eval object, parsed. */
  evalObject: unknown;
  /** One run of that eval, parsed: the prompt template and the model come from it. */
  run?: unknown;
  /** The test data file as text: one JSON object per line. */
  rows?: string;
}

export interface Converted {
  yaml: string;
  /** The dataset file, relative to plune.yaml, and its text; absent when the rows went inline as a placeholder. */
  dataset?: { path: string; jsonl: string };
  report: ReportLine[];
}

type Obj = Record<string, unknown>;
type Var = string | number | boolean;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

const ITEM_REF = /\{\{\s*item\.([\w.]+)\s*\}\}/g;
const SAMPLE_REF = /\{\{\s*sample\.[\w.]+\s*\}\}/g;
const OUTPUT_TEXT = /^\{\{\s*sample\.output_text\s*\}\}$/;

/** `{{ item.x }}` as this config writes it: `{{x}}` in a prompt, `{{vars.x}}` in a check. Collects the names. */
function rewriteItemRefs(text: string, prefix: '' | 'vars.', seen: Set<string>): string {
  return text.replace(ITEM_REF, (_m, name: string) => {
    seen.add(name);
    return `{{${prefix}${name}}}`;
  });
}

/** The text of a message's content: a string, a text part, or a list of parts. Parts that are not text are left out. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map(textOf)
      .filter((t) => t !== '')
      .join('\n');
  if (isObj(content) && typeof content.text === 'string') return content.text;
  return '';
}

/** Every message of a template as one text, a blank line between them; `keep` may drop a message. */
function joinMessages(messages: unknown, keep: (text: string) => boolean = () => true): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => (isObj(m) ? textOf(m.content) : ''))
    .filter((t) => t !== '' && keep(t))
    .join('\n\n');
}

function slug(name: unknown): string {
  const s =
    typeof name === 'string'
      ? name
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : '';
  return s === '' ? 'imported-eval' : s;
}

/**
 * A judge's criteria from a model grader's messages: item references rewritten, the output named in words.
 * A message that is the sample alone is left out: llm-judge gives the judge the output itself.
 */
function criteriaOf(grader: Obj, seen: Set<string>): string {
  const more = (text: string): boolean => text.replace(SAMPLE_REF, '').trim() !== '';
  return rewriteItemRefs(joinMessages(grader.input, more), 'vars.', seen).replace(
    SAMPLE_REF,
    'the OUTPUT',
  );
}

function judgeProvider(grader: Obj): Obj {
  return typeof grader.model === 'string' && grader.model !== ''
    ? { provider: { type: 'openai', model: grader.model } }
    : {};
}

/** One grader as a check, or the reason there is none. */
function convertGrader(grader: Obj, seen: Set<string>): { assertion?: Obj; line: ReportLine } {
  const type = typeof grader.type === 'string' ? grader.type : 'unknown';
  const subject = `${typeof grader.name === 'string' ? grader.name : '(no name)'} [${type}]`;
  const skip = (note: string): { line: ReportLine } => ({
    line: { status: 'not converted', subject, note },
  });

  if (type === 'string_check' || type === 'text_similarity') {
    if (typeof grader.input !== 'string' || !OUTPUT_TEXT.test(grader.input.trim())) {
      return skip(
        `its input is ${JSON.stringify(grader.input)}; a check here reads the model's text answer ({{ sample.output_text }}) only`,
      );
    }
    if (typeof grader.reference !== 'string') return skip('it has no reference text');
    // A reference that names another field of the sample cannot be read after the fact; say so, not half-convert.
    if (SAMPLE_REF.test(grader.reference)) {
      SAMPLE_REF.lastIndex = 0;
      return skip(
        'its reference reads the model sample; a check here compares with the row or a fixed text',
      );
    }
    const local = new Set<string>();
    const reference = rewriteItemRefs(grader.reference, 'vars.', local);
    const ok = (
      assertion: Obj,
      status: ReportStatus,
      note: string,
    ): { assertion: Obj; line: ReportLine } => {
      local.forEach((n) => seen.add(n));
      return { assertion, line: { status, subject, note } };
    };

    if (type === 'string_check') {
      switch (grader.operation) {
        case 'eq':
          return ok({ type: 'exact-match', value: reference }, 'converted', 'exact-match');
        case 'like':
          return ok({ type: 'contains', value: reference }, 'converted', 'contains');
        case 'ilike':
          return ok(
            { type: 'contains', value: reference, ignore_case: true },
            'converted',
            'contains, ignore_case',
          );
        default:
          return skip(
            `operation ${JSON.stringify(grader.operation)} has no check here (there is no negated check)`,
          );
      }
    }
    if (grader.evaluation_metric !== 'cosine') {
      return skip(
        `metric ${JSON.stringify(grader.evaluation_metric)} has no check here; only cosine has one (semantic-similarity)`,
      );
    }
    const t = grader.pass_threshold;
    const threshold = typeof t === 'number' && t >= 0 && t <= 1 ? { threshold: t } : {};
    return ok(
      { type: 'semantic-similarity', reference, ...threshold },
      'approximate',
      'semantic-similarity: the embedding model is a different, local one, so run it and look at the threshold again',
    );
  }

  if (type === 'score_model') {
    const criteria = criteriaOf(grader, seen);
    if (criteria === '') return skip('its messages hold no text');
    const range = Array.isArray(grader.range) ? grader.range : [0, 1];
    const [min, max] = [range[0], range[1]];
    const t = grader.pass_threshold;
    let pass: Obj = {};
    let scale = 'no pass_threshold in the grader, so the default of llm-judge applies';
    if (typeof t === 'number' && typeof min === 'number' && typeof max === 'number' && max > min) {
      const scaled = Math.min(1, Math.max(0, (t - min) / (max - min)));
      pass = { pass_threshold: Number(scaled.toFixed(4)) };
      scale = `pass_threshold ${t} on ${min}..${max} became ${pass.pass_threshold as number} on 0..1`;
    }
    return {
      assertion: { type: 'llm-judge', criteria, ...pass, ...judgeProvider(grader) },
      line: {
        status: 'approximate',
        subject,
        note: `llm-judge: the grader's messages are the criteria and the judge scores 0..1; ${scale}`,
      },
    };
  }

  if (type === 'label_model') {
    const text = criteriaOf(grader, seen);
    const labels = Array.isArray(grader.labels)
      ? grader.labels.filter((l) => typeof l === 'string')
      : [];
    const passing = Array.isArray(grader.passing_labels)
      ? grader.passing_labels.filter((l) => typeof l === 'string')
      : [];
    if (labels.length === 0 || passing.length === 0)
      return skip('it has no labels or no passing labels');
    const rule =
      `Pick one label for the OUTPUT from: ${labels.join(', ')}. ` +
      `Score 1 if the label is one of: ${passing.join(', ')}. Otherwise score 0.`;
    return {
      assertion: {
        type: 'llm-judge',
        criteria: text === '' ? rule : `${text}\n\n${rule}`,
        ...judgeProvider(grader),
      },
      line: {
        status: 'approximate',
        subject,
        note: 'llm-judge: the judge gives a score, 1 for a passing label, in place of the label itself',
      },
    };
  }

  if (type === 'python') return skip('a Python grader runs code; no check here runs code');
  return skip('this grader type has no check here');
}

/** The rows of the test data as dataset rows. A value that is not a string, number or boolean becomes JSON text. */
function convertRows(items: unknown[], report: ReportLine[]): { vars: Record<string, Var> }[] {
  const asText = new Set<string>();
  const rows = items.map((raw, i) => {
    const item = isObj(raw) && isObj(raw.item) ? raw.item : raw;
    if (!isObj(item)) throw new OpenAiEvalImportError(`test data row ${i + 1} is not an object`);
    const vars: Record<string, Var> = {};
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        vars[key] = value;
      else {
        vars[key] = JSON.stringify(value);
        asText.add(key);
      }
    }
    return { vars };
  });
  if (asText.size > 0) {
    report.push({
      status: 'check',
      subject: 'test data',
      note: `written as JSON text, as a row value here is a string, a number or a boolean: ${[...asText].sort().join(', ')}`,
    });
  }
  return rows;
}

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new OpenAiEvalImportError(`test data line ${i + 1} is not JSON`);
    }
  });
  return out;
}

/** An exported eval (and, when given, one of its runs and its test data) as a plune.yaml. Throws on input that is not an eval. */
export function convertOpenAiEval({ evalObject, run, rows }: ConvertInput): Converted {
  if (!isObj(evalObject) || !Array.isArray(evalObject.testing_criteria)) {
    throw new OpenAiEvalImportError(
      'the eval file is not an eval object: it has no testing_criteria list (save the answer of GET /v1/evals/{eval_id})',
    );
  }
  if (run !== undefined && !isObj(run))
    throw new OpenAiEvalImportError('the run file is not a run object');

  const id = slug(evalObject.name);
  const report: ReportLine[] = [];
  const seen = new Set<string>();

  const assertions: Obj[] = [];
  for (const grader of evalObject.testing_criteria) {
    const { assertion, line } = convertGrader(isObj(grader) ? grader : {}, seen);
    if (assertion !== undefined) assertions.push(assertion);
    report.push(line);
  }
  if (assertions.length === 0) {
    report.push({
      status: 'check',
      subject: 'checks',
      note: 'no grader was converted: the eval has no checks until you add some',
    });
  }

  const source = isObj(run) && isObj(run.data_source) ? run.data_source : {};
  const template = isObj(source.input_messages) ? source.input_messages.template : undefined;
  const count = Array.isArray(template) ? template.length : 0;
  let prompt = rewriteItemRefs(joinMessages(template), '', seen);
  if (prompt === '') {
    prompt = 'Replace this line with your prompt.';
    report.push({
      status: 'check',
      subject: 'prompt',
      note: 'no prompt template was found (give a run with --run): the prompt is a placeholder',
    });
  } else if (count > 1) {
    report.push({
      status: 'check',
      subject: 'prompt',
      note: `${count} messages were joined into one prompt; their roles are not kept`,
    });
  }

  let model = typeof source.model === 'string' && source.model !== '' ? source.model : undefined;
  if (model === undefined) {
    model = 'gpt-4o';
    report.push({
      status: 'check',
      subject: 'model',
      note: 'no model was found (give a run with --run): it is set to gpt-4o',
    });
  }

  // Rows: the file given, else rows a run carries inline; with neither, one placeholder row.
  const inline =
    isObj(source.source) && Array.isArray(source.source.content)
      ? source.source.content
      : undefined;
  const items = rows !== undefined ? parseJsonl(rows) : inline;
  let dataset: Converted['dataset'];
  let datasetField: unknown;
  if (items !== undefined && items.length > 0) {
    const path = `datasets/${id}.jsonl`;
    dataset = {
      path,
      jsonl:
        convertRows(items, report)
          .map((r) => JSON.stringify(r))
          .join('\n') + '\n',
    };
    datasetField = `./${path}`;
  } else {
    const vars = Object.fromEntries([...seen].sort().map((n) => [n, 'replace me']));
    datasetField = { examples: [{ vars }] };
    report.push({
      status: 'check',
      subject: 'test data',
      note: 'no test data was found (give the file with --data): the dataset is one placeholder row',
    });
  }

  const nested = [...seen].filter((n) => n.includes('.'));
  if (nested.length > 0) {
    report.push({
      status: 'check',
      subject: 'placeholders',
      note: `these point inside a nested value, and a row here is flat: ${nested.sort().join(', ')}`,
    });
  }

  const config = {
    version: 1,
    provider: { type: 'openai', model },
    evals: [
      {
        id,
        ...(typeof evalObject.name === 'string' ? { description: evalObject.name } : {}),
        prompt,
        dataset: datasetField,
        assertions,
      },
    ],
  };
  const header =
    '# Plune configuration, written by `plune init --from-openai-eval`. Read the report it printed.\n';
  return { yaml: header + stringify(config), ...(dataset ? { dataset } : {}), report };
}

/** The report as lines for the terminal, the graders in the order the eval lists them. */
export function formatReport(report: ReportLine[]): string {
  const count = (s: ReportStatus): number => report.filter((l) => l.status === s).length;
  return (
    report.map((l) => `  ${l.status.padEnd(13)} ${l.subject}: ${l.note}`).join('\n') +
    `\n\n${count('converted')} converted · ${count('approximate')} approximate · ${count('not converted')} not converted\n`
  );
}
