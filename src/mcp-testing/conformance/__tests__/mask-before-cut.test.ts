// A message of the server is cut to a few characters for the report, and the report masks the secrets of the run. Masked
// after the cut, a secret that the cut falls inside is left as a prefix nobody can find. One test per suite that prints
// such text: the secret is one the run knows, placed so the cut falls inside it, and no 8 characters in a row of it may
// be in the JSON or the human output.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import { authFixture, CLIENT_ID, CLIENT_SECRET, type AuthFixture } from './auth-fixture.js';

vi.setConfig({ testTimeout: 60_000 });
const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-mask-'));
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../__tests__/fixtures/${name}`, import.meta.url));
const SECRET = 'Zq7vK2mXpL9wR4tY8nB3cD6fG1hJ5sA0eU2iO';

async function run(flags: McpConformanceFlags, server: string[], env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  await handleMcpConformance({ timeout: '10s', ...flags }, server, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env,
    cwd: dir,
    clientVersion: '9.9.9',
  });
  return `${out}\n${err}`;
}

/** No 8 characters in a row of `secret` anywhere in `text`. */
const leaks = (text: string, secret: string) => {
  const found: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i++)
    if (text.includes(secret.slice(i, i + 8))) found.push(secret.slice(i, i + 8));
  return found;
};

describe('CLI · mcp conformance · a secret is masked before a message is cut', () => {
  it('protocol: the message of a JSON-RPC error', async () => {
    for (const format of ['json', 'human']) {
      const all = await run(
        { format, check: ['base-unknown-method-error'], env: [`SECRET_TEXT=${SECRET}`] },
        [process.execPath, fixture('conformance-server.mjs'), 'secret-error'],
      );
      if (format === 'json') expect(all).toContain('base-unknown-method-error');
      if (format === 'json') expect(all).toContain('-32000');
      expect(leaks(all, SECRET), format).toEqual([]);
    }
  });

  it('modern: the message of a JSON-RPC error', async () => {
    for (const format of ['json', 'human']) {
      const all = await run(
        {
          format,
          protocolVersion: '2026-07-28',
          check: ['mod-resource-not-found'],
          env: [`SECRET_TEXT=${SECRET}`],
        },
        [process.execPath, fixture('modern-server.mjs'), 'secret-error'],
      );
      if (format === 'json') expect(all).toContain('mod-resource-not-found');
      if (format === 'json') expect(all).toContain('-32002');
      expect(leaks(all, SECRET), format).toEqual([]);
    }
  });

  it('apps: the message of a refused resources/read', async () => {
    for (const format of ['json', 'human']) {
      const all = await run(
        {
          format,
          suite: ['apps'],
          check: ['apps-ui-resource-exists'],
          env: [`SECRET_TEXT=${SECRET}`],
        },
        [process.execPath, fixture('apps-server.mjs'), 'error-secret'],
      );
      if (format === 'json') expect(all).toContain('-32603');
      expect(leaks(all, SECRET), format).toEqual([]);
    }
  });

  describe('oauth: the error of a token endpoint', () => {
    const open: AuthFixture[] = [];
    afterEach(async () => {
      for (const f of open.splice(0)) await f.close();
    });

    it('a client secret inside the error is masked before the error is cut', async () => {
      const s = await authFixture({ tokenError: `${'e'.repeat(50)}${CLIENT_SECRET}` });
      open.push(s);
      const config = join(dir, 'client.json');
      writeFileSync(
        config,
        JSON.stringify({
          auth: 'client-credentials',
          registration: {
            method: 'preregistered',
            clientId: CLIENT_ID,
            clientSecretEnv: 'PLUNE_TEST_MASK_SECRET',
          },
          scopes: ['mcp:tools'],
        }),
      );
      for (const format of ['json', 'human']) {
        const all = await run(
          {
            format,
            suite: ['oauth'],
            protocolVersion: '2026-07-28',
            url: s.url,
            config,
            allowOrigin: [new URL(s.url).origin],
          },
          [],
          { PLUNE_TEST_MASK_SECRET: CLIENT_SECRET },
        );
        if (format === 'json') expect(all).toContain('HTTP 400');
        expect(leaks(all, CLIENT_SECRET), format).toEqual([]);
      }
    });

    it.each([
      ['the token type of the full token', { tokenType: `${'e'.repeat(30)}${CLIENT_SECRET}` }],
      [
        'the token type of the narrow token',
        { narrowTokenType: `${'e'.repeat(30)}${CLIENT_SECRET}` },
      ],
    ])('%s is masked before it is cut (scope check)', async (_name, opts) => {
      const s = await authFixture({ scopeRule: 'require-full', ...opts });
      open.push(s);
      const config = join(dir, 'scope.json');
      writeFileSync(
        config,
        JSON.stringify({
          auth: 'client-credentials',
          registration: {
            method: 'preregistered',
            clientId: CLIENT_ID,
            clientSecretEnv: 'PLUNE_TEST_MASK_SECRET',
          },
          scopes: ['mcp:tools', 'mcp:read'],
          narrowScopes: ['mcp:read'],
        }),
      );
      for (const format of ['json', 'human']) {
        const all = await run(
          {
            format,
            suite: ['oauth'],
            check: ['oauth-neg-insufficient-scope'],
            protocolVersion: '2026-07-28',
            url: s.url,
            config,
            allowOrigin: [new URL(s.url).origin],
          },
          [],
          { PLUNE_TEST_MASK_SECRET: CLIENT_SECRET },
        );
        if (format === 'json') expect(all).toContain('token type');
        expect(leaks(all, CLIENT_SECRET), format).toEqual([]);
      }
    });
  });
});
