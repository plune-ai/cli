/**
 * The unattended sign-in of the `oauth` suite: a token from the client-credentials grant, and the one request the suite
 * already uses to tell a protected server from an open one, sent with it. No person, no browser.
 *
 * The client secret goes only to a token endpoint on an origin `--allow-origin` named (https, or http on a loopback
 * name); the token goes only to the MCP endpoint. Nothing is retried: the check sends one request to the token
 * endpoint and one to the MCP endpoint. The token is masked in every output before it is written, and is not revoked.
 */

import {
  asMetadata,
  credentialRefusal,
  inconclusive,
  isHttpUrl,
  isMeta,
  isOutcome,
  lostStatus,
  needsAuth,
  needsInput,
  prerequisite,
  probe,
  requestToken,
  transient,
} from './auth.js';
import type { ConformanceCheck } from './index.js';
import { failed, passed } from './wire.js';

const tokenWorks: ConformanceCheck = async (c) => {
  const ctx = c.oauth!;
  const p = await needsAuth(ctx);
  if (isOutcome(p)) return p;
  const reg = ctx.config.registration;
  const secretName = reg?.clientSecretEnv;
  const secret = secretName === undefined ? undefined : ctx.env[secretName];
  if (
    ctx.config.auth !== 'client-credentials' ||
    reg?.method !== 'preregistered' ||
    reg.clientId === undefined ||
    secret === undefined ||
    secret === ''
  )
    return needsInput(
      'A token is obtained with --config that has auth "client-credentials" and a preregistered client (clientId, and clientSecretEnv naming a variable that is set). No request was sent.',
    );
  const m = await asMetadata(ctx);
  if (!isMeta(m)) return m;
  const endpoint = m.doc['token_endpoint'];
  if (typeof endpoint !== 'string')
    return prerequisite('The authorization server metadata has no token_endpoint.', [m.detail]);
  if (!isHttpUrl(endpoint))
    return prerequisite('The token_endpoint of the metadata is not an absolute http(s) URL.', [
      m.detail,
    ]);
  const refusal = credentialRefusal(ctx, endpoint);
  if (refusal !== undefined)
    return needsInput(`${refusal} No request was sent to the token endpoint.`);
  const resource = ctx.config.resource ?? ctx.url;
  const t = await requestToken(ctx, endpoint, reg.clientId, secret, resource);
  if ('error' in t) {
    const what = 'The token endpoint';
    return transient(t.status)
      ? lostStatus(what, t.error, [t.detail])
      : prerequisite(
          `${what} refused the pre-registered client (${t.error}): there is no token to try.`,
          [t.detail],
        );
  }
  // Masked from here on: the token is added to the secrets before the request that carries it is written down.
  const sent = await probe(ctx, t.token);
  const details = [t.detail, sent.detail];
  if (transient(sent.status))
    return inconclusive('The MCP endpoint, asked with the token,', sent.status, details);
  if (sent.status >= 200 && sent.status < 300)
    return {
      ...passed(
        `A token issued for ${resource} by the token endpoint was accepted (HTTP ${sent.status}). The token was issued and was not revoked.`,
      ),
      details,
    };
  if (sent.status === 401)
    return {
      ...failed(
        'The MCP endpoint answered HTTP 401 to a token that its authorization server had just issued for it. The token was issued and was not revoked.',
        'Accept an access token issued for this server by its authorization server (RFC 8707 audience, OAuth 2.1 section 5.2).',
      ),
      details,
    };
  return {
    ...prerequisite(
      `The MCP endpoint answered HTTP ${sent.status} to the token, which is not a refusal of the token itself (it may lack a scope the endpoint needs). The token was issued and was not revoked.`,
      details,
    ),
  };
};

export const AUTH_TOKEN = {
  'oauth-e2e-token-works': tokenWorks,
} satisfies Record<string, ConformanceCheck>;
