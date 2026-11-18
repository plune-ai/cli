/**
 * The frozen profile: the ids the score counts, written out one by one. A check added to the catalog runs and shows
 * its verdict, but stays `pending` for the score until a new profile version lists it, so a new check never re-scores
 * a server that was measured before. The list is literals on purpose, never read from the catalog: a test refuses
 * anything else. Changing the list means a new `version` (and the digest the test expects for it), in its own review.
 * So does changing where an id of the list applies (its eras or transports): the ids, and so the digest, stay the
 * same, but a server can get another score for them, and the version says which rules a saved result was made with.
 *
 * Versions: `2026-11.1` the first list. `2026-11.2` the same ids; `base-jsonrpc-parse-error` applies over HTTP only
 * (on stdio it is the advice `stdio-parse-error-advice`). A saved `2026-11.1` result holds its verdicts and scores
 * again to what it recorded. `2026-11.3` adds the MUST checks of Streamable HTTP and of a local server's protection
 * (`http-*`): they apply over HTTP only, so a stdio server scores the same as under `2026-11.2`;
 * on a host that is not a loopback name the protection checks are not-applicable (not-local). The `http-*` checks
 * of level SHOULD, the controls and the advice stay outside the score, as in every version.
 *
 * A run is `2026-11.3` unless `--profile` names another version of `PROFILES`. `2026-11.1` is not offered: its ids
 * are those of `2026-11.2`, and a new run applies them by today's rules, which are the rules of `2026-11.2`.
 */

import { createHash } from 'node:crypto';

export interface Profile {
  id: string;
  /** `<year>-<month>.<n>`. */
  version: string;
  checks: readonly string[];
}

const PROFILE_2026_11_2: Profile = {
  id: 'plune-mcp-conformance',
  version: '2026-11.2',
  checks: [
    'life-initialize-result',
    'life-version-negotiation',
    'life-capabilities-declared-served',
    'life-capabilities-served-declared',
    'life-ping-empty-result',
    'base-jsonrpc-parse-error',
    'base-unknown-method-error',
    'base-response-id-matches',
    'tools-list-shape',
    'tools-input-schema-valid',
    'tools-output-schema-valid',
    'tools-structured-conformant',
    'resources-list-shape',
    'resources-read-listed',
    'resources-templates-shape',
    'prompts-list-shape',
    'stdio-stdout-clean',
  ],
};

const PROFILE_2026_11_3: Profile = {
  id: 'plune-mcp-conformance',
  version: '2026-11.3',
  checks: [
    'life-initialize-result',
    'life-version-negotiation',
    'life-capabilities-declared-served',
    'life-capabilities-served-declared',
    'life-ping-empty-result',
    'base-jsonrpc-parse-error',
    'base-unknown-method-error',
    'base-response-id-matches',
    'tools-list-shape',
    'tools-input-schema-valid',
    'tools-output-schema-valid',
    'tools-structured-conformant',
    'resources-list-shape',
    'resources-read-listed',
    'resources-templates-shape',
    'prompts-list-shape',
    'stdio-stdout-clean',
    'http-notification-202',
    'http-request-content-type',
    'http-response-utf8',
    'http-single-endpoint',
    'http-get-stream-or-405',
    'http-session-id-visible-ascii',
    'http-protocol-version-header-invalid-400',
    'http-concurrent-posts-matched',
    'http-sse-event-ids-unique',
    'http-sse-no-server-requests',
    'http-close-cancels',
    'http-session-terminated-404',
    'http-sse-no-broadcast',
    'http-origin-invalid-403',
  ],
};

/** The current profile: a run without `--profile`. */
export const PROFILE: Profile = PROFILE_2026_11_3;

/** The versions `--profile` takes, oldest first. */
export const PROFILES: readonly Profile[] = [PROFILE_2026_11_2, PROFILE_2026_11_3];

/** The profile of this version, or undefined when `--profile` does not offer it. */
export const profileOf = (version: string): Profile | undefined => PROFILES.find((p) => p.version === version);

/** SHA-256 of the ids, sorted and one per line: the same set gives the same digest in any order. */
export const manifestDigest = (ids: readonly string[]): string =>
  createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
