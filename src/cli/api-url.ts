/**
 * Where the platform lives, resolved once.
 *
 * `sync.ts` and `ingest.ts` each carried their own copy of this — same default, same env variable,
 * same trailing-slash trim, three lines apart. Two copies of a rule are two places to change it, and
 * `login` was about to be the third.
 */

/**
 * Where to go when the CLI cannot explain itself.
 *
 * Public, and that is the whole point: the feedback template used to live in a private repository,
 * so the only people who could open it were the ones who did not need it.
 *
 * Printed only on an UNEXPECTED failure. Every classified one already says what to do, and adding
 * "or complain about it" to a message that ends in an instruction teaches people to skip the
 * instruction.
 */
export const FEEDBACK_URL = 'https://github.com/plune-ai/feedback/issues/new?template=feedback.yml';

const PRODUCTION_API_URL = 'https://api.plune.ai';
const BETA_API_URL = 'https://beta-api.plune.ai';

/** Production. It was the beta while the beta was the only deployment; `PLUNE_API_URL` still reaches it. */
const DEFAULT_API_URL = PRODUCTION_API_URL;

/** The two deployments whose web app we know. A `Map`, so a host named `constructor` finds nothing. */
const DASHBOARDS = new Map([
  [PRODUCTION_API_URL, 'https://app.plune.ai'],
  [BETA_API_URL, 'https://beta.plune.ai'],
]);

/** The api base, with any trailing slash trimmed so `${base}/v1/runs` never doubles up. */
export function resolveApiUrl(explicit?: string): string {
  const raw = explicit ?? process.env['PLUNE_API_URL'] ?? DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Where a PERSON goes to get a token — the dashboard, not the api.
 *
 * Only for the deployments we actually know the shape of: production and the beta. Someone running their own copy has set
 * `PLUNE_API_URL` to a host we have never seen, and guessing that their web app is the same name
 * minus `-api` would send them somewhere that may not exist. In that case say nothing rather than
 * something wrong: the message that uses this falls back to naming the api instead.
 */
export function dashboardUrl(apiUrl: string = resolveApiUrl()): string | undefined {
  return DASHBOARDS.get(apiUrl);
}

/**
 * What follows "your token was rejected": the address that said no, and what to do about it.
 *
 * The saved login is a token and nothing else, so it does not say which deployment issued it. Someone
 * who logged in while the default was the beta holds a beta token, and after an upgrade it goes to
 * production, which refuses it. Production is the only place that can happen, so it is the only place
 * the beta is mentioned.
 */
export function tokenRefusedBy(apiUrl: string = resolveApiUrl()): string {
  const named = `The address that refused it is ${apiUrl}.`;
  if (apiUrl !== PRODUCTION_API_URL) return named;
  return (
    `${named} A token from a beta account works only on the beta: run "plune login" with a token from ` +
    `${DASHBOARDS.get(PRODUCTION_API_URL)}, or set PLUNE_API_URL=${BETA_API_URL} to keep using the beta account.`
  );
}

/** One sentence about where a token comes from — used by three different messages. */
export function whereToGetAToken(apiUrl: string = resolveApiUrl()): string {
  const web = dashboardUrl(apiUrl);
  return web === undefined
    ? `Get one from your Plune dashboard (the web app in front of ${apiUrl}), under Account → API tokens.`
    : `Get one at ${web} → Account → API tokens.`;
}
