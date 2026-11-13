/**
 * `oauth-neg-insufficient-scope`: a token with a narrower scope than the endpoint needs is refused with 403 and
 * `insufficient_scope`. Unattended, with the client-credentials grant of `--config`.
 *
 * The control comes first: a token with the full `scopes` must be accepted by the one request the suite uses to tell a
 * protected server from an open one, else nothing is learned and the narrow token is not asked for. Then the token
 * with `narrowScopes`, which the operator says is not enough: if the authorization server does not issue a token that
 * is narrower, no request is sent with it. At most two requests go to the token endpoint and two to the MCP endpoint,
 * none repeated. Both tokens are masked before any output, are never stored, and are not revoked.
 */

import { ConnectError } from '../../connect/session.js';
import type { CheckOutcome } from '../outcome.js';
import {
  challengesOf,
  inconclusive,
  isOutcome,
  lostStatus,
  needsAuth,
  needsInput,
  prerequisite,
  probe,
  requestToken,
  transient,
  type Probed,
  type OauthContext,
} from './auth.js';
import { isSignIn, signIn } from './auth-token.js';
import type { ConformanceCheck } from './index.js';
import { failed, passed } from './wire.js';

const issuedText = (n: number): string =>
  n === 1
    ? ' A token was issued and was not revoked.'
    : ' Two tokens were issued and were not revoked.';

const scopeSet = (value: unknown): Set<string> | undefined =>
  typeof value === 'string' ? new Set(value.split(/\s+/).filter((s) => s !== '')) : undefined;

/** One request with the token, a connection that fails told as could-not-run. */
async function send(
  ctx: OauthContext,
  token: string,
  issued: number,
): Promise<Probed | CheckOutcome> {
  try {
    return await probe(ctx, token);
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return {
      state: 'could-not-run',
      reason: err.kind === 'timeout' ? 'timeout' : 'transport-error',
      actual: `The MCP endpoint, asked with the token, ${err.kind === 'timeout' ? 'did not answer in time' : 'could not be reached'}: nothing can be said of the requirement.${issuedText(issued)}`,
    };
  }
}

