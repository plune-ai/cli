// `@plune-ai/cli/mcp-tools` is a published entry point: the platform's built-in agent
// imports the tool contract from it. It has to exist in `exports`, be built as its own bundle, and stay
// out of the package root so the root keeps its dependency graph.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, Record<string, string>>;
};
const tsup = readFileSync(new URL('../../tsup.config.ts', import.meta.url), 'utf8');
const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('@plune-ai/cli/mcp-tools', () => {
  it('is in package.json exports with types, import and require', () => {
    expect(pkg.exports['./mcp-tools']).toEqual({
      types: './dist/mcp-tools.d.ts',
      import: './dist/mcp-tools.js',
      require: './dist/mcp-tools.cjs',
    });
  });

  it('is a tsup library entry of its own', () => {
    expect(tsup).toContain("'mcp-tools': 'src/mcp-tools/index.ts'");
  });

  it('is not re-exported from the package root', () => {
    expect(root).not.toMatch(/mcp-tools|\.\/mcp\//);
  });
});
