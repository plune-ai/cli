import { describe, it, expect } from 'vitest';
import { readEnv, UNSUPPORTED_VARS } from '../env.js';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

describe('what a CI job can set', () => {
  it('reads the shared run key', () => {
    expect(readEnv(env({ PLUNE_RUN: 'gh-1234-1' })).config.externalKey).toBe('gh-1234-1');
  });

  it('reads a token, so a CI job need not run plune login', () => {
    expect(readEnv(env({ PLUNE_TOKEN: 'tok' })).config.token).toBe('tok');
  });

  it('reads the batch size and the fallback path', () => {
    const { config } = readEnv(env({ PLUNE_BATCH_SIZE: '250', PLUNE_FALLBACK: '/tmp/p.jsonl' }));

    expect(config.batchSize).toBe(250);
    expect(config.fallbackPath).toBe('/tmp/p.jsonl');
  });

  it('reads the api url, the same name the rest of the CLI uses', () => {
    expect(readEnv(env({ PLUNE_API_URL: 'https://x.test' })).config.apiUrl).toBe('https://x.test');
  });

  // An empty variable is what a CI template leaves behind when the value was not provided. Treating
  // it as a setting would send an empty external key, which the platform rejects for a reason: every
  // keyless run would collide on one entry of its unique index.
  it('treats an empty variable as unset', () => {
    expect(readEnv(env({ PLUNE_RUN: '', PLUNE_TOKEN: '   ' })).config).toEqual({});
  });

  it('ignores a batch size that is not a count', () => {
    expect(readEnv(env({ PLUNE_BATCH_SIZE: 'lots' })).config.batchSize).toBeUndefined();
    expect(readEnv(env({ PLUNE_BATCH_SIZE: '0' })).config.batchSize).toBeUndefined();
  });
});

describe('who closes the run', () => {
  it('keeps it open when the job says several processes share it', () => {
    expect(readEnv(env({ PLUNE_SHARED_RUN: '1' })).keepOpen).toBe(true);
  });

  it('keeps it open when the job says it will close it itself', () => {
    expect(readEnv(env({ PLUNE_PROCEED: '1' })).keepOpen).toBe(true);
  });

  it('closes it when nobody said otherwise', () => {
    expect(readEnv(env({ PLUNE_RUN: 'x' })).keepOpen).toBe(false);
  });

  it('reads a flag by its value, not by its presence', () => {
    expect(readEnv(env({ PLUNE_PROCEED: '0' })).keepOpen).toBe(false);
    expect(readEnv(env({ PLUNE_PROCEED: 'false' })).keepOpen).toBe(false);
    expect(readEnv(env({ PLUNE_PROCEED: 'true' })).keepOpen).toBe(true);
  });
});

describe('the variables that have nowhere to go yet', () => {
  // The failure this prevents is the expensive one: a client that believes it stored something the
  // server silently dropped. `runMetaSchema` strips unknown keys, so sending `PLUNE_ENV` there would
  // look exactly like success. Saying so is the only honest option until the run grows the fields.
  it('names each one it was given rather than dropping it quietly', () => {
    const { ignored } = readEnv(env({ PLUNE_ENV: 'staging', PLUNE_LABELS: 'smoke,slow' }));

    expect(ignored.sort()).toEqual(['PLUNE_ENV', 'PLUNE_LABELS']);
  });

  it('says nothing when none of them are set', () => {
    expect(readEnv(env({ PLUNE_RUN: 'x' })).ignored).toEqual([]);
  });

  it('knows about every name the reporter promises but cannot honour', () => {
    expect([...UNSUPPORTED_VARS].sort()).toEqual([
      'PLUNE_ENV',
      'PLUNE_GROUP',
      'PLUNE_LABELS',
      'PLUNE_RUN_TITLE',
    ]);
  });
});
