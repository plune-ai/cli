// Every command the CLI offers is named in README.md — the file npm renders as the package page.
//
// This is the cheap half of a problem no check can solve whole. A claim that WAS true does not
// look broken, so nothing here can tell "true" from "was true"; that only travels in the same
// commit as the behaviour, which is why the PR checklist asks. What a machine CAN see is a
// command that is public and mentioned nowhere — and it saw two the first time it ran: `run
// start` and `run report` had shipped without a line anywhere in the README.

import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../../cli.js';

const README = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

function commandPaths(command: Command, prefix: string[] = []): string[] {
  return (command.commands as Command[]).flatMap((sub) => {
    const next = [...prefix, sub.name()];
    return [next.join(' '), ...commandPaths(sub, next)];
  });
}

describe('README names every command', () => {
  const paths = commandPaths(createProgram());

  // Without this, a createProgram() that registered nothing would make the case below vacuously
  // green — every command documented, because there are no commands. That is the exact shape of
  // failure this file exists to catch, so it must not be the shape this file can have.
  it('walks a command tree that is actually there', () => {
    expect(paths).toContain('run import');
    expect(paths.length).toBeGreaterThan(8);
  });

  it.each(paths)('names `plune %s`', (path) => {
    expect(README).toContain(`plune ${path}`);
  });
});
