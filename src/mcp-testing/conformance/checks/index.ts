/**
 * The registry of check implementations, by catalog id. A test holds it and the catalog to the same set of ids, so
 * neither gains an id the other lacks. An implementation takes its title and description from the catalog, never a
 * copy of its own. The modules are by group; each check is one function of the context, sending what it needs over
 * the session's raw layer (wire.ts).
 */

import type { Session } from '../../connect/session.js';
import type { Era, Transport } from '../catalog.js';
import type { CheckOutcome } from '../outcome.js';
import { BASE } from './base.js';
import { LIFECYCLE } from './lifecycle.js';
import { PAGINATION } from './pagination.js';
import { PROMPTS } from './prompts.js';
import { RESOURCES } from './resources.js';
import { STDIO } from './stdio.js';
import { TOOLS } from './tools.js';

/** One call of `--fixture`: a tool the user named as safe to call, and its arguments. */
export interface FixtureCall {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ConformanceContext {
  session: Session;
  transport: Transport;
  era: Era;
  /** The revision the run is for: `--protocol-version`, or the one the server answered with. */
  protocolVersion: string | null;
  /** The calls of `--fixture`; undefined without it, and then no tool is called. */
  fixture?: readonly FixtureCall[];
  /** One value per key for the whole run: a list is walked once for every check that reads it. */
  memo<T>(key: string, make: () => Promise<T>): Promise<T>;
}

export type ConformanceCheck = (ctx: ConformanceContext) => Promise<CheckOutcome>;

export const IMPLEMENTATIONS: Readonly<Record<string, ConformanceCheck>> = {
  ...LIFECYCLE,
  ...BASE,
  ...TOOLS,
  ...RESOURCES,
  ...PROMPTS,
  ...PAGINATION,
  ...STDIO,
};
