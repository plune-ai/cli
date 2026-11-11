#!/usr/bin/env node
// The record of one run of the agent scenarios (mcp-evals/plune.yaml): the model × scenario summary as Markdown on
// stdout, for the job summary, and the same cells as JUnit XML for `plune run import`, one test case per model and
// scenario whose message says how many of its runs passed. The input is a folder with one `plune run --format json`
// result per model, each named <model>.json. Exit 2 on a wrong call, 1 when the folder holds no result.
//
//   node scripts/mcp-agent-scenarios-report.mjs <results-folder> <junit-file>

import * as fs from 'node:fs';
import * as path from 'node:path';

const [dir, junitFile] = process.argv.slice(2);
if (dir === undefined || junitFile === undefined) {
  process.stderr.write('usage: mcp-agent-scenarios-report.mjs <results-folder> <junit-file>\n');
  process.exit(2);
}

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
if (files.length === 0) {
  process.stdout.write(`No scenario result in ${path.basename(dir)}: no model ran, see the steps above.\n`);
  process.exit(1);
}

/** The runner's own rule (src/orchestrator/run.ts): ceil(pass_threshold × runs), at least one. */
const needed = (threshold, runs) => Math.max(1, Math.ceil(threshold * runs - 1e-9));

/** One row of a result: its verdict as the runner gave it, and how many of its runs passed. */
function cellOf(row) {
  const status = row.inconclusive ?? (row.error !== undefined ? 'errored' : row.assertions.every((a) => a.passed) ? 'passed' : 'failed');
  const runs = row.attempts?.runs ?? 1;
  const passed = row.attempts?.passed ?? (status === 'passed' ? 1 : 0);
  const why =
    row.error !== undefined
      ? [`${row.error.code}: ${row.error.message}`]
      : row.assertions.filter((a) => !a.passed).map((a) => `${a.type}: ${a.reason ?? 'failed'}`);
  return { status, runs, passed, needed: needed(row.attempts?.pass_threshold ?? 1, runs), why };
}

const models = files.map((f) => {
  const result = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const cells = new Map(result.evals.map((ev) => [ev.id, cellOf(ev.rows[0])]));
  const tokens = result.evals
    .flatMap((ev) => ev.rows)
    .reduce((sum, row) => sum + (row.usage?.input_tokens ?? 0) + (row.usage?.output_tokens ?? 0), 0);
  return { model: f.slice(0, -'.json'.length), cells, tokens, cost: result.summary.cost_usd, seconds: result.summary.duration_ms / 1000 };
});
const scenarios = [...new Set(models.flatMap((m) => [...m.cells.keys()]))];

const word = { passed: 'pass', failed: 'FAIL', errored: 'error', blocked: 'blocked', skipped: 'skipped' };
const show = (c) => (c === undefined ? 'not run' : `${word[c.status] ?? c.status} ${c.passed}/${c.runs}`);
const lines = [
  '## MCP agent scenarios',
  '',
  'Passing runs of each scenario, by model. A scenario under its threshold is a note on the description of the tool it names, with the transcript, not a test to rewrite.',
  '',
  `| Scenario | ${models.map((m) => m.model).join(' | ')} |`,
  `|---|${models.map(() => '---|').join('')}`,
  ...scenarios.map((s) => `| ${s} | ${models.map((m) => show(m.cells.get(s))).join(' | ')} |`),
  '',
  '| Model | Tokens | Cost, USD | Time, s |',
  '|---|---|---|---|',
  ...models.map((m) => `| ${m.model} | ${m.tokens} | ${m.cost.toFixed(4)} | ${m.seconds.toFixed(0)} |`),
  '',
];
process.stdout.write(lines.join('\n'));

const xml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const suites = models.map((m) => {
  const cases = [...m.cells].map(([scenario, c]) => {
    const said = `${c.passed} of ${c.runs} runs passed, ${c.needed} needed`;
    const open = `    <testcase classname="mcp-agent-scenarios.${xml(m.model)}" name="${xml(scenario)}">`;
    if (c.status === 'passed') return `${open}\n      <system-out>${xml(said)}</system-out>\n    </testcase>`;
    if (c.status === 'blocked' || c.status === 'skipped') return `${open}\n      <skipped message="${xml(`${c.status}: ${said}`)}"/>\n    </testcase>`;
    const tag = c.status === 'errored' ? 'error' : 'failure';
    return `${open}\n      <${tag} message="${xml(said)}">${xml(c.why.join('\n'))}</${tag}>\n    </testcase>`;
  });
  const count = (s) => [...m.cells.values()].filter((c) => c.status === s).length;
  return (
    `  <testsuite name="${xml(m.model)}" tests="${m.cells.size}" failures="${count('failed')}" errors="${count('errored')}">\n` +
    `${cases.join('\n')}\n  </testsuite>`
  );
});
fs.mkdirSync(path.dirname(path.resolve(junitFile)), { recursive: true });
fs.writeFileSync(junitFile, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="MCP agent scenarios">\n${suites.join('\n')}\n</testsuites>\n`);
