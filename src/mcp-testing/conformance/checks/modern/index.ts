/**
 * The checks of the 2026-07-28 revision (the modern era): per transport (core), the HTTP request headers, the
 * subscriptions, and the whole run read back (observed). Their ids start with `mod-`; a legacy run is not-applicable
 * (era) for each of them by the catalog.
 */

import type { ConformanceCheck } from '../index.js';
import { CORE } from './core.js';
import { HEADERS } from './headers.js';
import { OBSERVED } from './observed.js';
import { SUBSCRIPTIONS } from './subscriptions.js';

export const MODERN: Record<string, ConformanceCheck> = { ...CORE, ...HEADERS, ...SUBSCRIPTIONS, ...OBSERVED };
