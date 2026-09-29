import { describe, it, expect } from 'vitest';
import { ciCommit, defaultRunTitle, readEnv, UNSUPPORTED_VARS } from '../env.js';

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

describe('what the run is called, where it ran, how it is marked', () => {
  it('takes all three from the environment', () => {
    const { config } = readEnv(
      env({ PLUNE_RUN_TITLE: 'nightly regression', PLUNE_ENV: 'staging', PLUNE_LABELS: 'smoke,slow' }),
    );

    expect(config).toMatchObject({
      title: 'nightly regression',
      environment: 'staging',
      labels: ['smoke', 'slow'],
    });
  });

  // `a,,b` is a CI template that had nothing for the middle slot, not a request for an empty label.
  it('drops the gaps a template leaves in a list', () => {
    expect(readEnv(env({ PLUNE_LABELS: ' smoke , , slow ' })).config.labels).toEqual(['smoke', 'slow']);
  });

  it('treats a list of nothing as unset', () => {
    expect(readEnv(env({ PLUNE_LABELS: ' , ' })).config.labels).toBeUndefined();
  });

  // Deliberately NOT capped here. The platform states the limits and refuses what exceeds them by
  // name; a second copy of the caps in the client would only be a second place for them to drift.
  it('passes a list on whatever its length', () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${String(i)}`);

    expect(readEnv(env({ PLUNE_LABELS: many.join(',') })).config.labels).toHaveLength(40);
  });
});

describe('the variables that have nowhere to go yet', () => {
  // The failure this prevents is the expensive one: a client that believes it stored something the
  // server silently dropped. `runMetaSchema` strips unknown keys, so sending a group there would
  // look exactly like success. Saying so is the only honest option until the run grows the field.
  it('names each one it was given rather than dropping it quietly', () => {
    const { ignored } = readEnv(env({ PLUNE_GROUP: 'checkout' }));

    expect(ignored).toEqual(['PLUNE_GROUP']);
  });

  it('says nothing when none of them are set', () => {
    expect(readEnv(env({ PLUNE_RUN: 'x' })).ignored).toEqual([]);
  });

  // The three that left this list did so because D13 gave a run somewhere to put them. A name that
  // is both accepted and listed here would print a refusal for a setting that did arrive.
  it('no longer refuses what the platform now stores', () => {
    expect([...UNSUPPORTED_VARS]).toEqual(['PLUNE_GROUP']);
    expect(readEnv(env({ PLUNE_RUN_TITLE: 't', PLUNE_ENV: 'e', PLUNE_LABELS: 'l' })).ignored).toEqual([]);
  });
});

describe('PLUNE_CREATE — offering tests the platform has no case for (D14)', () => {
  it('is read by value, so one matrix cell can turn it off', () => {
    expect(readEnv(env({ PLUNE_CREATE: '1' })).config.offerDiscovered).toBe(true);
    expect(readEnv(env({ PLUNE_CREATE: '0' })).config.offerDiscovered).toBeUndefined();
  });

  it('says nothing when unset, rather than saying no', () => {
    // The difference matters: `false` here would outrank a committed config that asked for it, and
    // an unset variable is not an instruction.
    expect('offerDiscovered' in readEnv(env({})).config).toBe(false);
  });
});

describe('PLUNE_FULL_RUN — the claim that this run is the whole suite (D20)', () => {
  it('is read by value, and says nothing when unset', () => {
    expect(readEnv(env({ PLUNE_FULL_RUN: '1' })).config.full).toBe(true);
    expect(readEnv(env({ PLUNE_FULL_RUN: 'true' })).config.full).toBe(true);
    // `0` in a matrix cell means off — and off is absent, so a committed `full: true` still wins.
    expect('full' in readEnv(env({ PLUNE_FULL_RUN: '0' })).config).toBe(false);
    expect('full' in readEnv(env({})).config).toBe(false);
  });
});

/**
 * plune-ai/plune#927. The panel of a run says where it ran: the branch and the commit. Neither
 * reached the platform before, so every row read empty.
 *
 * The `ci` objects below are what Playwright 1.63's own `ciInfo()` builds (`lib/runner/index.js`): under
 * GitHub Actions a commit and no branch, under GitLab and Jenkins both. The environments are each
 * provider's own variables, and a pull request is told apart from a push the way GitHub tells them:
 * `GITHUB_HEAD_REF` is the pull request's branch and empty on a push, where `GITHUB_REF_NAME` is it.
 */
describe('the commit and branch a CI job says it runs at (plune#927)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
  const github = (more: Record<string, string> = {}): NodeJS.ProcessEnv =>
    env({ GITHUB_ACTIONS: 'true', GITHUB_SHA: SHA, ...more });
  const playwrightOnGitHub = {
    commitHref: `https://github.com/acme/shop/commit/${SHA}`,
    commitHash: SHA,
    buildHref: 'https://github.com/acme/shop/actions/runs/42',
  };

  it('reads a GitHub push: the commit, and the ref name as the branch', () => {
    expect(ciCommit(undefined, github({ GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' }))).toEqual({
      sha: SHA,
      branch: 'main',
    });
  });

  it('reads a GitHub pull request: the pull request’s own branch, not "12/merge"', () => {
    expect(
      ciCommit(undefined, github({ GITHUB_HEAD_REF: 'feat/panel', GITHUB_REF_NAME: '12/merge' })),
    ).toEqual({
      sha: SHA,
      branch: 'feat/panel',
    });
  });

  it('reads GitLab', () => {
    expect(
      ciCommit(
        undefined,
        env({ GITLAB_CI: 'true', CI_COMMIT_SHA: SHA, CI_COMMIT_REF_NAME: 'release/1.4' }),
      ),
    ).toEqual({ sha: SHA, branch: 'release/1.4' });
  });

  it('reads Jenkins', () => {
    expect(
      ciCommit(
        undefined,
        env({ JENKINS_URL: 'https://ci.acme.test/', GIT_COMMIT: SHA, GIT_BRANCH: 'origin/main' }),
      ),
    ).toEqual({ sha: SHA, branch: 'origin/main' });
  });

  // Where a variable is named the same everywhere (`GIT_COMMIT`), only the job saying which CI it is
  // makes it a CI's: a laptop that exports one for some other tool is not running a build.
  it('says nothing outside a CI — and does not make a commit of a stray variable', () => {
    expect(ciCommit(undefined, env({}))).toEqual({});
    expect(
      ciCommit(
        undefined,
        env({ GIT_COMMIT: SHA, GIT_BRANCH: 'main', GITHUB_SHA: SHA, CI_COMMIT_SHA: SHA }),
      ),
    ).toEqual({});
  });

  it('takes the commit from what Playwright wrote, and the branch GitHub never gives from the job', () => {
    expect(
      ciCommit(
        playwrightOnGitHub,
        github({ GITHUB_HEAD_REF: 'feat/panel', GITHUB_REF_NAME: '12/merge' }),
      ),
    ).toEqual({
      sha: SHA,
      branch: 'feat/panel',
    });
    expect(ciCommit(playwrightOnGitHub, github({ GITHUB_REF_NAME: 'main' }))).toEqual({
      sha: SHA,
      branch: 'main',
    });
  });

  it('keeps the branch Playwright wrote (GitLab, Jenkins), whatever the environment says', () => {
    expect(
      ciCommit(
        { commitHash: SHA, branch: 'release/1.4' },
        env({ GITLAB_CI: 'true', CI_COMMIT_SHA: SHA, CI_COMMIT_REF_NAME: 'somewhere-else' }),
      ),
    ).toEqual({ sha: SHA, branch: 'release/1.4' });
  });

  // A Playwright JSON report imported by another job: the report names the commit that ran, and this
  // job's branch belongs to this job's commit. Half of each would be a commit on a branch it is not on.
  it('gives a report another job wrote its own commit and no branch of this job’s', () => {
    expect(
      ciCommit(
        { commitHash: OTHER },
        github({ GITHUB_HEAD_REF: 'feat/panel', GITHUB_REF_NAME: '12/merge' }),
      ),
    ).toEqual({
      sha: OTHER,
    });
  });

  it('takes a commit a project wrote into `metadata.ci` itself, in a CI Playwright does not know', () => {
    expect(ciCommit({ commitHash: SHA, branch: 'trunk' }, env({}))).toEqual({
      sha: SHA,
      branch: 'trunk',
    });
  });

  it('ignores what is not a text, and trims what is', () => {
    expect(ciCommit({ commitHash: 42, branch: '  ' }, env({}))).toEqual({});
    expect(ciCommit('ci', env({}))).toEqual({});
    expect(ciCommit(null, env({}))).toEqual({});
    expect(ciCommit({ commitHash: ` ${SHA} `, branch: ' main ' }, env({}))).toEqual({
      sha: SHA,
      branch: 'main',
    });
    // A blank variable is what a template leaves when it had nothing to give.
    expect(
      ciCommit(undefined, github({ GITHUB_SHA: ' ', GITHUB_HEAD_REF: '', GITHUB_REF_NAME: '' })),
    ).toEqual({});
  });
});

describe('what a run is called when nobody named it', () => {
  // A row in the list has to say whose, when and from where without being opened. The job id and
  // the epoch the old names ended in said none of that — and two runs of one day were told apart
  // by nothing. The clock is the reporting machine's own, to the minute.
  const at = new Date(2026, 8, 15, 15, 26, 41);

  it('is the directory, the local minute and where it ran', () => {
    expect(defaultRunTitle(env({}), at, '/home/me/plune')).toBe('plune · 2026-09-15 15:26 · local');
    expect(defaultRunTitle(env({ CI: 'true' }), at, '/home/runner/work/plune/plune')).toBe(
      'plune · 2026-09-15 15:26 · ci',
    );
  });

  it('pads the clock, so January the 5th at nine sorts beside December the 15th at ten', () => {
    expect(defaultRunTitle(env({}), new Date(2026, 0, 5, 9, 7), '/x/cli')).toBe('cli · 2026-01-05 09:07 · local');
  });

  it('reads CI by value — a matrix cell that sets it to 0 is not a runner', () => {
    expect(defaultRunTitle(env({ CI: '0' }), at, '/x/cli')).toMatch(/· local$/);
    expect(defaultRunTitle(env({ GITHUB_ACTIONS: 'true' }), at, '/x/cli')).toMatch(/· ci$/);
  });
});
