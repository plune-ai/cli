import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearToken, credentialsFile, loadToken, saveToken } from '../credentials.js';

let tmp: string;
let savedXdg: string | undefined;

// Redirect the store into a temp dir via XDG_CONFIG_HOME so no test ever touches the real ~/.config.
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plune-creds-'));
  savedXdg = process.env['XDG_CONFIG_HOME'];
  process.env['XDG_CONFIG_HOME'] = tmp;
});
afterEach(() => {
  if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = savedXdg;
});

describe('credentials store (#48)', () => {
  it('save → load round-trips the token, isolated to the config dir', () => {
    saveToken('plune_abc123');
    expect(loadToken()).toBe('plune_abc123');
    expect(credentialsFile().startsWith(tmp)).toBe(true);
  });

  it('writes the file 0600 (POSIX perms)', () => {
    const file = saveToken('plune_secret');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('loadToken → null when nothing is saved', () => {
    expect(loadToken()).toBeNull();
  });

  it('loadToken → null on corrupt content (not "not logged in" thrown)', () => {
    saveToken('x'); // create the dir
    writeFileSync(credentialsFile(), 'not-json');
    expect(loadToken()).toBeNull();
  });

  it('loadToken → null when the token field is empty or the wrong type', () => {
    saveToken('x');
    writeFileSync(credentialsFile(), JSON.stringify({ token: '' }));
    expect(loadToken()).toBeNull();
    writeFileSync(credentialsFile(), JSON.stringify({ token: 42 }));
    expect(loadToken()).toBeNull();
  });

  it('clearToken removes the file and is idempotent', () => {
    saveToken('plune_gone');
    expect(clearToken().removed).toBe(true);
    expect(existsSync(credentialsFile())).toBe(false);
    expect(loadToken()).toBeNull();
    expect(clearToken().removed).toBe(false); // already absent → no-op, not an error
  });

  it('saveToken overwrites an existing token', () => {
    saveToken('first');
    saveToken('second');
    expect(loadToken()).toBe('second');
  });
});
