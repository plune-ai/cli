import { saveToken } from '../credentials.js';

/** A pasted token that was empty/blank — the CLI maps this to a clean exit, not a stack trace. */
export class EmptyTokenError extends Error {
  constructor() {
    super('No API token provided. Pass --token <token> or pipe it via stdin.');
    this.name = 'EmptyTokenError';
  }
}

/**
 * Save the API token the user pasted (`plune login`). The token is resolved by the caller (from
 * `--token`, piped stdin, or an interactive paste); this trims + validates it is non-empty and persists
 * it 0600. Returns only the path — the token itself is never returned for printing, so it can't leak.
 */
export function handleLogin(opts: { token: string }): { path: string } {
  const token = opts.token.trim();
  if (token.length === 0) throw new EmptyTokenError();
  return { path: saveToken(token) };
}
