import { createHash } from 'node:crypto';
import type { Config } from '../types/config.js';
import { canonicalJson } from './canonical-json.js';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface CacheKeyInputs {
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
  prompt_resolved: string;
}

/**
 * Raise when the way a prompt is resolved, variables are normalised or a default that reaches the
 * request text changes. The version is part of every key, so older entries stop answering with no
 * manual clearing (plune-ai/plune#1696). It is a constant, never a time or a run id.
 */
export const CACHE_POLICY_VERSION = 1;

export function cacheKey(inputs: CacheKeyInputs, policyVersion: number = CACHE_POLICY_VERSION): string {
  // Hash ONLY the five documented identity inputs (ADR-TC04) plus the policy version. Picking the named fields —
  // rather than serializing `inputs` wholesale — guarantees that anything else a caller
  // may carry on the object (e.g. attached assertions) is excluded from the identity (AC-05).
  const { provider, model, temperature, max_tokens, prompt_resolved } = inputs;
  return sha256(
    canonicalJson({ provider, model, temperature, max_tokens, prompt_resolved, policy: policyVersion }),
  );
}

export function configHash(config: Config): string {
  return sha256(canonicalJson(config));
}
