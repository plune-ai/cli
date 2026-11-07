/**
 * The HTTP half of the tools: one request to the platform with the caller's token, the project and the agent's session.
 * `X-Plune-Session` is what makes the platform treat the caller as an agent — its changes grouped and undoable as one,
 * and its deletions refused (#1280) — so it is on every request, never optional.
 */

export interface PluneApiOptions {
  token: string;
  /** The api base, e.g. `https://beta-api.plune.ai`; a trailing slash is trimmed. */
  apiUrl: string;
  /** `X-Plune-Project`; a token minted in a project is held there whatever this says. */
  projectId?: string | undefined;
  sessionId: string;
  fetchImpl?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, string | readonly string[]> | undefined;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** The platform answered, with a status outside 2xx. */
export class PluneApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const error = bodyField(body, 'error');
    super(error ?? `HTTP ${status}`);
    this.name = 'PluneApiError';
  }

  get code(): string | undefined {
    return bodyField(this.body, 'code');
  }
}

/** The platform could not be reached at all. */
export class PluneNetworkError extends Error {
  constructor(readonly apiUrl: string) {
    super(`could not reach Plune at ${apiUrl}`);
    this.name = 'PluneNetworkError';
  }
}

function bodyField(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

export function buildUrl(apiUrl: string, req: Pick<ApiRequest, 'path' | 'query'>): URL {
  const url = new URL(apiBase(apiUrl) + req.path);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    for (const v of typeof value === 'string' ? [value] : value) url.searchParams.append(key, v);
  }
  return url;
}

export function createPluneApi(opts: PluneApiOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
    accept: 'application/json',
    'x-plune-session': opts.sessionId,
    ...(opts.projectId === undefined ? {} : { 'x-plune-project': opts.projectId }),
    ...(opts.userAgent === undefined ? {} : { 'user-agent': opts.userAgent }),
  };

  return async function request(req: ApiRequest): Promise<ApiResponse> {
    const url = buildUrl(opts.apiUrl, req);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: req.method,
        headers: req.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        // Host pinning (#1283): a redirect elsewhere would carry the token there.
        redirect: 'manual',
      });
    } catch {
      throw new PluneNetworkError(apiBase(opts.apiUrl));
    }
    const text = await res.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: kept as the text it was.
      }
    } else {
      body = undefined;
    }
    if (res.status < 200 || res.status >= 300) throw new PluneApiError(res.status, body);
    return { status: res.status, body };
  };
}

export type PluneApiRequest = ReturnType<typeof createPluneApi>;
