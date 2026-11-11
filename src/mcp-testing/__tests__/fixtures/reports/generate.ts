// The JUnit files of this folder, written by the real `plune mcp lint`, `check`, `diff` and `conformance` (the command
// line of src/cli.ts, flags parsed by commander) against the fixture servers of the folder above. Nothing is written
// by hand.
// Run it again after a change to the report formats or the rules (README.md); with no change it writes the same bytes.
//
//   node node_modules/tsx/dist/cli.mjs src/mcp-testing/__tests__/fixtures/reports/generate.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProgram } from '../../../../cli.js';

const fixture = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const node = process.execPath;
const LINT = [node, fixture('lint-server.mjs')];
const CHECK = [node, fixture('check-server.mjs')];
const SNAPSHOT = [node, fixture('snapshot-server.mjs')];
const CONFORMANCE = [node, fixture('conformance-server.mjs')];
/**
 * One check of each JUnit state on the server that breaks every requirement. Not the whole suite: the request id a
 * check makes up is in the text of `base-response-id-matches`, and differs on every run.
 */
const CONFORMANCE_CHECKS = [
  'life-initialize-result',
  'life-ping-empty-result',
  'tools-name-format',
  'tools-list-order-stable',
  'tools-structured-conformant',
].flatMap((id) => ['--check', id]);

/** What each file is, and the arguments after `plune` that write it; `{baseline}` is a snapshot taken first. */
export const REPORT_FIXTURES: { file: string; what: string; args: string[] }[] = [
  {
    file: 'lint-clean.xml',
    what: 'a clean tool list',
    args: ['mcp', 'lint', '--', ...LINT, 'clean'],
  },
  {
    file: 'lint-mixed.xml',
    what: 'an error, a warning and an info finding',
    args: ['mcp', 'lint', '--', ...LINT, 'mixed'],
  },
  {
    file: 'lint-heuristic.xml',
    what: 'a heuristic warning only',
    args: ['mcp', 'lint', '--', ...LINT, 'heuristic'],
  },
  {
    file: 'lint-hang.xml',
    what: '--call on a tool that never answers',
    args: ['mcp', 'lint', '--call', '--call-timeout', '300ms', '--', ...LINT, 'hang'],
  },
  {
    file: 'lint-empty.xml',
    what: 'a server that lists no tools: nothing measured',
    args: ['mcp', 'lint', '--', ...LINT, 'empty'],
  },
  {
    file: 'check-healthy.xml',
    what: 'a healthy server',
    args: ['mcp', 'check', '--', ...CHECK, 'healthy'],
  },
  {
    file: 'check-broken.xml',
    what: 'resources/list answers with an error',
    args: ['mcp', 'check', '--', ...CHECK, 'resources-error'],
  },
  {
    file: 'check-hang.xml',
    what: 'tools/list never answers',
    args: ['mcp', 'check', '--check-timeout', '300ms', '--', ...CHECK, 'hang-tools'],
  },
  {
    file: 'check-smoke.xml',
    what: '--smoke on tools that pass, fail and are not called',
    args: ['mcp', 'check', '--smoke', '--', ...CHECK, 'smoke'],
  },
  {
    file: 'diff-breaking.xml',
    what: 'every tool of the baseline gone',
    args: ['mcp', 'diff', '{baseline}', '--', ...SNAPSHOT, 'empty'],
  },
  {
    file: 'diff-same.xml',
    what: 'the server against its own snapshot',
    args: ['mcp', 'diff', '{baseline}', '--', ...SNAPSHOT, 'full'],
  },
  {
    file: 'conformance-bad.xml',
    what: 'a passed check, a failed MUST, a failed SHOULD, one of the other era, one without --fixture',
    args: ['mcp', 'conformance', ...CONFORMANCE_CHECKS, '--', ...CONFORMANCE, 'bad'],
  },
  {
    file: 'conformance-silent.xml',
    what: 'the same checks on a server that answers the handshake, then nothing',
    args: ['mcp', 'conformance', ...CONFORMANCE_CHECKS, '--timeout', '300ms', '--', ...CONFORMANCE, 'silent'],
  },
];

/** `time` is how long a check took: the one field two runs differ in, so it is not kept. Nothing else is touched. */
export const normalize = (xml: string): string => xml.replace(/ time="[0-9.]+"/g, '');

/** Runs `plune <args>` in this process, its stdout dropped; the exit code it set. */
async function plune(args: string[]): Promise<number> {
  const write = process.stdout.write.bind(process.stdout);
  const before = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = () => true;
  try {
    await createProgram().parseAsync(args, { from: 'user' });
    return Number(process.exitCode ?? 0);
  } finally {
    process.stdout.write = write;
    process.exitCode = before;
  }
}

/** Writes every fixture into `dir`; the exit code of each run, by file. */
export async function generateReports(dir: string): Promise<Record<string, number>> {
  const work = mkdtempSync(join(tmpdir(), 'plune-report-fixtures-'));
  const baseline = join(work, 'baseline.json');
  if ((await plune(['mcp', 'snapshot', '--out', baseline, '--', ...SNAPSHOT, 'full'])) !== 0)
    throw new Error('the baseline snapshot could not be taken');
  const codes: Record<string, number> = {};
  try {
    for (const f of REPORT_FIXTURES) {
      const raw = join(work, f.file);
      const args = f.args.map((a) => (a === '{baseline}' ? baseline : a));
      codes[f.file] = await plune([
        ...args.slice(0, 2),
        '--reporter',
        'junit-xml',
        '--out',
        raw,
        ...args.slice(2),
      ]);
      writeFileSync(join(dir, f.file), normalize(readFileSync(raw, 'utf8')));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return codes;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const codes = await generateReports(fileURLToPath(new URL('.', import.meta.url)));
  for (const [file, code] of Object.entries(codes)) process.stderr.write(`${file}: exit ${code}\n`);
}
