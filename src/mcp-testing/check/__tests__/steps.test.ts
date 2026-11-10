// The checks after the handshake against a session that is only data: what each check makes of a handshake no SDK
// server would send.

import { describe, expect, it } from 'vitest';
import { realClock, runChecks } from '../run.js';
import { healthSteps } from '../steps.js';

const OPTS = { timeoutMs: 1_000, timedOutDetail: 'no answer within --check-timeout (1s)' };

function session(result: unknown, requests: string[] = []) {
  return {
    handshake: { offered: '2025-11-25', result },
    request: async (method: string) => {
      requests.push(method);
      return method === 'ping' ? {} : { tools: [] };
    },
  };
}

const run = async (result: unknown, requests: string[] = []) =>
  (await runChecks(healthSteps(session(result, requests), OPTS, {}), realClock, OPTS)).map(
    (r) => `${r.id} ${r.result.state}: ${r.result.detail}`,
  );

describe('CLI · mcp check · the checks after the handshake', () => {
  it('CLI · mcp check · capabilities that cannot be read are failed, and every list could-not-run, never not-applicable', async () => {
    const requests: string[] = [];
    expect(await run({ protocolVersion: '2025-11-25', capabilities: 'all' }, requests)).toEqual([
      'protocol-version passed: 2025-11-25, the latest this client offered',
      'capabilities failed: the initialize answer has no capabilities object',
      'tools-list could-not-run: the declared capabilities could not be read',
      'resources-list could-not-run: the declared capabilities could not be read',
      'resource-templates-list could-not-run: the declared capabilities could not be read',
      'prompts-list could-not-run: the declared capabilities could not be read',
      'ping passed: answered',
    ]);
    expect(requests).toEqual(['ping']);
  });

  it('CLI · mcp check · an answer without protocolVersion fails that check', async () => {
    const [version] = await run({ capabilities: { tools: {} } });
    expect(version).toBe('protocol-version failed: the initialize answer has no protocolVersion');
  });

  it('CLI · mcp check · a server that declares nothing: every list not-applicable, none asked', async () => {
    const requests: string[] = [];
    const lines = await run({ protocolVersion: '2025-11-25', capabilities: {} }, requests);
    expect(lines[1]).toBe('capabilities passed: declared: nothing');
    expect(
      lines.slice(2, 6).every((l) => l.includes(' not-applicable: the server does not declare ')),
    ).toBe(true);
    expect(requests).toEqual(['ping']);
  });
});
