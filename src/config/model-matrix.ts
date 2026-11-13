import type { Config } from '../types/config.js';

/**
 * Advice for a config that lists several models: an `llm-judge` check with no `provider` of its own is judged by the
 * model of the cell, so each model grades its own answer, which favours it. One line per eval; never an error.
 */
export function selfJudgeWarnings(config: Config): string[] {
  if ((config.providers?.length ?? 0) < 2) return [];
  const inherited = (config.defaults?.assertions ?? []).some((a) => a.type === 'llm-judge' && a.provider === undefined);
  return config.evals
    .filter((ev) => inherited || ev.assertions.some((a) => a.type === 'llm-judge' && a.provider === undefined))
    .map(
      (ev) =>
        `eval "${ev.id}" has an llm-judge check without a provider: with several models each model judges its own answer, which favours it. Set provider on the check to name one judge for all`,
    );
}
