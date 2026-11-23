import type { Config } from '../types/config.js';

/**
 * Advice for a config that lists several models: an `llm-judge` check whose `provider` names no model takes the
 * model of the cell (the fields it leaves out come from the cell's provider), so each model grades its own answer,
 * which favours it. One line per eval; never an error.
 */
export function selfJudgeWarnings(config: Config): string[] {
  if ((config.providers?.length ?? 0) < 2) return [];
  type Check = Config['evals'][number]['assertions'][number];
  const follows = (a: Check): boolean => a.type === 'llm-judge' && a.provider?.model === undefined;
  // A judge that names a model but no type takes the type of each cell, so with models of several types the
  // same model id goes to providers that do not serve it.
  const mixed = new Set(config.providers!.map((p) => p.type)).size > 1;
  const typeless = (a: Check): boolean =>
    mixed && a.type === 'llm-judge' && a.provider?.model !== undefined && a.provider.type === undefined;
  const any = (pred: (a: Check) => boolean) => (ev: Config['evals'][number]) =>
    (config.defaults?.assertions ?? []).some(pred) || ev.assertions.some(pred);
  return config.evals.flatMap((ev) => [
    ...(any(follows)(ev)
      ? [
          `eval "${ev.id}" has an llm-judge check whose provider names no model: with several models each model judges its own answer, which favours it. Set provider.type and provider.model on the check to name one judge for all`,
        ]
      : []),
    ...(any(typeless)(ev)
      ? [
          `eval "${ev.id}" has an llm-judge check whose provider names a model but no type: the models of this run are of several types, so each cell sends that model to its own provider. Set provider.type on the check too`,
        ]
      : []),
  ]);
}