const insufficientScope: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const narrow = ctx.config.narrowScopes;
  if (narrow === undefined)
    return needsInput(
      'A token with a narrower scope needs "narrowScopes" in --config: the scopes to ask for the token that must be refused. No request was sent.',
    );
  const s = await signIn(ctx);
  if (!isSignIn(s)) return s;
  const with_ = (o: CheckOutcome, n: number): CheckOutcome => ({
    ...o,
    actual: `${o.actual ?? ''}${issuedText(n)}`,
  });

  // The control: the full scopes.
  const full = await requestToken(ctx, s.endpoint, s.clientId, s.secret, s.resource);
  if ('error' in full) {
    const what = 'The token endpoint (the full scopes)';
    if (full.status === 200)
      return prerequisite(`${what} answered HTTP 200 with no access_token.`, [full.detail]);
    return transient(full.status)
      ? lostStatus(what, full.error, [full.detail])
      : prerequisite(`${what} refused the pre-registered client (${full.error}).`, [full.detail]);
  }
  const type = (t: { doc: Record<string, unknown> }): string | undefined => {
    const v = t.doc['token_type'];
    return typeof v === 'string' && v.toLowerCase() === 'bearer'
      ? undefined
      : String(v ?? 'missing');
  };
  const wrongType = type(full);
  if (wrongType !== undefined)
    return with_(
      prerequisite(
        `The token type (${JSON.stringify(wrongType.slice(0, 40))}) is not supported by this check, which sends a Bearer token: the token was not sent.`,
        [full.detail],
      ),
      1,
    );
  const control = await send(ctx, full.token, 1);
  if (isOutcome(control)) return control;
  const details = [full.detail, control.detail];
  if (transient(control.status))
    return with_(
      inconclusive('The MCP endpoint, asked with the full-scope token,', control.status, details),
      1,
    );
  if (control.status < 200 || control.status >= 300)
    return with_(
      prerequisite(
        `The MCP endpoint answered HTTP ${control.status} to the token with the full scopes: a refusal of the narrow token would prove nothing.`,
        details,
      ),
      1,
    );

  // The narrow token.
  let small: Awaited<ReturnType<typeof requestToken>>;
  try {
    small = await requestToken(ctx, s.endpoint, s.clientId, s.secret, s.resource, narrow);
  } catch (err) {
    if (!(err instanceof ConnectError)) throw err;
    return with_(
      {
        state: 'could-not-run',
        reason: err.kind === 'timeout' ? 'timeout' : 'transport-error',
        actual:
          'The token endpoint (the narrow scopes) could not be reached or did not answer in time.',
        details,
      },
      1,
    );
  }
  if ('error' in small) {
    const what = 'The token endpoint (the narrow scopes)';
    return with_(
      transient(small.status)
        ? lostStatus(what, small.error, [...details, small.detail])
        : prerequisite(
            `The authorization server did not issue a narrower token: ${what} answered ${small.error}.`,
            [...details, small.detail],
          ),
      1,
    );
  }
  const all = [...details, small.detail];
  const smallType = type(small);
  if (smallType !== undefined)
    return with_(
      prerequisite(
        `The token type (${JSON.stringify(smallType.slice(0, 40))}) is not supported by this check, which sends a Bearer token: the narrow token was not sent.`,
        all,
      ),
      2,
    );
  // What the server says it granted: the narrow token must lack a scope that the full one has.
  const granted = scopeSet(small.doc['scope']);
  const wide =
    scopeSet(full.doc['scope']) ??
    (ctx.config.scopes === undefined ? undefined : new Set(ctx.config.scopes));
  if (granted !== undefined && wide !== undefined && [...wide].every((x) => granted.has(x)))
    return with_(
      prerequisite(
        'The authorization server did not issue a narrower token: the scope granted to the narrow request holds every scope of the full one. The narrow token was not sent.',
        all,
      ),
      2,
    );

  const answer = await send(ctx, small.token, 2);
  if (isOutcome(answer)) return answer;
  const everything = [...all, answer.detail];
  if (transient(answer.status))
    return with_(
      inconclusive('The MCP endpoint, asked with the narrow token,', answer.status, everything),
      2,
    );
  if (answer.status >= 200 && answer.status < 300)
    return with_(
      prerequisite(
        `The MCP endpoint accepted the narrow token (HTTP ${answer.status}): the request the suite makes did not need the wider scope, so nothing can be said.`,
        everything,
      ),
      2,
    );
  if (answer.status === 403) {
    const named = challengesOf(answer.challenge ?? '').some(
      (ch) => ch.scheme.toLowerCase() === 'bearer' && ch.params['error'] === 'insufficient_scope',
    );
    if (named)
      return {
        ...passed(
          `The narrow token got HTTP 403 with error="insufficient_scope", while the full-scope token was accepted.${issuedText(2)}`,
        ),
        details: everything,
      };
  }
  if (answer.status === 401 || answer.status === 403)
    return {
      ...failed(
        `The narrow token got HTTP ${answer.status}${answer.status === 403 ? ' with no Bearer challenge naming insufficient_scope' : ''}, while the full-scope token was accepted.${issuedText(2)}`,
        'Answer a request whose token has insufficient scope with 403 Forbidden and WWW-Authenticate: Bearer error="insufficient_scope" (RFC 6750 section 3.1).',
      ),
      details: everything,
    };
  return with_(
    prerequisite(
      `The MCP endpoint answered HTTP ${answer.status} to the narrow token, which does not say whether the scope was the reason.`,
      everything,
    ),
    2,
  );
};

export const AUTH_SCOPE = {
  'oauth-neg-insufficient-scope': insufficientScope,
} satisfies Record<string, ConformanceCheck>;
