import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmptyTokenError,
  LoginHttpError,
  LoginNetworkError,
  TokenRejectedError,
  handleLogin,
  reportLoginFailure,
} from '../login.js';

/**
 * Checking the token at the moment it is pasted (#329).
 *
 * Before this, `plune login` accepted anything. A wrong token surfaced two commands later, on
 * `plune sync`, as a failure that looks like something else — and by then the person has also spent
 * an eval run getting there. One request turns that into "this token is wrong, here is a right one".
 *
 * The credentials file is the assertion that matters on the failure paths: NOT saved. A message that
 * says "rejected" while a bad token sits on disk is worse than no message, because the next command
 * will find it and fail differently again.
 */

const TOKEN = 'plune_aaaabbbbccccddddeeeeffff0011';
const API = 'https://api.test';

let home: string;
beforeEach(() => {
  // `credentials.ts` writes under the XDG config dir; point it at a throwaway so nothing touches the
  // real one and so "was a file written?" is answerable.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-login-'));
  vi.stubEnv('XDG_CONFIG_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const credentials = (): string => path.join(home, 'plune', 'credentials.json');

const answering = (status: number, body = '{}'): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe('handleLogin', () => {
  it('saves the token once the api accepts it', async () => {
    const result = await handleLogin({
      token: TOKEN,
      apiUrl: API,
      fetchImpl: answering(200, '{"runs":[]}'),
    });

    expect(result.verified).toBe(true);
    expect(fs.existsSync(credentials())).toBe(true);
    expect(fs.readFileSync(credentials(), 'utf8')).toContain(TOKEN);
  });

  it('checks against /v1/runs, and sends the token as a header', async () => {
    // `/v1/me` would be the obvious choice and is the wrong one: it is guarded by the SESSION cookie,
    // so it answers 401 for a perfectly good CLI token and would reject every token in existence.
    //
    // Header, never query: a query string reaches proxy logs, and a credential in a log has leaked.
    let seen: { url: string; init: RequestInit } | undefined;
    await handleLogin({
      token: TOKEN,
      apiUrl: API,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(seen?.url).toBe(`${API}/v1/runs?limit=1`);
    expect(seen?.url).not.toContain(TOKEN);
    expect((seen?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a rejected token and writes nothing', async () => {
    await expect(
      handleLogin({ token: TOKEN, apiUrl: API, fetchImpl: answering(401) }),
    ).rejects.toBeInstanceOf(TokenRejectedError);
    expect(fs.existsSync(credentials())).toBe(false);
  });

  it('writes nothing when the api cannot be reached', async () => {
    await expect(
      handleLogin({
        token: TOKEN,
        apiUrl: API,
        fetchImpl: (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(LoginNetworkError);
    expect(fs.existsSync(credentials())).toBe(false);
  });

  it('writes nothing when the api answers with something else entirely', async () => {
    await expect(
      handleLogin({ token: TOKEN, apiUrl: API, fetchImpl: answering(503) }),
    ).rejects.toBeInstanceOf(LoginHttpError);
    expect(fs.existsSync(credentials())).toBe(false);
  });

  it('saves without asking when told to, and says it did not check', async () => {
    // For setting a machine up with no network. The caller prints a different line for this, because
    // "logged in" would be a claim nothing verified.
    const result = await handleLogin({
      token: TOKEN,
      apiUrl: API,
      skipVerify: true,
      fetchImpl: (() => {
        throw new Error('must not be called');
      }) as unknown as typeof fetch,
    });

    expect(result.verified).toBe(false);
    expect(fs.existsSync(credentials())).toBe(true);
  });

  it('refuses a blank token before touching the network', async () => {
    await expect(
      handleLogin({
        token: '   ',
        apiUrl: API,
        fetchImpl: (() => {
          throw new Error('must not be called');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(EmptyTokenError);
  });
});

describe('the token never appears in anything printed', () => {
  it.each([
    ['rejected', new TokenRejectedError(API)],
    ['network', new LoginNetworkError(API)],
    ['http', new LoginHttpError(503)],
    ['empty', new EmptyTokenError(API)],
  ])('%s', (_case, err) => {
    // The security half. Every one of these messages is written to a terminal that may be recorded,
    // pasted into an issue, or scrolled past by someone standing behind the person.
    let out = '';
    const code = reportLoginFailure(err, (s) => {
      out += s;
    });
    expect(code).not.toBeNull();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TOKEN.slice(0, 12));
  });
});

describe('the messages say where a token comes from (#330)', () => {
  it('names the dashboard for the deployment we know', () => {
    // Derived from the api url, not hard-coded three times: someone self-hosting must not be sent to
    // our beta, and the rule for turning one host into the other lives in exactly one place.
    expect(new EmptyTokenError('https://beta-api.plune.ai').message).toContain(
      'https://beta.plune.ai',
    );
    expect(new TokenRejectedError('https://beta-api.plune.ai').message).toContain(
      'Settings → API tokens',
    );
  });

  it('does not guess a web address for a deployment it has never seen', () => {
    // Guessing "the host minus -api" would send a self-hoster somewhere that may not exist. Naming
    // their api and letting them find their own dashboard is the honest answer.
    const message = new EmptyTokenError('https://plune.internal.example').message;
    expect(message).not.toContain('beta.plune.ai');
    expect(message).toContain('https://plune.internal.example');
  });
});
