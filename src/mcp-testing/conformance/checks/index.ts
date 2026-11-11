/**
 * The registry of check implementations, by catalog id. A test holds it and the catalog to the same set of ids, so
 * neither gains an id the other lacks. An implementation takes its title and description from the catalog, never a
 * copy of its own.
 */

import type { Session } from '../../connect/session.js';
import type { Era, Transport } from '../catalog.js';
import type { CheckOutcome } from '../outcome.js';

export interface ConformanceContext {
  session: Session;
  transport: Transport;
  era: Era;
  /** The revision the run is for: `--protocol-version`, or the one the server answered with. */
  protocolVersion: string | null;
}

export type ConformanceCheck = (ctx: ConformanceContext) => Promise<CheckOutcome>;

/** Catalogued, no implementation yet: `pending`, outside the score whatever the profile says. */
const notYet: ConformanceCheck = async () => ({ state: 'pending' });

// Every catalogued check is `notYet` for now; a check module replaces its entry with the real function.
export const IMPLEMENTATIONS: Readonly<Record<string, ConformanceCheck>> = {
  'life-initialize-result': notYet,
  'life-version-negotiation': notYet,
  'life-capabilities-declared-served': notYet,
  'life-capabilities-served-declared': notYet,
  'life-ping-empty-result': notYet,
  'base-jsonrpc-parse-error': notYet,
  'base-unknown-method-error': notYet,
  'base-response-id-matches': notYet,
  'base-invalid-params-error': notYet,
  'tools-list-shape': notYet,
  'tools-input-schema-valid': notYet,
  'tools-output-schema-valid': notYet,
  'tools-structured-conformant': notYet,
  'tools-structured-has-text': notYet,
  'tools-name-format': notYet,
  'tools-name-unique': notYet,
  'tools-call-unknown-error': notYet,
  'tools-list-order-stable': notYet,
  'resources-list-shape': notYet,
  'resources-read-listed': notYet,
  'resources-read-not-found': notYet,
  'resources-templates-shape': notYet,
  'prompts-list-shape': notYet,
  'prompts-get-unknown-error': notYet,
  'pagination-walk-complete': notYet,
  'pagination-invalid-cursor': notYet,
  'logging-set-level': notYet,
  'completion-complete': notYet,
  'stdio-stdout-clean': notYet,
  'stdio-exit-on-eof': notYet,
};
