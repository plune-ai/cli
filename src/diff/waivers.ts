// The waivers file of `plune diff --waivers` (MCP-D5): a YAML file in the user's repository, changed through
// review like any other file. Pure: the caller reads the file and passes the clock.
//
//     waivers:
//       - gate: regression          # regression | pass-rate | cost | tokens
//         eval: checkout-flow       # required for regression, not allowed for the others
//         reason: "Upstream outage, fix in #123"
//         granted: "2026-11-13"
//         expires: "2026-11-30"     # at most 30 days after granted; holds to the end of that day, UTC

import { parse } from 'yaml';

export const WAIVER_GATES = ['regression', 'pass-rate', 'cost', 'tokens'] as const;
export type WaiverGate = (typeof WAIVER_GATES)[number];

/** Long enough for a sentence and a link, short enough for one line of a PR comment. */
export const MAX_WAIVER_REASON = 200;
export const MAX_WAIVER_DAYS = 30;

export interface Waiver {
  gate: WaiverGate;
  eval?: string;
  reason: string;
  granted: string;
  expires: string;
}

/** A waivers file that cannot be read as one: an input error (exit 2), every problem named by its entry. */
export class WaiversFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaiversFileError';
  }
}

const DAY_MS = 86_400_000;
const KEYS = new Set(['gate', 'eval', 'reason', 'granted', 'expires']);
const dayStart = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const isDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayStart(s)) && new Date(dayStart(s)).toISOString().startsWith(s);

/** Whether `now` is past the end of the waiver's expiry day (UTC). */
export function isExpired(w: Waiver, now: Date): boolean {
  return now.getTime() >= dayStart(w.expires) + DAY_MS;
}

function text(entry: Record<string, unknown>, key: string): string | undefined {
  const v = entry[key];
  return typeof v === 'string' ? v : undefined;
}

function checkEntry(entry: Record<string, unknown>, now: Date): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(entry)) if (!KEYS.has(key)) problems.push(`unknown key "${key}"`);
  const gate = text(entry, 'gate');
  if (gate === undefined || !(WAIVER_GATES as readonly string[]).includes(gate))
    problems.push(`gate must be one of ${WAIVER_GATES.join(', ')}`);
  const ev = text(entry, 'eval');
  if (gate === 'regression' && (ev === undefined || ev.trim() === ''))
    problems.push('eval is required for gate regression');
  if (gate !== 'regression' && entry['eval'] !== undefined) problems.push('eval applies to gate regression only');
  const reason = text(entry, 'reason');
  if (reason === undefined || reason.trim() === '') problems.push('reason is required');
  else if (reason.length > MAX_WAIVER_REASON)
    problems.push(`reason is longer than ${MAX_WAIVER_REASON} characters`);
  const dates: Record<string, string | undefined> = {};
  for (const key of ['granted', 'expires'] as const) {
    const v = text(entry, key);
    if (entry[key] === undefined || entry[key] === null) problems.push(`${key} is required`);
    else if (v === undefined || !isDate(v)) problems.push(`${key} must be a date, YYYY-MM-DD`);
    else dates[key] = v;
  }
  const { granted, expires } = dates;
  if (granted !== undefined && expires !== undefined) {
    if (dayStart(expires) <= dayStart(granted)) problems.push('expires must be after granted');
    else if (dayStart(expires) - dayStart(granted) > MAX_WAIVER_DAYS * DAY_MS)
      problems.push(`expires must be at most ${MAX_WAIVER_DAYS} days after granted`);
  }
  // A future grant date would push the 30-day window out as far as anyone likes. A day of slack for time zones.
  if (granted !== undefined && dayStart(granted) > now.getTime() + DAY_MS)
    problems.push('granted is in the future');
  return problems;
}

/** Every waiver of the file, expired ones included (the report lists them); a malformed file throws. */
export function parseWaivers(source: string, now: Date): Waiver[] {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    throw new WaiversFileError(`waivers file is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  const list = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>)['waivers'] : undefined;
  if (!Array.isArray(list)) throw new WaiversFileError('waivers file: expected "waivers:" with a list of entries');
  const problems: string[] = [];
  list.forEach((entry: unknown, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`waivers[${i}]: an entry needs gate, reason, granted and expires`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const label = `waivers[${i}]${typeof e['eval'] === 'string' ? ` (eval ${e['eval']})` : ''}`;
    for (const p of checkEntry(e, now)) problems.push(`${label}: ${p}`);
  });
  if (problems.length > 0) throw new WaiversFileError(problems.join('\n'));
  return (list as Record<string, string>[]).map((e) => ({
    gate: e['gate'] as WaiverGate,
    ...(e['eval'] !== undefined ? { eval: e['eval'] } : {}),
    reason: e['reason']!,
    granted: e['granted']!,
    expires: e['expires']!,
  }));
}
