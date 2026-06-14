// Public surface of the orchestrator.

export { runOrchestration, runRow, resolvePrompt, RunConfigError } from './run.js';
export type { RunOptions, RunDeps, RowParams } from './run.js';
export { exitCodeFor } from './exit-code.js';
export { loadDataset } from './dataset.js';
export { mapLimit } from './concurrency.js';
export { buildJudge } from './judge.js';
