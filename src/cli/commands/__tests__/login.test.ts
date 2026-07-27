import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadToken } from '../../credentials.js';
import { EmptyTokenError, handleLogin } from '../login.js';
import { handleLogout } from '../logout.js';

let tmp: string;
let savedXdg: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plune-login-'));
  savedXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = tmp;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = savedXdg;
  vi.restoreAllMocks();
});

describe('plune login / logout (#48)', () => {
  it('handleLogin stores the token and returns its path', () => {
    const { path } = handleLogin({ token: 'plune_tok' });
    expect(loadToken()).toBe('plune_tok');
    expect(path.startsWith(tmp)).toBe(true);
  });

  it('handleLogin trims and rejects a blank token', () => {
    expect(() => handleLogin({ token: '   ' })).toThrow(EmptyTokenError);
    expect(loadToken()).toBeNull();
  });

  it('handleLogout removes a stored token; a second call is a no-op', () => {
    handleLogin({ token: 'plune_bye' });
    expect(handleLogout().removed).toBe(true);
    expect(loadToken()).toBeNull();
    expect(handleLogout().removed).toBe(false);
  });

  // DoD: the token must never surface in the terminal, even under --verbose.
  it('the login command reports success but never echoes the token (incl. --verbose)', async () => {
    const out: string[] = [];
    const capture = (c: string | Uint8Array): boolean => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    const { createProgram } = await import('../../../cli.js');
    // --verbose is a global flag → placed before the subcommand.
    await createProgram().parseAsync(['node', 'plune', '--verbose', 'login', '--token', 'plune_SUPERSECRET']);

    const printed = out.join('');
    expect(printed).not.toContain('plune_SUPERSECRET'); // no leak anywhere in output
    expect(printed).toContain('Token saved to'); // success was still reported
    expect(loadToken()).toBe('plune_SUPERSECRET'); // and it really persisted
  });

  it('the login command rejects an empty --token with exit 2 and a hint (no token stored)', async () => {
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      err.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as (code?: string | number | null) => never);

    const { createProgram } = await import('../../../cli.js');
    await createProgram().parseAsync(['node', 'plune', 'login', '--token', '']);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(err.join('')).toContain('No API token');
    expect(loadToken()).toBeNull();
  });

  it('the logout command removes a stored token and reports it', async () => {
    handleLogin({ token: 'plune_wired' });
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      out.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });

    const { createProgram } = await import('../../../cli.js');
    await createProgram().parseAsync(['node', 'plune', 'logout']);

    expect(out.join('')).toContain('Logged out');
    expect(loadToken()).toBeNull();
  });
});
