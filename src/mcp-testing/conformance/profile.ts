/**
 * The frozen profile: the ids the score counts, written out one by one. A check added to the catalog runs and shows
 * its verdict, but stays `pending` for the score until a new profile version lists it, so a new check never re-scores
 * a server that was measured before. The list is literals on purpose, never read from the catalog: a test refuses
 * anything else. Changing the list means a new `version` (and the digest the test expects for it), in its own review.
 */

import { createHash } from 'node:crypto';

export interface Profile {
  id: string;
  /** `<year>-<month>.<n>`. */
  version: string;
  checks: readonly string[];
}

export const PROFILE: Profile = {
  id: 'plune-mcp-conformance',
  version: '2026-11.1',
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
    'logging-set-level',
    'completion-complete',
    'stdio-stdout-clean',
  ],
};

/** SHA-256 of the ids, sorted and one per line: the same set gives the same digest in any order. */
export const manifestDigest = (ids: readonly string[]): string =>
  createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
