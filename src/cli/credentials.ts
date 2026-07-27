import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Local storage for the platform API token — the credential `plune sync` sends as
 * `Authorization: Bearer …`. Kept OUT of the repo and cwd: it lives under the user's config dir, mode
 * 0600, so it never lands in a commit, a Docker layer, or a shared checkout.
 *
 * Path honours `XDG_CONFIG_HOME`, else `~/.config/plune/credentials.json`. It is resolved at call
 * time, not at import, so a test can point it at a temp dir per-case.
 */
export function credentialsFile(): string {
  const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config');
  return join(base, 'plune', 'credentials.json');
}

/** Persist the API token at 0600 under a 0700 dir (a secret at rest). Returns the file path. */
export function saveToken(token: string): string {
  const file = credentialsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // `mode` on writeFileSync only applies when the file is CREATED; chmod after covers a pre-existing
  // file that might have looser perms (and re-asserts 0600 regardless of the process umask).
  writeFileSync(file, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** The stored token, or `null` if none is saved (missing file or unreadable/corrupt content). */
export function loadToken(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(), 'utf-8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null; // ENOENT or bad JSON → simply "not logged in"
  }
}

/** Remove the stored credentials. Returns whether a file was actually deleted (for a truthful message). */
export function clearToken(): { removed: boolean; path: string } {
  const file = credentialsFile();
  if (!existsSync(file)) return { removed: false, path: file };
  rmSync(file); // a real failure here (e.g. perms) propagates — better than a silent "nothing removed"
  return { removed: true, path: file };
}
