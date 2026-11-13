/**
 * The catalog entries of the `oauth` suite: what an MCP server over HTTP owes its clients in authorization. Data only,
 * like catalog.ts, which appends these to CATALOG. Every quoted requirement was read in the text of the revision on
 * 2026-11-13: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization (one page) and, for
 * 2026-07-28, the pages `basic/authorization` and its sub-pages `authorization-server-discovery`,
 * `client-registration` and `security-considerations`; the RFCs they cite were read at rfc-editor.org.
 *
 * `derived`: the level is read from a provision about the client, or from an RFC the specification points to, not
 * quoted about the server; `derivation` says which. A requirement not found in the text is not catalogued.
 */

import type { CatalogEntry, Era, SpecRef } from './catalog.js';

const L = '2025-11-25';
const M = '2026-07-28';
const BOTH: Era[] = ['legacy', 'modern'];
const MODERN: Era[] = ['modern'];
const ref = (revision: string, page: string, section: string): SpecRef => ({
  revision,
  page,
  section,
});
/** The page a section is on: 2025-11-25 has one page, 2026-07-28 splits it. */
const AUTH = 'basic/authorization';
const DISCOVERY = 'basic/authorization/authorization-server-discovery';
const SECURITY = 'basic/authorization/security-considerations';
const REGISTRATION = 'basic/authorization/client-registration';

const oauth = (
  s: Omit<CatalogEntry, 'suite' | 'kind' | 'derived' | 'needsFixture' | 'transports'> &
    Partial<Pick<CatalogEntry, 'derived' | 'needsFixture'>>,
): CatalogEntry => ({
  ...s,
  suite: 'oauth',
  kind: 'check',
  derived: s.derived ?? false,
  needsFixture: s.needsFixture ?? false,
  transports: ['http'],
});

