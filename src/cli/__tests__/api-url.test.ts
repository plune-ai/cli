import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dashboardUrl, resolveApiUrl, tokenRefusedBy, whereToGetAToken } from '../api-url.js';
import { IngestTokenRejectedError } from '../commands/ingest.js';
import { TokenRejectedError as LoginTokenRejectedError } from '../commands/login.js';
import { TokenRejectedError } from '../commands/sync.js';

const PRODUCTION = 'https://api.plune.ai';
const BETA = 'https://beta-api.plune.ai';
const OWN = 'https://plune.internal.example';

// The machine that runs this may have an address of its own set.
const saved = process.env['PLUNE_API_URL'];
beforeEach(() => {
  delete process.env['PLUNE_API_URL'];
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (saved !== undefined) process.env['PLUNE_API_URL'] = saved;
});

describe('the address the CLI talks to', () => {
  it('is production when nothing names another', () => {
    expect(resolveApiUrl()).toBe(PRODUCTION);
  });

  it('is PLUNE_API_URL when it is set, and the explicit one over both; a trailing slash is trimmed', () => {
    vi.stubEnv('PLUNE_API_URL', `${BETA}/`);
    expect(resolveApiUrl()).toBe(BETA);
    expect(resolveApiUrl(`${OWN}//`)).toBe(OWN);
  });
});

describe('the dashboard a message points at', () => {
  it('is the web app of production, the web app of the beta, and nothing for a host we do not know', () => {
    expect(dashboardUrl(PRODUCTION)).toBe('https://app.plune.ai');
    expect(dashboardUrl(BETA)).toBe('https://beta.plune.ai');
    expect(dashboardUrl(OWN)).toBeUndefined();
    // A host that is also the name of something every object has.
    expect(dashboardUrl('constructor')).toBeUndefined();
  });

  it('follows the default: with no address set, a token comes from the production web app', () => {
    expect(whereToGetAToken()).toBe('Get one at https://app.plune.ai → Account → API tokens.');
  });

  it('keeps a beta account on the beta web app, and names only the api of an unknown deployment', () => {
    expect(whereToGetAToken(BETA)).toContain('https://beta.plune.ai');
    expect(whereToGetAToken(OWN)).toContain(OWN);
    expect(whereToGetAToken(OWN)).not.toContain('plune.ai →');
  });
});

describe('a token refused after the default moved to production', () => {
  // The saved login holds a token and no address, so a token of a beta account goes to production after
  // an upgrade. The refusal is the only moment to say so.
  it('names production and both ways on: a new login, or the beta address', () => {
    expect(tokenRefusedBy(PRODUCTION)).toBe(
      'The address that refused it is https://api.plune.ai. A token from a beta account works only on the beta: ' +
        'run "plune login" with a token from https://app.plune.ai, or set PLUNE_API_URL=https://beta-api.plune.ai ' +
        'to keep using the beta account.',
    );
  });

  it('names any other address and does not send its user to the beta', () => {
    expect(tokenRefusedBy(BETA)).toBe('The address that refused it is https://beta-api.plune.ai.');
    expect(tokenRefusedBy(OWN)).toBe(`The address that refused it is ${OWN}.`);
  });

  it('is what sync, ingest and login say on a 401, with the address they asked', () => {
    for (const err of [
      new TokenRejectedError(),
      new IngestTokenRejectedError(),
      new LoginTokenRejectedError(),
    ]) {
      expect(err.message).toContain(tokenRefusedBy(PRODUCTION));
    }
    expect(new TokenRejectedError(OWN).message).toContain(OWN);
    expect(new TokenRejectedError(OWN).message).not.toContain('beta');
  });
});

describe('an address written another way', () => {
  it('reads PLUNE_API_URL that is set but empty or blank as not set', () => {
    for (const blank of ['', '   ']) {
      vi.stubEnv('PLUNE_API_URL', blank);
      expect(resolveApiUrl()).toBe(PRODUCTION);
      expect(resolveApiUrl(blank)).toBe(PRODUCTION);
    }
  });

  it.each([
    'https://API.plune.ai',
    'https://api.plune.ai:443',
    'https://api.plune.ai/v1',
    ' https://api.plune.ai',
  ])(
    'knows production written as "%s": the dashboard and the two ways on are still named',
    (written) => {
      expect(dashboardUrl(written)).toBe('https://app.plune.ai');
      expect(tokenRefusedBy(written)).toContain('or set PLUNE_API_URL=https://beta-api.plune.ai');
    },
  );

  it('names no dashboard for an address that cannot be read, and does not throw', () => {
    for (const bad of ['', 'not an address', 'api.plune.ai', 'http://']) {
      expect(dashboardUrl(bad)).toBeUndefined();
      expect(tokenRefusedBy(bad)).toBe(`The address that refused it is ${bad}.`);
    }
  });
});
