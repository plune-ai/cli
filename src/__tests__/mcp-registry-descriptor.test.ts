// The MCP Registry descriptor (server.json), the Claude Code plugin (.claude-plugin/plugin.json) and its
// marketplace (.claude-plugin/marketplace.json) each repeat the package's name and version. A release bumps
// package.json; this test fails until the three files are bumped with it, so a catalog never offers a
// version npm does not serve under that name.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPluneToolName } from '../mcp-tools/index.js';

const root = new URL('../../', import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the files are the subject, read as they are
type Json = Record<string, any>;
const json = (path: string): Json => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Json;

const pkg = json('package.json');
const server = json('server.json');
const plugin = json('.claude-plugin/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');

describe('server.json (MCP Registry)', () => {
  it('is named as package.json mcpName says, which the registry checks against npm', () => {
    // Domain-based name: plune.ai proves it with /.well-known/mcp-registry-auth.
    expect(pkg['mcpName']).toBe('ai.plune/cli');
    expect(server['name']).toBe(pkg['mcpName']);
  });

  it('carries the package version, at the top and on the npm package', () => {
    expect(server['version']).toBe(pkg['version']);
    expect(server['packages']).toHaveLength(1);
    const [npm] = server['packages'];
    expect(npm.registryType).toBe('npm');
    expect(npm.identifier).toBe(pkg['name']);
    expect(npm.version).toBe(pkg['version']);
  });

  it('starts the stdio server: `mcp serve`', () => {
    const [npm] = server['packages'];
    expect(npm.transport).toEqual({ type: 'stdio' });
    expect(npm.packageArguments.map((a: { value: string }) => a.value)).toEqual(['mcp', 'serve']);
  });

  it('keeps the description within the registry limit of 100 characters', () => {
    expect(server['description'].length).toBeLessThanOrEqual(100);
  });
});

describe('the Claude Code plugin', () => {
  it('has the package version and starts that exact version of the server', () => {
    expect(plugin['version']).toBe(pkg['version']);
    expect(plugin['mcpServers'].plune).toEqual({
      command: 'npx',
      args: ['-y', `${pkg['name']}@${pkg['version']}`, 'mcp', 'serve'],
    });
  });

  it('is listed in the marketplace under its own name, from the repository root', () => {
    const entries = marketplace['plugins'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!['name']).toBe(plugin['name']);
    expect(entries[0]!['source']).toBe('./');
    // plugin.json wins over an entry version, and the validator warns on both: keep it in one place.
    expect(entries[0]!['version']).toBeUndefined();
  });
});

describe('the plune skill', () => {
  const skill = readFileSync(new URL('skills/plune/SKILL.md', root), 'utf8');

  it('has Agent Skills frontmatter with a name that matches its folder', () => {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? '';
    expect(/^name: (.+)$/m.exec(front)?.[1]).toBe('plune');
    expect((/^description: (.+)$/m.exec(front)?.[1] ?? '').length).toBeGreaterThan(0);
  });

  it('names only tools the contract has', () => {
    const named = new Set(skill.match(/\bplune_[a-z_]+/g));
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(isPluneToolName(name), name).toBe(true);
  });
});
