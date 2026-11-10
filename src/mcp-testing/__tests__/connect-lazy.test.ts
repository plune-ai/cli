// AC-14: `plune --version` and `plune --help` do not load the connection core or the MCP client. The core is reached
// only through a dynamic import inside a `plune mcp` action (cold start, see the top of src/cli.ts).

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ session: false }));
vi.mock('../connect/session.js', () => {
  loaded.session = true;
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
    expect(loaded.session).toBe(false);
  });

  it('CLI · mcp connect · src/cli.ts imports neither the core nor the MCP client at the top', () => {
    const top = readFileSync(new URL('../../cli.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('import '));
    expect(top.join('\n')).not.toMatch(/mcp-testing|@modelcontextprotocol/);
  });

  it('CLI · mcp connect · mcp is a group: serve under it, nothing new visible', () => {
    const mcp = createProgram().commands.find((c) => c.name() === 'mcp');
    expect(mcp?.commands.map((c) => c.name())).toEqual(['serve']);
  });
});
