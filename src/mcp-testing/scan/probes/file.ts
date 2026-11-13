import { UsageError } from '../../connect/options.js';
import { PROBE_AS, type ProbeAs, type ProbeEntry, type ProbeExpect } from './types.js';

/**
 * The probe file (`--probes`): JSON, `{ "probes": [ ... ] }`, each entry
 *
 *     { "id": "p1", "tool": "export", "arguments": { "doc": "doc-1" }, "as": "none", "expect": "refuse" }
 *
 * Read strictly: a key that is not listed, a repeated id, an `as` or an `expect` that is not one of the words, a file
 * over the size limit are all a usage error. A probe file is the whole list of calls a scan may make.
 */
export const MAX_PROBE_FILE_BYTES = 256 * 1024;
export const MAX_PROBES = 64;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const KEYS = new Set([
  'id',
  'tool',
  'arguments',
  'as',
  'expect',
  'allowDestructive',
  'malformed',
  'fetches',
  'urlArgument',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseProbeFile(text: string, name: string): ProbeEntry[] {
  const bad = (message: string): never => {
    throw new UsageError(`--probes ${name}: ${message}`);
  };
  if (Buffer.byteLength(text, 'utf8') > MAX_PROBE_FILE_BYTES)
    bad(`the file is over ${MAX_PROBE_FILE_BYTES / 1024} KiB.`);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return bad('not JSON.');
  }
  if (
    !isRecord(root) ||
    Object.keys(root).some((k) => k !== 'probes') ||
    !Array.isArray(root['probes'])
  )
    return bad('expected { "probes": [ ... ] } and nothing else.');
  const list = root['probes'] as unknown[];
  if (list.length === 0) bad('the file declares nothing: add at least one probe.');
  if (list.length > MAX_PROBES) bad(`more than ${MAX_PROBES} probes.`);
  const seen = new Set<string>();
  const entries: ProbeEntry[] = [];
  list.forEach((raw, i) => {
    const at = `probe ${i + 1}`;
    if (!isRecord(raw)) return bad(`${at} is not an object.`);
    for (const key of Object.keys(raw))
      if (!KEYS.has(key)) bad(`${at}: "${key.slice(0, 40)}" is not a key of a probe.`);
    const id = raw['id'];
    if (typeof id !== 'string' || !ID.test(id))
      return bad(`${at}: id must be 1-64 letters, digits, ".", "_" or "-".`);
    if (seen.has(id)) return bad(`${at}: the id "${id}" is used twice.`);
    seen.add(id);
    const tool = raw['tool'];
    if (typeof tool !== 'string' || tool === '' || tool.length > 128)
      return bad(`${at} (${id}): tool must be a name.`);
    const args = raw['arguments'] ?? {};
    if (!isRecord(args)) return bad(`${at} (${id}): arguments must be an object.`);
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES)
      return bad(`${at} (${id}): arguments are over ${MAX_ARGUMENT_BYTES / 1024} KiB.`);
    const as = raw['as'];
    if (typeof as !== 'string' || !(PROBE_AS as readonly string[]).includes(as))
      return bad(`${at} (${id}): as must be one of ${PROBE_AS.join(', ')}.`);
    const expect = raw['expect'];
    if (expect !== undefined && expect !== 'refuse' && expect !== 'allow')
      return bad(`${at} (${id}): expect must be "refuse" or "allow", or left out.`);
    const destructive = raw['allowDestructive'];
    if (destructive !== undefined && typeof destructive !== 'boolean')
      return bad(`${at} (${id}): allowDestructive must be true or false.`);
    const malformed = raw['malformed'];
    if (malformed !== undefined && typeof malformed !== 'boolean')
      return bad(`${at} (${id}): malformed must be true or false.`);
    if (malformed === true && (as !== 'account-a' || expect !== undefined))
      return bad(
        `${at} (${id}): a malformed probe is sent as account-a and takes no expect; its arguments are derived from the tool, not read from the file.`,
      );
    const fetches = raw['fetches'];
    if (fetches !== undefined && typeof fetches !== 'boolean')
      return bad(`${at} (${id}): fetches must be true or false.`);
    const urlArgument = raw['urlArgument'];
    if (fetches === true) {
      if (typeof urlArgument !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(urlArgument))
        return bad(
          `${at} (${id}): a fetches probe names the argument that takes the address: urlArgument.`,
        );
      if (as !== 'account-a' || expect !== undefined || malformed === true)
        return bad(
          `${at} (${id}): a fetches probe is sent as account-a, takes no expect and is not malformed.`,
        );
    } else if (urlArgument !== undefined)
      return bad(`${at} (${id}): urlArgument is for a probe with fetches: true.`);
    entries.push({
      id,
      tool,
      arguments: args,
      as: as as ProbeAs,
      ...(expect === undefined ? {} : { expect: expect as ProbeExpect }),
      ...(destructive === true ? { allowDestructive: true } : {}),
      ...(malformed === true ? { malformed: true } : {}),
      ...(fetches === true ? { fetches: true, urlArgument: urlArgument as string } : {}),
    });
  });
  return entries;
}
