// Reading a Cairn run directory into the payload `plune ingest` uploads (Plune #10 / #86, ADR-CI-01).
//
// The direction of this dependency is the whole point: Plune reads Cairn's output, Cairn knows nothing
// about Plune. So this file parses Cairn's PUBLISHED artifact rather than importing its package — that
// package exports no parser, and it would drag Playwright and provider SDKs in to read a JSON file.
//
// What we depend on is the artifact's `schemaVersion`, and only that. An unknown version is refused by
// name (Plune FR-1): a shape we do not know, parsed anyway, writes plausible-looking wrong data, and
// that surfaces weeks later looking like corruption rather than like a bad assumption.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The artifact format this reader understands. Cairn stamps it from 0.7.0 onward. */
const SUPPORTED_ARTIFACT_VERSION = 1;

/** The payload version the Plune ingest endpoint validates — ours, not Cairn's. */
const INGEST_SCHEMA_VERSION = 1;

export type CairnRunMode = 'explore' | 'design' | 'api';
export type CairnExecution = 'auto' | 'manual';
export type CairnVerdict = 'passed' | 'failed';

export interface CairnIngestCase {
  stableId: string;
  title: string;
  execution: CairnExecution;
  steps: string[];
  expected: string;
  /** Absent means the run never executed this case — NOT "no result yet". */
  verdict?: CairnVerdict;
  technique?: string;
  priority?: string;
}

export interface CairnIngestPayload {
  schemaVersion: typeof INGEST_SCHEMA_VERSION;
  run: { runId: string; mode: CairnRunMode; target: string };
  cases: CairnIngestCase[];
}

/** The directory holds no `report.json` — usually a mistyped path. (exit 2) */
export class CairnRunNotFoundError extends Error {
  constructor(dir: string) {
    super(`No Cairn run found in ${dir} — expected a report.json written by "cairn design|explore|api".`);
    this.name = 'CairnRunNotFoundError';
  }
}

/** The artifact's format is one this CLI does not understand. (exit 2) */
export class CairnRunVersionError extends Error {
  constructor(found: unknown) {
    super(
      found === undefined
        ? 'This run predates versioned Cairn artifacts. Re-run it with Cairn 0.7.0 or newer, which stamps the format so it can be read safely.'
        : `Unsupported Cairn artifact version ${String(found)} (this CLI reads version ${SUPPORTED_ARTIFACT_VERSION}). Upgrade @plune-ai/cli.`,
    );
    this.name = 'CairnRunVersionError';
  }
}

/** The run failed partway; its artifact is a fragment. (exit 2) */
export class CairnRunPartialError extends Error {
  constructor(reason: string) {
    super(`That Cairn run did not finish, so its cases are incomplete: ${reason}`);
    this.name = 'CairnRunPartialError';
  }
}

/** Evidence cannot be joined to cases unambiguously. (exit 2) */
export class CairnEvidenceAmbiguousError extends Error {
  constructor(name: string) {
    super(
      `Cannot attach results safely: the operation "${name}" appears more than once in this run's evidence, ` +
        'and the evidence file carries no case identity to disambiguate it. Nothing was uploaded.',
    );
    this.name = 'CairnEvidenceAmbiguousError';
  }
}

interface EvidenceRecord {
  name: string;
  passed: boolean;
}

export interface ReadCairnRunDeps {
  /** Injected for tests; returns `undefined` when the run executed nothing and wrote no evidence. */
  readEvidence?: (dir: string) => Promise<EvidenceRecord[] | undefined>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v !== '' ? v : fallback);

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function defaultReadEvidence(dir: string): Promise<EvidenceRecord[] | undefined> {
  const raw = await readJson(path.join(dir, 'api-evidence.json'));
  if (!Array.isArray(raw)) return undefined;
  return raw.map((r) => {
    const rec = asRecord(r);
    return { name: str(rec['name']), passed: rec['passed'] === true };
  });
}

/**
 * Cases a page-exploring run designed. Both `design` and `explore` write them under the same key with
 * the same fields; only `explore`'s validation report differs, and it is not mapped here — an
 * explored case arrives without a verdict rather than with a guessed one.
 */
