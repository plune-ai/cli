// Masking, as a table: what goes in, what may come out. Everything the connection core writes anywhere passes
// through redact.ts; the frame sent to the server is never touched, only the copy that is written down.

import { describe, expect, it } from 'vitest';
import { describeTarget, maskUrl, redactorFor } from '../connect/redact.js';

const target = {
  kind: 'http' as const,
  url: 'http://alice:pa55word-long@127.0.0.1:9/mcp?token=query-token-1&page=2',
  headers: {
    Authorization: 'Bearer header-token-1',
    'X-Api-Key': 'short',
    'X-Trace': 'trace value-1',
  },
};

describe('CLI · mcp connect · redact', () => {
  const r = redactorFor(target);

  it.each([
    [
      'a header value anywhere in a text',
      'server said: Bearer header-token-1 is bad',
      'server said: *** is bad',
    ],
    ['the token alone, without its scheme', 'token header-token-1 rejected', 'token *** rejected'],
    ['a value of a header with an ordinary name', 'saw trace value-1', 'saw ***'],
    ['the password of the URL', 'login pa55word-long failed', 'login *** failed'],
    ['a secret query value of the URL', 'q=query-token-1', 'q=***'],
    ['the URL-encoded form of a value', 'saw trace%20value-1', 'saw ***'],
    ['a value shorter than 8 characters is left alone', 'short and 1 and 2', 'short and 1 and 2'],
  ])('CLI · mcp connect · %s', (_name, input, output) => {
    expect(r.text(input)).toBe(output);
  });

  it('CLI · mcp connect · a structure is copied with every string and key masked, the original untouched', () => {
    const frame = {
      jsonrpc: '2.0',
      result: { content: [{ text: 'header-token-1' }], 'header-token-1': 1 },
    };
    const copy = r.value(frame);
    expect(JSON.stringify(copy)).not.toContain('header-token-1');
    expect(frame.result.content[0]!.text).toBe('header-token-1');
  });

  it('CLI · mcp connect · a structure past the depth budget is cut, not walked', () => {
    let deep: unknown = 'header-token-1';
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(JSON.stringify(r.value(deep))).not.toContain('header-token-1');
  });

  it.each([
    ['user and password', 'http://alice:pw@h/mcp', 'http://***:***@h/mcp'],
    [
      'secret query parameters, others kept',
      'http://h/mcp?token=t&api_key=k&access_token=a&key=k2&secret=s&password=p&page=2',
      'http://h/mcp?token=***&api_key=***&access_token=***&key=***&secret=***&password=***&page=2',
    ],
    ['a URL with nothing to hide', 'http://h:1/mcp', 'http://h:1/mcp'],
  ])('CLI · mcp connect · maskUrl hides %s', (_name, input, output) => {
    expect(maskUrl(input)).toBe(output);
  });

  it('CLI · mcp connect · headers are masked by name, whatever the length of the value', () => {
    const shown = describeTarget(
      {
        kind: 'http',
        url: 'http://h/mcp',
        headers: {
          Authorization: 'x',
          Cookie: 'c',
          'Proxy-Authorization': 'p',
          'Set-Cookie': 's',
          'X-Api-Key': 'k',
          'X-Session-Token': 't',
          'X-My-Secret': 'z',
          'X-Auth-User': 'u',
          Accept: 'json',
        },
      },
      redactorFor({ kind: 'http', url: 'http://h/mcp', headers: {} }),
    );
    expect(shown).toMatchObject({
      headers: {
        Authorization: '***',
        Cookie: '***',
        'Proxy-Authorization': '***',
        'Set-Cookie': '***',
        'X-Api-Key': '***',
        'X-Session-Token': '***',
        'X-My-Secret': '***',
        'X-Auth-User': '***',
        Accept: 'json',
      },
    });
  });

  it('CLI · mcp connect · env is masked by name (AC-4: DEBUG=1 does not mask every 1)', () => {
    const stdio = {
      kind: 'stdio' as const,
      command: 'node',
      args: ['s.js'],
      env: { DEBUG: '1', API_TOKEN: 'tok', DB_PASSWORD: 'p', MY_SECRET: 's', PROVIDER_KEY: 'k' },
    };
    const red = redactorFor(stdio);
    expect(describeTarget(stdio, red)).toMatchObject({
      env: {
        DEBUG: '1',
        API_TOKEN: '***',
        DB_PASSWORD: '***',
        MY_SECRET: '***',
        PROVIDER_KEY: '***',
      },
    });
    expect(red.text('step 1 of 1')).toBe('step 1 of 1');
  });
});
