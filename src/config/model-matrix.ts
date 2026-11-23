import type { Config } from '../types/config.js';

/**
 * Advice for a config that lists several models: an `llm-judge` check whose `provider` names no model takes the
 * model of the cell (the fields it leaves out come from the cell's provider), so each model grades its own answer,
 * which favours it. One line per eval; never an error.
 */
export function selfJudgeWarnings(config: Config): string[] {
  if ((config.providers?.length ?? 0) < 2) return [];
  const follows = (a: Config['evals'][number]['assertions'][number]): boolean =>
    a.type === 'llm-judge' && a.provider?.model === undefined;
  const inherited = (config.defaults?.assertions ?? []).some(follows);
  return config.evals
    .filter((ev) => inherited || ev.assertions.some(follows))
    .map(
      (ev) =>
        `eval "${ev.id}" has an llm-judge check whose provider names no model: with several models each model judges its own answer, which favours it. Set provider.model on the check to name one judge for all`,
    );
}
