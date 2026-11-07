import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleMcpServe } from '../mcp.js';
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
});
