import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProgram } from '../../../cli.js';
import { PLUNE_TOOL_NAMES } from '../../../mcp-tools/index.js';
import { NoSuchToolError, handleMcpServe } from '../mcp.js';
import { NotLoggedInError } from '../sync.js';
import type { PluneMcpServerOptions } from '../../../mcp/server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function capture(): { serve: (o: PluneMcpServerOptions) => Promise<void>; calls: PluneMcpServerOptions[] } {
  const calls: PluneMcpServerOptions[] = [];
  return {
    calls,
    serve: async (o) => {
      calls.push(o);
    },
  };
}

describe('plune mcp serve', () => {
  it('refuses to start without a token, before serving anything', async () => {
    const { serve, calls } = capture();
    await expect(
      handleMcpServe({}, { loadToken: () => null, serve, version: '1.2.3' }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(calls).toHaveLength(0);
  });

  it('serves with the token, the API URL without a trailing slash and the CLI version', async () => {
    const { serve, calls } = capture();
    await handleMcpServe({}, { loadToken: () => 'tok', apiUrl: 'https://beta-api.plune.ai/', serve, version: '1.2.3' });
    expect(calls).toEqual([{ token: 'tok', apiUrl: 'https://beta-api.plune.ai', version: '1.2.3' }]);
  });

  it('takes the project from --project first, then PLUNE_PROJECT', async () => {
    vi.stubEnv('PLUNE_PROJECT', '  from-env  ');
    const a = capture();
    await handleMcpServe({ project: 'from-flag' }, { loadToken: () => 'tok', apiUrl: 'https://x', serve: a.serve, version: '1' });
    expect(a.calls[0]?.projectId).toBe('from-flag');

    const b = capture();
    await handleMcpServe({}, { loadToken: () => 'tok', apiUrl: 'https://x', serve: b.serve, version: '1' });
    expect(b.calls[0]?.projectId).toBe('from-env');
  });

  it('marks the scope read only with --read-only', async () => {
    const a = capture();
    await handleMcpServe({ readOnly: true }, { loadToken: () => 'tok', apiUrl: 'https://x', serve: a.serve, version: '1' });
    expect(a.calls[0]?.scope).toBe('read');

    const b = capture();
    await handleMcpServe({}, { loadToken: () => 'tok', apiUrl: 'https://x', serve: b.serve, version: '1' });
    expect(b.calls[0]).not.toHaveProperty('scope');
  });

  it('CLI · mcp serve · --disable-tool: every name given is passed on as disabledTools, and none is passed without the flag', async () => {
    const a = capture();
    await handleMcpServe(
      { disableTool: ['plune_api_request', ' plune_mission_create '] },
      { loadToken: () => 'tok', apiUrl: 'https://x', serve: a.serve, version: '1' },
    );
    expect(a.calls[0]?.disabledTools).toEqual(['plune_api_request', 'plune_mission_create']);

    const b = capture();
    await handleMcpServe({ disableTool: [] }, { loadToken: () => 'tok', apiUrl: 'https://x', serve: b.serve, version: '1' });
    expect(b.calls[0]).not.toHaveProperty('disabledTools');
  });

  it('CLI · mcp serve · --disable-tool with a name that is no tool: refused before the token is read or anything is served', async () => {
    const { serve, calls } = capture();
    const loadToken = vi.fn(() => 'tok');
    const run = handleMcpServe({ disableTool: ['plune_api_request', 'plune_nope'] }, { loadToken, apiUrl: 'https://x', serve, version: '1' });
    await expect(run).rejects.toBeInstanceOf(NoSuchToolError);
    await expect(run).rejects.toThrow(`no such tool: plune_nope. The tools are: ${PLUNE_TOOL_NAMES.join(', ')}`);
    expect(loadToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('CLI · mcp serve · --disable-tool with a name that is no tool: one line on stderr and exit 2', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await createProgram().parseAsync(['node', 'plune', 'mcp', 'serve', '--disable-tool', 'plune_api_request', '--disable-tool', 'plune_nope']);
      expect(process.exitCode).toBe(2);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
        `plune: no such tool: plune_nope. The tools are: ${PLUNE_TOOL_NAMES.join(', ')}\n`,
      );
    } finally {
      process.exitCode = undefined;
      stderr.mockRestore();
    }
  });
});