export const OAUTH_CATALOG: readonly CatalogEntry[] = [
  oauth({
    id: 'oauth-requires-auth',
    title: 'A request without a token gets 401',
    description:
      'The MCP endpoint, asked without a token, answers 401 Unauthorized. A 2xx answer means the server is public: every check of the suite is then not-applicable (no-auth).',
    level: 'MUST',
    specRefs: [ref(L, AUTH, 'Error Handling'), ref(M, AUTH, 'Error Handling')],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-challenge-bearer',
    title: 'The 401 carries a Bearer challenge',
    description: 'The 401 answer has a WWW-Authenticate header with the scheme Bearer.',
    level: 'MUST',
    derived: true,
    derivation:
      'RFC 6750 section 3: "All challenges defined by this specification MUST use the auth-scheme value Bearer"; basic/authorization, Protected Resource Metadata Discovery Requirements: clients MUST be able to parse WWW-Authenticate headers of 401 answers. No MCP sentence says MUST about the scheme of the server\'s challenge.',
    specRefs: [
      ref(L, AUTH, 'Protected Resource Metadata Discovery Requirements'),
      ref(M, DISCOVERY, 'Protected Resource Metadata Discovery Requirements'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-prm-reachable',
    title: 'The protected resource metadata can be found',
    description:
      'The server implements at least one of the two mechanisms: resource_metadata in WWW-Authenticate, or a document at the RFC 9728 well-known URI (with the path of the endpoint, or at the root). At least one of them serves a JSON document.',
    level: 'MUST',
    specRefs: [
      ref(L, AUTH, 'Protected Resource Metadata Discovery Requirements'),
      ref(M, DISCOVERY, 'Protected Resource Metadata Discovery Requirements'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-challenge-metadata-url',
    title: 'resource_metadata names a URL that serves the document',
    description:
      'When WWW-Authenticate has resource_metadata, it is an absolute URL and it answers 200 with a JSON object. A challenge without the parameter is not a violation: the well-known URI is the other mechanism.',
    level: 'MUST',
    derived: true,
    derivation:
      'RFC 9728 section 5.1 defines resource_metadata as "the URL of the protected resource metadata". The MCP text makes the parameter one of two mechanisms, so only a parameter that is present is judged.',
    specRefs: [
      ref(L, AUTH, 'Protected Resource Metadata Discovery Requirements'),
      ref(M, DISCOVERY, 'Protected Resource Metadata Discovery Requirements'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-prm-valid',
    title: 'The protected resource metadata names an authorization server',
    description:
      'The document is a JSON object whose authorization_servers lists at least one URL, and whose resource is the URL of the server under test (or the resource named in the configuration).',
    level: 'MUST',
    derived: true,
    derivation:
      'authorization_servers: quoted ("MUST include the authorization_servers field containing at least one authorization server"). resource: RFC 9728 section 3.3 ("The resource value returned MUST be identical to the protected resource\'s resource identifier"), read from the RFC, not from the MCP text.',
    specRefs: [
      ref(L, AUTH, 'Authorization Server Location'),
      ref(M, DISCOVERY, 'Authorization Server Location'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-challenge-scope',
    title: 'The 401 names the scope it needs',
    description: 'WWW-Authenticate has a scope parameter.',
    level: 'SHOULD',
    specRefs: [
      ref(L, AUTH, 'Protected Resource Metadata Discovery Requirements'),
      ref(M, AUTH, 'Scope Selection Strategy'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-as-metadata-discoverable',
    title: 'The authorization server publishes metadata',
    description:
      'For the first authorization_servers entry, a JSON document is served at one of the well-known locations in the order of the specification: RFC 8414 and OpenID Connect Discovery with the path inserted, OpenID Connect Discovery with the path appended (an issuer with a path), or RFC 8414 and OpenID Connect Discovery at the root (an issuer without one).',
    level: 'MUST',
    specRefs: [
      ref(L, AUTH, 'Authorization Server Metadata Discovery'),
      ref(M, DISCOVERY, 'Authorization Server Metadata Discovery'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-as-issuer-matches',
    title: 'The issuer of the metadata is the issuer it was found by',
    description:
      'The issuer member of the metadata document is identical, character for character, to the issuer identifier the well-known URL was built from.',
    level: 'MUST',
    derived: true,
    derivation:
      '2026-07-28 authorization-server-discovery quotes the rule as a duty of the client ("the issuer value in the document MUST be identical to the issuer identifier used to construct the well-known URL"), from RFC 8414 section 3.3; that the server serves such a document is derived. 2025-11-25 has no such sentence, so the check is for the modern era only.',
    specRefs: [ref(M, DISCOVERY, 'Authorization Server Metadata Discovery')],
    eras: MODERN,
  }),
  oauth({
    id: 'oauth-as-https',
    title: 'The authorization endpoints are HTTPS',
    description:
      'The authorization, token and registration endpoints in the metadata are https URLs. An authorization server on a loopback name is not-applicable: the test setup of a local server.',
    level: 'MUST',
    specRefs: [ref(L, AUTH, 'Communication Security'), ref(M, SECURITY, 'Communication Security')],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-as-pkce-advertised',
    title: 'The authorization server advertises PKCE',
    description: 'The metadata has code_challenge_methods_supported.',
    level: 'MUST',
    derived: true,
    derivation:
      'Authorization Code Protection: "If code_challenge_methods_supported is absent, the authorization server does not support PKCE and MCP clients MUST refuse to proceed" (a duty of the client); "Authorization servers providing OpenID Connect Discovery MUST include code_challenge_methods_supported in their metadata" (quoted, for those servers only).',
    specRefs: [
      ref(L, AUTH, 'Authorization Code Protection'),
      ref(M, SECURITY, 'Authorization Code Protection'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-as-pkce-s256',
    title: 'PKCE with S256 is advertised',
    description: 'code_challenge_methods_supported lists S256.',
    level: 'SHOULD',
    derived: true,
    derivation:
      'The text says clients MUST use S256 when technically capable; that the server lists it is derived. The specification checks only that the field is present.',
    specRefs: [
      ref(L, AUTH, 'Authorization Code Protection'),
      ref(M, SECURITY, 'Authorization Code Protection'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-as-iss-advertised',
    title: 'The authorization server advertises the iss parameter',
    description: 'The metadata has authorization_response_iss_parameter_supported: true.',
    level: 'SHOULD',
    specRefs: [ref(M, AUTH, 'Authorization Response Validation')],
    eras: MODERN,
  }),
  oauth({
    id: 'oauth-as-cimd-advertised',
    title: 'The authorization server advertises Client ID Metadata Documents',
    description: 'The metadata has client_id_metadata_document_supported: true.',
    level: 'SHOULD',
    specRefs: [
      ref(L, AUTH, 'Client ID Metadata Documents'),
      ref(M, REGISTRATION, 'Client ID Metadata Documents'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-neg-invalid-token-401',
    title: 'A token that is not valid gets 401',
    description: 'A request with a bearer token the authorization server never issued answers 401.',
    level: 'MUST',
    specRefs: [ref(L, AUTH, 'Token Handling'), ref(M, AUTH, 'Token Handling')],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-neg-wrong-audience',
    title: 'A token issued for another resource is refused',
    description:
      'A token the authorization server issued for another resource (the resource parameter names a different URL) gets 401 from the server under test, while a token issued for the server itself is accepted (the control: a server that refuses every token proves nothing). Needs credentials the authorization server accepts for the client-credentials grant, given in --config.',
    level: 'MUST',
    specRefs: [
      ref(L, AUTH, 'Token Handling'),
      ref(L, AUTH, 'Access Token Privilege Restriction'),
      ref(M, AUTH, 'Token Handling'),
      ref(M, SECURITY, 'Token Audience Binding and Validation'),
    ],
    eras: BOTH,
    needsFixture: true,
  }),
  oauth({
    id: 'oauth-reg-prereg',
    title: 'A pre-registered client is accepted',
    description:
      'The client_id of a pre-registered client (from --config) is accepted at the authorization endpoint: the request is answered with a redirect that carries no error, not with invalid_client. Only the client_id and the redirect URI are sent; no secret goes to the authorization endpoint. A page that shows a sign-in cannot be told from one that shows an error, and is could-not-run.',
    level: 'SHOULD',
    derived: true,
    derivation:
      'The text says "MCP clients SHOULD support an option for static client credentials such as those supplied by a pre-registration flow", a duty of the client. That a server accepts such a client is derived, and its level is not higher than the quoted SHOULD.',
    specRefs: [ref(L, AUTH, 'Preregistration'), ref(M, REGISTRATION, 'Pre-registration')],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-reg-dcr',
    title: 'Dynamic client registration works',
    description:
      'When the metadata names a registration_endpoint and --config allows a client to be created, a registration (RFC 7591) with a correct body (application_type native, a loopback redirect URI) answers 201 with a client_id. The client is deleted afterwards (RFC 7592) when the server gave the means; otherwise the report names the client that remains on the authorization server. In 2026-07-28 the method is deprecated in favour of Client ID Metadata Documents.',
    level: 'MAY',
    specRefs: [
      ref(L, AUTH, 'Dynamic Client Registration'),
      ref(M, REGISTRATION, 'Dynamic Client Registration'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-reg-dcr-http-redirect-rejected',
    title: 'A redirect over http outside loopback is not registered',
    description:
      'A registration whose redirect URI is http on a name that is not loopback is refused, while the same registration with a loopback redirect URI (the control) is accepted. A client made by a server that accepts the fault is deleted, or named in the report when it cannot be.',
    level: 'MUST',
    derived: true,
    derivation:
      'Communication Security: "All redirect URIs MUST be either localhost or use HTTPS." The sentence is about redirect URIs; that an authorization server refuses to register one is derived.',
    specRefs: [
      ref(L, AUTH, 'Communication Security'),
      ref(L, AUTH, 'Open Redirection'),
      ref(M, SECURITY, 'Communication Security'),
      ref(M, SECURITY, 'Open Redirection'),
    ],
    eras: BOTH,
  }),
  oauth({
    id: 'oauth-reg-cimd',
    title: 'A client_id that is a URL is read as a document',
    description:
      'When the metadata advertises client_id_metadata_document_supported, the client_id URL of a document the user hosts (--config registration.clientIdMetadataUrl) is accepted at the authorization endpoint, and the URL of a document whose client_id does not match it (clientIdMetadataMismatchUrl) is refused. Without the second URL only the first half is seen, and the check is could-not-run.',
    level: 'MUST',
    derived: true,
    derivation:
      'Authorization servers "MUST validate that the fetched document’s client_id matches the URL exactly" (quoted). That a server takes a good document and completes the authorization is derived.',
    specRefs: [
      ref(L, AUTH, 'Client ID Metadata Documents'),
      ref(M, REGISTRATION, 'Client ID Metadata Documents'),
    ],
    eras: BOTH,
    needsFixture: true,
  }),
  oauth({
    id: 'oauth-token-format',
    title: 'The token response has access_token and token_type Bearer',
    description:
      'The answer of the token endpoint (client-credentials, from --config) is a JSON object with access_token and token_type Bearer (the value is case insensitive). An absent expires_in is said in the result but does not fail the check: RFC 6749 only recommends it. A token_type other than Bearer (for example DPoP) fails the check: the text of MCP has the token sent as Authorization: Bearer.',
    level: 'MUST',
    derived: true,
    derivation:
      'RFC 6749 section 5.1: access_token and token_type are REQUIRED, expires_in is RECOMMENDED; the Token Requirements of the specification use the token as "Authorization: Bearer". No MCP sentence says MUST about the response of the token endpoint.',
    specRefs: [ref(L, AUTH, 'Token Requirements'), ref(M, AUTH, 'Token Requirements')],
    eras: BOTH,
    needsFixture: true,
  }),
  oauth({
    id: 'oauth-neg-invalid-client',
    title: 'A client that does not exist is not accepted',
    description:
      'A made-up client_id is not accepted at the authorization endpoint (it is not redirected to the redirect URI, with a code or with an error) and, when --config has client credentials, a made-up client is not given a token at the token endpoint (HTTP 400 or 401). The pre-registered client is the control for each half: it must not be refused. A server that sends every client to a sign-in page cannot be judged. The made-up client sends made-up credentials, never the real ones.',
    level: 'MUST',
    derived: true,
    derivation:
      'RFC 6749 section 4.1.2.1: if "the client identifier is missing or invalid, the authorization server SHOULD inform the resource owner of the error and MUST NOT automatically redirect the user-agent to the invalid redirection URI" (the authorization half); section 5.2: invalid_client is "Client authentication failed (e.g., unknown client...)" (the token half, which has no MUST of its own). The MCP text says only that authorization servers "MUST validate exact redirect URIs against pre-registered values" (Open Redirection).',
    specRefs: [ref(L, AUTH, 'Open Redirection'), ref(M, SECURITY, 'Open Redirection')],
    eras: BOTH,
    needsFixture: true,
  }),
  oauth({
    id: 'oauth-neg-authorize-redirect-mismatch',
    title: 'A redirect URI that is not registered is not redirected to',
    description:
      'An authorization request with the pre-registered client and a redirect URI that is not registered (https://plune-conformance-other.invalid/callback, never a real host and never followed) is not answered with a redirect to that URI, neither with a code nor with an error. The same request with the registered redirect URI is the control: it must not be refused. A redirect to a sign-in page of the server that only carries the other URI in a parameter is not a violation, and cannot be judged either.',
    level: 'MUST',
    derived: false,
    derivation:
      'Open Redirection: "Authorization servers MUST validate exact redirect URIs against pre-registered values to prevent redirection attacks." RFC 6749 section 4.1.2.1: if the request fails due to a missing, invalid, or mismatching redirection URI, the server "MUST NOT automatically redirect the user-agent to the invalid redirection URI."',
    specRefs: [ref(L, AUTH, 'Open Redirection'), ref(M, SECURITY, 'Open Redirection')],
    eras: BOTH,
    needsFixture: true,
  }),
];
