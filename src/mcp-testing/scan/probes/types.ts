/**
 * What the active probes of `plune mcp scan --active` are, in plain types: the entries of the probe file a person
 * wrote, and the rows the report shows. Nothing here holds a credential, a response body or an argument value.
 */

export const PROBE_AS = ['none', 'garbage', 'account-a', 'account-b', 'wrong-audience'] as const;
export type ProbeAs = (typeof PROBE_AS)[number];
export type ProbeExpect = 'refuse' | 'allow';

/** One call a person declared: the only kind of `tools/call` a probe may send. */
export interface ProbeEntry {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  as: ProbeAs;
  expect?: ProbeExpect;
  /** The tool says `destructiveHint: true` and the person still wants it called. */
  allowDestructive?: boolean;
  /**
   * Send the tool a call with deliberately wrong arguments, derived from its inputSchema in a fixed way, as account-a,
   * and search the answer for fixed patterns (`scan/probe/error-detail-leak`). The `arguments` of the entry are not sent.
   */
  malformed?: boolean;
  /**
   * The tool returns data from outside: it is called with a page the scan serves on this machine, in the argument named
   * `urlArgument`, and the answer is looked at for the marker of the page (`scan/probe/untrusted-content-verbatim`).
   */
  fetches?: boolean;
  urlArgument?: string;
}

/** Why a probe did not run. Each code has its own sentence; a probe that did not run is never a pass. */
export const PROBE_REASONS = {
  'no-consent':
    'no consent: the target is not on this machine and --confirm-host did not name its host',
  'no-probe-file': 'no probe file was given (--probes <file>)',
  'no-target': 'no live server to probe: give --url (or a command after --)',
  'no-account-b': 'no token for account B (--other-token-env)',
  'no-credential': 'no token for account A (--token-env)',
  stdio: 'not applicable (stdio): the authentication probes are for a server at --url',
  budget: 'the budget of calls or requests (--max-calls, --max-requests) was spent',
  'transport-stopped': 'the probes were stopped after two transport failures in a row',
  'tool-missing': 'the server does not list this tool',
  destructive: 'the server marks this tool destructive and the probe does not set allowDestructive',
  'no-control':
    'no control: the file has no account-a probe with expect: allow for the same tool and arguments that ran and was allowed',
  inconclusive:
    'the server did not answer in a way that decides it (timeout, 429, 5xx, redirect or another status)',
  'no-yes':
    'a stdio server is started by a probe only with --yes: the command it would start is printed above',
  'remote-server':
    'the server is not on this machine, so it cannot fetch the page this scan serves on this machine only',
  'start-failed': 'the server process could not be started',
  'journal-failed':
    'the journal (--journal) could not be written: the probes were stopped, so that no frame is sent unrecorded',
  'schema-too-large':
    'the inputSchema of the tool is too large to derive a malformed call from (over 256 names, or over 16 KiB of arguments)',
  'no-schema':
    'the tool declares no inputSchema property to break, so no malformed call can be derived',
  'wrong-audience':
    'a token for another resource is checked by the oauth suite of plune mcp conformance, not by this scan',
} as const;
export type ProbeReason = keyof typeof PROBE_REASONS;

/** One line of the summary table. */
export interface ProbeRow {
  id: string;
  tool: string;
  as: ProbeAs | '';
  expect: ProbeExpect | 'none';
  /** What the server did, when it decided: ran the call, or refused it. */
  answer: 'allowed' | 'refused' | null;
  outcome: 'as-expected' | 'violated' | 'observed' | 'not-run';
  reason?: ProbeReason;
  /** A note on a probe that did not run, fixed text. */
  note?: string;
  /** The step at which HTTP 401 or 403 refused the probe's own request, when that is what refused it. */
  refusedAt?: string;
  /** For a probe with expect: refuse that was answered: the id of the control that ran, or null (HTTP 401 or 403 stands alone). */
  control?: string | null;
}
