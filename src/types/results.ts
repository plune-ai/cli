export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  cost_usd: number;
  duration_ms: number;
}

export interface AssertionResultRecord {
  type: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RunError {
  code: string;
  message: string;
}

export interface RowResult {
  vars: Record<string, unknown>;
  output: string | null;
  cached: boolean;
  usage?: Usage;
  latency_ms?: number;
  error?: RunError;
  assertions: AssertionResultRecord[];
}

export interface EvalResult {
  id: string;
  tags: string[];
  rows: RowResult[];
  passed: boolean;
}

export interface RunResult {
  schemaVersion: 1;
  plune_version: string;
  started_at: string;
  finished_at: string;
  config_hash: string;
  summary: Summary;
  evals: EvalResult[];
}
