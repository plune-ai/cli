// `--config` of the oauth suite in YAML: the same strict validation as JSON, a size limit before parsing, and no
// anchor, alias, custom tag or merge key (a small file must not become a large one when it is read).

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../connect/options.js';
import { loadOauthConfig, parseOauthConfig } from '../checks/auth-config.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-config-'));
let n = 0;
const file = (ext: string, text: string) => {
  const path = join(dir, `c${++n}.${ext}`);
  writeFileSync(path, text);
  return path;
};

const GOOD = `
auth: client-credentials
scopes: [mcp:tools, mcp:read]
narrowScopes: [mcp:read]
redirectUri: http://127.0.0.1:8765/callback
registration:
  method: preregistered
  clientId: my-test-client
  clientSecretEnv: MCP_CLIENT_SECRET
`;

describe('CLI · mcp conformance · oauth --config · YAML', () => {
  it('a .yaml and a .yml file are read like the same JSON', () => {
    const asJson = file(
      'json',
      JSON.stringify({
        auth: 'client-credentials',
        scopes: ['mcp:tools', 'mcp:read'],
        narrowScopes: ['mcp:read'],
        redirectUri: 'http://127.0.0.1:8765/callback',
        registration: {
          method: 'preregistered',
          clientId: 'my-test-client',
          clientSecretEnv: 'MCP_CLIENT_SECRET',
        },
      }),
    );
    expect(loadOauthConfig(file('yaml', GOOD))).toEqual(loadOauthConfig(asJson));
    expect(loadOauthConfig(file('yml', GOOD))).toEqual(loadOauthConfig(asJson));
  });

  it('a registration list is read from YAML too', () => {
    const c = parseOauthConfig(
      'registration:\n  - method: preregistered\n    clientId: a\n  - method: cimd\n    clientIdMetadataUrl: https://c.example/c.json\n',
      'yaml',
    );
    expect(c.registrations?.map((r) => r.method)).toEqual(['preregistered', 'cimd']);
  });

  it('the rules of JSON hold: unknown key, a secret key, narrowScopes outside scopes, a scope with white space', () => {
    for (const [text, says] of [
      ['auth: headless\nnope: 1\n', /unknown key "nope"/],
      ['registration:\n  method: preregistered\n  clientSecret: x\n', /secret is never written/],
      ['scopes: [a]\nnarrowScopes: [b]\n', /must be a subset/],
      ['scopes: ["a b"]\n', /white space|one word/i],
      ['auth: nope\n', /"auth"/],
      ['- a\n- b\n', /must hold/],
      ['just text\n', /must hold/],
    ] as const)
      expect(() => parseOauthConfig(text, 'yaml'), text).toThrow(says);
  });

  it('a YAML file that cannot be parsed, or holds two documents or a repeated key, is a usage error', () => {
    for (const text of [
      'auth: [unclosed\n',
      'auth: headless\n---\nauth: headless\n',
      'auth: headless\nauth: headless\n',
    ])
      expect(() => parseOauthConfig(text, 'yaml'), text).toThrow(UsageError);
  });

  it('an anchor, an alias, a custom tag and a merge key are refused, each by name', () => {
    for (const [text, says] of [
      ['scopes: &s [a]\nnarrowScopes: [a]\n', /anchor/i],
      ['scopes: &s [a, b]\nnarrowScopes: *s\n', /anchor|alias/i],
      ['scopes: [a]\nresource: !custom https://x.example\n', /tag/i],
      ['scopes: [a]\nresource: !!binary aGk=\n', /tag/i],
      ['registration:\n  <<: {method: dcr}\n  clientId: a\n', /merge key/i],
      ['<<: {auth: headless}\n', /merge key/i],
    ] as const)
      expect(() => parseOauthConfig(text, 'yaml'), text).toThrow(says);
  });

  it('a billion-laughs file is refused at once with a plain usage error, nothing is expanded', () => {
    const lines = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    let prev = 'a';
    for (const k of 'bcdefghi') {
      lines.push(`${k}: &${k} [${Array(9).fill(`*${prev}`).join(',')}]`);
      prev = k;
    }
    lines.push(`scopes: *${prev}`);
    const started = Date.now();
    let error: unknown;
    try {
      parseOauthConfig(lines.join('\n'), 'yaml');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/anchor|alias/i);
    expect((error as Error).message.length).toBeLessThan(300);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a file over the size limit is refused before it is parsed, in YAML and in JSON', () => {
    const big = `scopes: [${'a,'.repeat(200_000)}a]\n`;
    expect(() => parseOauthConfig(big, 'yaml')).toThrow(/too large|larger than/i);
    expect(() => parseOauthConfig(JSON.stringify({ scopes: Array(200_000).fill('a') }))).toThrow(
      /too large|larger than/i,
    );
    expect(() => loadOauthConfig(file('yaml', big))).toThrow(/too large|larger than/i);
  });

  it('a file that is not named .yaml or .yml is still JSON, and the error says YAML is read by extension', () => {
    expect(() => loadOauthConfig(file('conf', GOOD))).toThrow(/\.yaml|\.yml/);
  });

  it('a file over the limit is refused by its size, without being read, in YAML and in JSON', () => {
    for (const [ext, text] of [
      [
        'yaml',
        `scopes: [${'a,'.repeat(40_000)}a]
`,
      ],
      ['json', JSON.stringify({ scopes: Array(40_000).fill('a') })],
    ] as const) {
      const path = file(ext, text);
      vi.mocked(readFileSync).mockClear();
      expect(() => loadOauthConfig(path), ext).toThrow(/too large/);
      expect(
        vi.mocked(readFileSync).mock.calls.filter(([p]) => p === path),
        ext,
      ).toEqual([]);
    }
  });
});
