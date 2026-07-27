import { clearToken } from '../credentials.js';

/** Remove the saved API token (`plune logout`). Returns whether one was present + the path. */
export function handleLogout(): { removed: boolean; path: string } {
  return clearToken();
}
