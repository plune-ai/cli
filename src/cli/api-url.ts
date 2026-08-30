/**
 * Where the platform lives, resolved once (#329/#330).
 *
 * `sync.ts` and `ingest.ts` each carried their own copy of this — same default, same env variable,
 * same trailing-slash trim, three lines apart. Two copies of a rule are two places to change it, and
 * `login` was about to be the third.
 */

/**
 * Where to go when the CLI cannot explain itself (#334).
 *
 * Public, and that is the whole point: the feedback template lived in a private repository until
 * #333, so the only people who could open it were the ones who did not need it.
 *
 * Printed only on an UNEXPECTED failure. Every classified one already says what to do, and adding
 * "or complain about it" to a message that ends in an instruction teaches people to skip the
 * instruction.
 */
export const FEEDBACK_URL = 'https://github.com/plune-ai/feedback/issues/new?template=feedback.yml';

/** Beta, because that is the only deployment there is. Prod arrives with P7, not before. */
const DEFAULT_API_URL = 'https://beta-api.plune.ai';

/** The api base, with any trailing slash trimmed so `${base}/v1/runs` never doubles up. */
export function resolveApiUrl(explicit?: string): string {
  const raw = explicit ?? process.env['PLUNE_API_URL'] ?? DEFAULT_API_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Where a PERSON goes to get a token — the dashboard, not the api.
 *
 * Only for the deployment we actually know the shape of. Someone running their own copy has set
 * `PLUNE_API_URL` to a host we have never seen, and guessing that their web app is the same name
 * minus `-api` would send them somewhere that may not exist. In that case say nothing rather than
 * something wrong: the message that uses this falls back to naming the api instead.
 */
export function dashboardUrl(apiUrl: string = resolveApiUrl()): string | undefined {
  return apiUrl === DEFAULT_API_URL ? 'https://beta.plune.ai' : undefined;
}

/** One sentence about where a token comes from — used by three different messages. */
export function whereToGetAToken(apiUrl: string = resolveApiUrl()): string {
  const web = dashboardUrl(apiUrl);
  return web === undefined
    ? `Get one from your Plune dashboard (the web app in front of ${apiUrl}), under Settings → API tokens.`
    : `Get one at ${web} → Settings → API tokens.`;
}
