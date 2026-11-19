// The `plune mcp scan` section of docs/guide/cli.md against the command itself: the flags it names are flags of the
// command, every flag of the command (other than the connection flags every `plune mcp` command shares) is named in
// it, and its exit-code table has exactly the codes the scan can exit with, each with its meaning.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../../cli.js';
import { MCP_EXIT } from '../../mcp-testing/exit-codes.js';
import { addConnectionOptions } from '../../mcp-testing/connect/options.js';

const GUIDE = readFileSync(new URL('../../../docs/guide/cli.md', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** From `## \`plune mcp scan\`` to the next level-2 heading. */
export function scanSection(guide: string): string {
  const start = guide.indexOf('\n## `plune mcp scan`\n');
  if (start < 0) return '';
  const end = guide.indexOf('\n## ', start + 1);
  return guide.slice(start, end < 0 ? undefined : end);
}

/** The flags in the first column of the section's `| Flag | Meaning |` tables. */
export function tableFlags(section: string): string[] {
  const flags: string[] = [];
  let inFlagTable = false;
  for (const line of section.split('\n')) {
    if (/^\| Flag \| Meaning \|$/.test(line)) inFlagTable = true;
    else if (!line.startsWith('|')) inFlagTable = false;
    else if (inFlagTable && !line.startsWith('| ---')) {
      const first = line.slice(1).split(/(?<!\\)\|/)[0] ?? '';
      flags.push(...(first.match(/--[a-z][a-z-]*/g) ?? []));
    }
  }
  return flags;
}

/** The rows of the section's `| Exit | Meaning |` table, as code → meaning. */
export function exitRows(section: string): Map<number, string> {
  const rows = new Map<number, string>();
  let inExitTable = false;
  for (const line of section.split('\n')) {
    if (/^\| Exit \| Meaning \|$/.test(line)) inExitTable = true;
    else if (!line.startsWith('|')) inExitTable = false;
    else if (inExitTable) {
      const m = /^\| `(\d+)` \| (.*) \|$/.exec(line);
      if (m) rows.set(Number(m[1]), m[2]!);
    }
  }
  return rows;
}

const longFlags = (command: Command): string[] =>
  command.options.map((o) => o.long).filter((l): l is string => l !== undefined);

const scanCommand = (): Command => {
  const mcp = (createProgram().commands as Command[]).find((c) => c.name() === 'mcp');
  const scan = (mcp?.commands as Command[] | undefined)?.find((c) => c.name() === 'scan');
  if (!scan) throw new Error('no `plune mcp scan` in the program');
  return scan;
};

/** What each code means, by the name it has in MCP_EXIT; the row of the table must start with (or say) this. */
const MEANING: Record<keyof typeof MCP_EXIT, RegExp> = {
  ok: /^No finding that gates\b/,
  violations: /^At least one finding that gates\b/,
  usage: /^Usage\b/,
  unmeasured: /could not be measured/,
};

describe('CLI · docs · the plune mcp scan section matches the command', () => {
  const section = scanSection(GUIDE);
  const all = longFlags(scanCommand());
  const shared = new Set(longFlags(addConnectionOptions(new Command('x'))));
  const own = all.filter((f) => !shared.has(f));

  it('finds the section, its flag tables and its exit table', () => {
    expect(section.length).toBeGreaterThan(500);
    expect(tableFlags(section).length).toBeGreaterThan(10);
    expect(exitRows(section).size).toBeGreaterThan(0);
    expect(own.length).toBeGreaterThan(20);
  });

  it('every flag in a flag table is a flag of plune mcp scan', () => {
    expect(tableFlags(section).filter((f) => !all.includes(f))).toEqual([]);
  });

  it('every flag of plune mcp scan, other than the shared connection flags, is named in the section', () => {
    expect(own.filter((f) => !new RegExp(`${f}(?![a-z-])`).test(section))).toEqual([]);
  });

  it('the exit table has exactly the codes of MCP_EXIT, each with its meaning', () => {
    const rows = exitRows(section);
    expect([...rows.keys()].sort()).toEqual(Object.values(MCP_EXIT).sort());
    for (const [name, code] of Object.entries(MCP_EXIT) as [keyof typeof MCP_EXIT, number][])
      expect(rows.get(code), `exit ${code} (${name})`).toMatch(MEANING[name]);
  });
});
