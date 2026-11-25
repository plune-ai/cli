// The experimental Jev judge of an `llm-judge` check: `provider: { type: jev, model: jev-1.14.0 }`.
// Jev (TypeSafe) is a decision model, not a text model: it is sent a state and one yes-or-no question and answers
// with a probability of "yes" and no explanation. So it is not a Provider and cannot be an eval's model; the
// orchestrator builds this judge for the check alone. One request per check, to one fixed address.

import type { JevJudgeConfig } from '../types/config.js';
import type { DecisionQuestion, Judge } from '../types/judge.js';
import { AuthError, ProviderError } from '../providers/errors.js';

export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';
/** The longest state Jev takes, in characters. A longer one is refused here, before anything is sent, and never cut. */
export const JEV_MAX_STATE_CHARS = 16_000;
/** USD per million input tokens; Jev's output is not billed. Indicative, read on 2026-11-24. */
export const JEV_USD_PER_1M_INPUT_TOKENS = 0.042;
const DEFAULT_TIMEOUT_MS = 30_000;

const INSTRUCTIONS = 'Does the answer meet the criterion?';
const YES = 'the answer meets the criterion';
const NO = 'the answer does not meet the criterion';

/** What Jev is shown. The request is left out when the check has none, as for the text judge. */
export function jevState(q: DecisionQuestion): string {
  const request = q.input === undefined ? '' : `Request:\n${q.input}\n\n`;
  return `${request}Answer:\n${q.output}\n\nCriterion:\n${q.criteria}`;
}

export interface JevJudgeDeps {
  env: NodeJS.ProcessEnv;
  fetchFn: typeof fetch;
  /** Called once per answered request with what it cost, so the row is charged for its own judge calls. */
  onCost: (usd: number) => void;
}

function probability(json: unknown): number {
  const answer = (json as { answers?: { q?: { type?: unknown; noul?: unknown } } } | null)?.answers?.q;
  const p = answer?.type === 'noul' ? answer.noul : undefined;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
    throw new ProviderError('JEV_ANSWER', 'jev returned no probability for the question asked');
  return p;
}

export function makeJevJudge(cfg: JevJudgeConfig, deps: JevJudgeDeps): Judge {
  return {
    ask: () =>
      Promise.reject(new Error('a jev judge answers a yes-or-no question only: it cannot judge this kind of check')),
    async decide(q: DecisionQuestion): Promise<number> {
      const key = deps.env[JEV_KEY_ENV];
      if (key === undefined || key === '')
        throw new AuthError(`${JEV_KEY_ENV} is not set: the jev judge of an llm-judge check needs it`, JEV_KEY_ENV);
      const state = jevState(q);
      if (state.length > JEV_MAX_STATE_CHARS)
        throw new ProviderError(
          'JEV_INPUT_TOO_LONG',
          `the request, answer and criterion are ${state.length} characters together; a jev judge takes ${JEV_MAX_STATE_CHARS}. Nothing was sent`,
        );
      const body = JSON.stringify({
        state,
        model: cfg.model,
        questions: { q: { type: 'noul', instructions: INSTRUCTIONS, criteria: { true: YES, false: NO } } },
      });
      const send = async (): Promise<Response> => {
        try {
          return await deps.fetchFn(`${JEV_BASE_URL}/v1/systemone`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(cfg.timeout ?? DEFAULT_TIMEOUT_MS),
          });
        } catch (err) {
          throw new ProviderError('JEV_UNREACHABLE', `jev did not answer: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      // One retry on 429 and 5xx, and no more: a judge that is down errors the row, it does not hold the run.
      let res = await send();
      if (res.status === 429 || res.status >= 500) res = await send();
      if (res.status === 401 || res.status === 403)
        throw new AuthError(`jev refused the key in ${JEV_KEY_ENV} (HTTP ${res.status})`, JEV_KEY_ENV);
      if (!res.ok) throw new ProviderError('JEV_HTTP', `jev answered HTTP ${res.status}`);
      const json: unknown = await res.json();
      const p = probability(json);
      const tokens = (json as { usage?: { input_tokens?: unknown } }).usage?.input_tokens;
      // No usage in the answer: three characters a token, an upper estimate for English text.
      const billed = typeof tokens === 'number' && tokens >= 0 ? tokens : Math.ceil(state.length / 3);
      deps.onCost((billed / 1_000_000) * JEV_USD_PER_1M_INPUT_TOKENS);
      return p;
    },
  };
}

let warned = false;
/** Said once per process, on the first check a jev judge is built for. */
export function warnJevExperimental(write: (line: string) => void = (l) => process.stderr.write(l)): void {
  if (warned) return;
  warned = true;
  write(
    'warning: the jev judge is experimental. It gives a probability and no reason, sends the request, answer and ' +
      `criterion to ${new URL(JEV_BASE_URL).host}, and was measured on answers with a clear right or wrong only. ` +
      'See docs/guide/assertions.md#an-experimental-judge-jev\n',
  );
}
/** Test seam: lets a test see the warning again. */
export function resetJevWarning(): void {
  warned = false;
}
