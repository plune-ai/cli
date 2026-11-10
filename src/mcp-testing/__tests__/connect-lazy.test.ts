// AC-14: `plune --version` and `plune --help` do not load the connection core or the MCP client. The core is reached
// only through a dynamic import inside a `plune mcp` action (cold start, see the top of src/cli.ts). The connection
// flags (connect/options.ts: commander and a duration parser) are the one part src/cli.ts imports at the top.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ session: false, lint: false, check: false }));
vi.mock('../connect/session.js', () => {
  loaded.session = true;
  return {};
});
vi.mock('../../cli/commands/mcp-lint.js', () => {
  loaded.lint = true;
  return {};
});
vi.mock('../../cli/commands/mcp-check.js', () => {
  loaded.check = true;
  return {};
});
const contract = vi.hoisted(() => ({ snapshot: false, diff: false }));
vi.mock('../../cli/commands/mcp-snapshot.js', () => {
  contract.snapshot = true;
  return {};
});
vi.mock('../../cli/commands/mcp-diff.js', () => {
  contract.diff = true;
  return {};
});

import type { Command } from 'commander';
import { createProgram } from '../../cli.js';

/** Every command throws instead of exiting and prints nothing; commander does not hand either down. */
function quiet(cmd: Command): Command {
  cmd.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  for (const sub of cmd.commands) quiet(sub);
  return cmd;
}

function run(argv: string[]): void {
  const program = quiet(createProgram());
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    expect((err as { exitCode?: number }).exitCode).toBe(0);
  }
}

describe('CLI · mcp connect · cold start', () => {
  it('CLI · mcp connect · --version and --help do not load the connection core (AC-14)', () => {
    run(['--version']);
    run(['--help']);
    run(['mcp', '--help']);
    run(['mcp', 'lint', '--help']);
    run(['mcp', 'check', '--help']);
    expect(loaded).toEqual({ session: false, lint: false, check: false });
  });

  it('CLI · mcp snapshot · --help of snapshot and diff loads neither command nor the connection core', () => {
    run(['mcp', 'snapshot', '--help']);
    run(['mcp', 'diff', '--help']);
    expect({ ...loaded, ...contract }).toEqual({
      session: false,
      lint: false,
      check: false,
      snapshot: false,
      diff: false,
    });
  });

  it('CLI · mcp connect · src/cli.ts imports neither the core, the lint command nor the MCP client at the top', () => {
    const top = readFileSync(new URL('../../cli.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('import ') && !l.startsWith('import type '));
    expect(top.join('\n')).not.toMatch(
      /mcp-testing\/(?!connect\/options\.js')|@modelcontextprotocol|mcp-lint|mcp-check|mcp-snapshot|mcp-diff/,
    );
  });

  it('CLI · mcp connect · mcp is a group: serve and lint under it', () => {
    const mcp = createProgram().commands.find((c) => c.name() === 'mcp');
    expect(
      mcp?.commands.map((c) => c.name()).filter((n) => n !== 'snapshot' && n !== 'diff'),
    ).toEqual(['serve', 'check', 'lint']);
  });

  it('CLI · mcp snapshot · snapshot and diff hang on the mcp group, after lint', () => {
    const names =
      createProgram()
        .commands.find((c) => c.name() === 'mcp')
        ?.commands.map((c) => c.name()) ?? [];
    expect(names).toEqual(['serve', 'check', 'lint', 'snapshot', 'diff']);
  });
});