function casesFromDesign(report: Record<string, unknown>): CairnIngestCase[] {
  const list = Array.isArray(report['testCases']) ? report['testCases'] : [];
  return list.map((raw) => {
    const c = asRecord(raw);
    const steps = (Array.isArray(c['steps']) ? c['steps'] : []).map((s) => str(s)).filter((s) => s !== '');
    return {
      stableId: str(c['stableId']),
      title: str(c['title'], 'untitled case'),
      execution: c['execution'] === 'manual' ? ('manual' as const) : ('auto' as const),
      steps: steps.length > 0 ? steps : ['(no steps recorded)'],
      expected: str(c['expected'], '(no expected result recorded)'),
      ...(typeof c['technique'] === 'string' ? { technique: c['technique'] } : {}),
      ...(typeof c['priority'] === 'string' ? { priority: c['priority'] } : {}),
    };
  });
}

/**
 * Cases an API run generated. Cairn describes these as a request plus the status it expects, so they
 * are restated in the vocabulary the rest of the system uses — the request becomes the step, the
 * declared status becomes the expectation. That is a translation of what the case already says, not an
 * invention of detail it does not carry.
 */
function casesFromApi(report: Record<string, unknown>, verdicts: Map<string, CairnVerdict>): CairnIngestCase[] {
  const list = Array.isArray(report['cases']) ? report['cases'] : [];
  return list.map((raw) => {
    const c = asRecord(raw);
    const name = str(c['name'], 'unnamed operation');
    const request = `${str(c['method'], 'GET')} ${str(c['path'], '/')}`;
    const verdict = verdicts.get(name);
    return {
      stableId: str(c['stableId']),
      title: name,
      execution: 'auto' as const,
      steps: [request],
      expected: `HTTP ${str(c['expectedStatus'], 'default')}`,
      ...(verdict !== undefined ? { verdict } : {}),
      ...(typeof c['technique'] === 'string' ? { technique: c['technique'] } : {}),
    };
  });
}

/**
 * Read a Cairn run directory into an upload payload, or throw a typed error explaining why not.
 *
 * Pure apart from the two file reads, which are injectable, so the mapping rules can be exercised
 * against real artifacts without a filesystem dance.
 */
export async function readCairnRun(dir: string, deps: ReadCairnRunDeps = {}): Promise<CairnIngestPayload> {
  const raw = await readJson(path.join(dir, 'report.json'));
  if (raw === undefined) throw new CairnRunNotFoundError(dir);

  const report = asRecord(raw);
  if (report['schemaVersion'] !== SUPPORTED_ARTIFACT_VERSION) {
    throw new CairnRunVersionError(report['schemaVersion']);
  }
  if (report['partial'] === true) {
    throw new CairnRunPartialError(str(report['error'], 'no reason recorded'));
  }

  const mode = report['mode'];
  if (mode !== 'design' && mode !== 'explore' && mode !== 'api') {
    // Every artifact states its kind from 0.7.0 on, so reaching here means a kind newer than this
    // reader. Inferring it from which keys happen to be present is exactly the guess FR-1a forbids.
    throw new CairnRunVersionError(`${SUPPORTED_ARTIFACT_VERSION} (unknown run mode ${String(mode)})`);
  }

  let cases: CairnIngestCase[];
  if (mode === 'api') {
    const evidence = await (deps.readEvidence ?? defaultReadEvidence)(dir);
    const verdicts = new Map<string, CairnVerdict>();
    for (const e of evidence ?? []) {
      if (verdicts.has(e.name)) throw new CairnEvidenceAmbiguousError(e.name);
      verdicts.set(e.name, e.passed ? 'passed' : 'failed');
    }
    cases = casesFromApi(report, verdicts);
  } else {
    cases = casesFromDesign(report);
  }

  return {
    schemaVersion: INGEST_SCHEMA_VERSION,
    run: {
      runId: str(report['runId'], path.basename(dir)),
      mode,
      target: str(report['url'], 'unknown'),
    },
    cases,
  };
}
