// The plune-mcp-evals skill (skills/plune-mcp-evals) cannot be tested by running a model, so everything beside it is:
// the commands it tells an agent to run exist with the flags it names, its example configs pass `plune run --dry-run`,
// every tool they name is listed by the fixture server they are written for, and each carries its negative scenarios.
// Each check is a function over the text, run once on the real files and once on a broken copy, so a check that could
// never fail fails here.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createProgram } from '../../cli.js';
import { PRICE_TABLE } from '../../providers/prices.js';
import { handleMcpSnapshot } from '../commands/mcp-snapshot.js';
import { handleRun } from '../commands/run.js';

const DIR = fileURLToPath(new URL('../../../skills/plune-mcp-evals/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/notes-server.mjs', import.meta.url));
const SKILL = readFileSync(join(DIR, 'SKILL.md'), 'utf8');
const MARKDOWN = [SKILL, readFileSync(join(DIR, 'references', 'checks.md'), 'utf8')].join('\n');
const EXAMPLES = readdirSync(join(DIR, 'examples')).filter((f) => /\.ya?ml$/.test(f));
const exampleText = (f: string) => readFileSync(join(DIR, 'examples', f), 'utf8');

/** Every `plune ...` the text shows: a line of a code block, or an inline code span. Shell comments dropped. */
function pluneCommands(md: string): string[] {
  const blockLines = [...md.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].flatMap((m) =>
    m[1]!.split(/\r?\n/),
  );
  const spans = [...md.replace(/```[\s\S]*?```/g, '').matchAll(/`(plune [^`]+)`/g)].map(
    (m) => m[1]!,
  );
  return [...blockLines, ...spans]
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line.startsWith('plune '));
}

/** Why `line` is not a command of `program` with flags it takes; empty when it is. Words after `--` are the server's. */
function commandProblems(line: string, program: Command): string[] {
  const words = line.split(/\s+/).slice(1);
  const chain = [program];
  let i = 0;
  for (; i < words.length; i++) {
    const sub = chain.at(-1)!.commands.find((c) => c.name() === words[i]);
    if (sub === undefined) break;
    chain.push(sub);
  }
  const cmd = chain.at(-1)!;
  if (cmd === program) return [`${line}: no such command`];
  const next = words[i];
  if (next !== undefined && !next.startsWith('-') && cmd.commands.length > 0)
    return [`${line}: ${cmd.name()} has no subcommand ${next}`];
  const flags = new Set(chain.flatMap((c) => c.options.map((o) => o.long)));
  const problems: string[] = [];
  for (const word of words.slice(i)) {
    if (word === '--') break;
    if (word.startsWith('--') && !flags.has(word.split('=')[0]))
      problems.push(`${line}: ${cmd.name()} has no ${word.split('=')[0]}`);
  }
  return problems;
}

interface Eval {
  id: string;
  mcp?: { allowed_tools?: string[] };
  assertions: { type: string; tool?: string; tools?: string[] }[];
}
const evalsOf = (yaml: string): Eval[] => (parse(yaml) as { evals: Eval[] }).evals;

/** Every tool name a config's scenarios use: `tool:`, `tools:` and `allowed_tools`. */
const toolNames = (yaml: string): string[] =>
  evalsOf(yaml).flatMap((ev) => [
    ...(ev.mcp?.allowed_tools ?? []),
    ...ev.assertions.flatMap((a) => [
      ...(a.tool !== undefined ? [a.tool] : []),
      ...(a.tools ?? []),
    ]),
  ]);

const REQUIRE = new Set(['tool-called', 'tool-args', 'first-tool', 'tool-order']);
const FORBID = new Set(['only-tools', 'tool-not-called', 'no-destructive-tool']);
/** A negative scenario requires no call and forbids one (references/checks.md, "Which scenario is negative"). */
const isNegative = (ev: Eval): boolean =>
  !ev.assertions.some((a) => REQUIRE.has(a.type)) && ev.assertions.some((a) => FORBID.has(a.type));
/** The skill's rule: at least two negative scenarios, and at least one for every four positive ones. */
function negativeProblems(yaml: string): string[] {
  const evals = evalsOf(yaml);
  const negative = evals.filter(isNegative).length;
  const needed = Math.max(2, Math.ceil((evals.length - negative) / 4));
  return negative >= needed ? [] : [`${negative} negative scenarios, ${needed} needed`];
}

/** `plune run --dry-run` on a copy of the config in a folder of its own: the run writes `.plune/` beside it. */
async function dryRun(yaml: string) {
  const dir = mkdtempSync(join(tmpdir(), 'plune-mcp-evals-'));
  try {
    const path = join(dir, 'plune.yaml');
    writeFileSync(path, yaml);
    return await handleRun({ dryRun: true, configPath: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let listed: string[] = [];
beforeAll(async () => {
  // The tool list as the skill tells an agent to read it: `plune mcp snapshot -- <command>`.
  let out = '';
  const code = await handleMcpSnapshot({ timeout: '20s' }, [process.execPath, FIXTURE], {
    out: (s) => (out += s),
    err: () => {},
    env: {},
    cwd: tmpdir(),
  });
  expect(code).toBe(0);
  listed = (JSON.parse(out) as { tools: { name: string }[] }).tools.map((t) => t.name);
}, 30_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CLI · skill · mcp evals', () => {
  it('CLI · skill · mcp evals · has Agent Skills frontmatter: the folder name and a "Use when" description', () => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(SKILL)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('plune-mcp-evals');
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description).toContain('Use when');
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('CLI · skill · mcp evals · every plune command it shows exists, with the flags it names', () => {
    const program = createProgram();
    const commands = pluneCommands(MARKDOWN);
    expect(commands.length).toBeGreaterThanOrEqual(5);
    expect(commands.join('\n')).toContain('plune mcp snapshot --out');
    expect(commands.join('\n')).toContain('plune run --dry-run');
    expect(commands.flatMap((c) => commandProblems(c, program))).toEqual([]);
    // Broken copies: a made-up command, a made-up subcommand, a made-up flag.
    expect(commandProblems('plune frobnicate', program)).not.toEqual([]);
    expect(commandProblems('plune mcp frobnicate --out x', program)).not.toEqual([]);
    expect(commandProblems('plune run --dry-runn --config plune.yaml', program)).not.toEqual([]);
    expect(
      pluneCommands(`${SKILL}\n\`\`\`bash\nplune mcp frobnicate\n\`\`\`\n`).flatMap((c) =>
        commandProblems(c, program),
      ),
    ).toEqual(['plune mcp frobnicate: mcp has no subcommand frobnicate']);
  });

  it('CLI · skill · mcp evals · there are examples, each priced by a model of the price table', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
    for (const f of EXAMPLES) {
      const model = (parse(exampleText(f)) as { provider: { model: string } }).provider.model;
      expect(PRICE_TABLE[model], `${f}: ${model}`).toBeDefined();
    }
  });

  it.each(EXAMPLES)('CLI · skill · mcp evals · %s passes plune run --dry-run', async (f) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.stubEnv('NOTES_API_TOKEN', 'not-a-token');
    const result = await dryRun(exampleText(f));
    expect(result.dry_run).toBe(true);
    expect(result.summary.total).toBe(evalsOf(exampleText(f)).length);
    // A broken key in the strict mcp block: the same dry run refuses it.
    const broken = exampleText(f).replace(/^ {2}servers:/m, '  server:');
    expect(broken).not.toBe(exampleText(f));
    await expect(dryRun(broken)).rejects.toThrow();
  });

  it.each(EXAMPLES)(
    'CLI · skill · mcp evals · %s names only tools the fixture server lists',
    (f) => {
      expect(listed.length).toBeGreaterThan(0);
      const names = toolNames(exampleText(f));
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => !listed.includes(n))).toEqual([]);
      const broken = exampleText(f).replace('tool: note_get', 'tool: note_fetch');
      expect(toolNames(broken).filter((n) => !listed.includes(n))).toEqual(['note_fetch']);
    },
  );

  it.each(EXAMPLES)('CLI · skill · mcp evals · %s carries its negative scenarios', (f) => {
    const evals = evalsOf(exampleText(f));
    expect(evals.filter(isNegative).length).toBeGreaterThanOrEqual(2);
    expect(negativeProblems(exampleText(f))).toEqual([]);
    // Without them the rule fails.
    const doc = parse(exampleText(f)) as { evals: Eval[] };
    doc.evals = doc.evals.filter((ev) => !isNegative(ev));
    expect(negativeProblems(JSON.stringify(doc))).not.toEqual([]);
  });

  it('CLI · skill · mcp evals · states its rules in a section of their own', () => {
    const rules = /^## Rules\r?\n([\s\S]*?)(?=^## )/m.exec(SKILL)?.[1] ?? '';
    for (const rule of [
      'Do not invent tools',
      'Negative scenarios are required',
      'Similar tools get their own scenario',
      'Never weaken or remove a check',
      'Secrets only as `${NAME}`',
      'Consent before spending',
      'Consent before destructive calls',
      'Read-only servers',
    ])
      expect(rules, rule).toContain(rule);
  });
});
