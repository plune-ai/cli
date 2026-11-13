/**
 * A local server against DNS rebinding: the Origin it refuses and the ones it takes, whether its port answers at an
 * outside address of this machine, and (advice outside the specification) a foreign Host. Only for a server on a
 * loopback name; for any other host these checks are not-applicable (not-local). The two controls hold no level: they
 * show that a 403 to a foreign Origin is a protection, not a server that refuses everything.
 */

import { connect, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { CheckOutcome } from '../outcome.js';
import { isLocal } from '../raw-http.js';
import type { ConformanceCheck, ConformanceContext } from './index.js';
import { ask, isOutcome, ok, probe, probeMethod, session, target, unjudged, type Asked } from './transport.js';
import { failed, passed, prerequisite } from './wire.js';

export const FOREIGN_ORIGIN = 'https://evil.example';
export const FOREIGN_HOST = 'evil.example';
/** How long a connection to an outside address is given. */
const CONNECT_MS = 500;

const port = (url: URL): number => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

/** The outcome when the server is not on a loopback name; undefined when it is. */
function notLocal(ctx: ConformanceContext): CheckOutcome | undefined {
  if (isLocal(target(ctx).url)) return undefined;
  return {
    state: 'not-applicable',
    reason: 'not-local',
    actual: 'The server is not on localhost, 127.0.0.1, [::1] or a *.localhost name: which origins it should take is not known.',
  };
}

/** The probe with one Origin; `null` sends none. Once per run per Origin. */
async function withOrigin(ctx: ConformanceContext, origin: string | null): Promise<Asked | CheckOutcome> {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  if (origin === null) return probe(ctx, s);
  return ctx.memo(`http origin ${origin}`, () => ask(ctx, s, probeMethod(ctx), { set: [['Origin', origin]] }));
}

const localOrigin = (ctx: ConformanceContext) => `http://localhost:${port(new URL(target(ctx).url))}`;

/** A control: the request with this Origin (or none) is accepted. */
async function accepted(ctx: ConformanceContext, origin: string | null): Promise<CheckOutcome> {
  const skip = notLocal(ctx);
  if (skip !== undefined) return skip;
  const a = await withOrigin(ctx, origin);
  if (isOutcome(a)) return a;
  const what = origin === null ? 'A request without Origin' : `Origin: ${origin}`;
  const details = [a.detail];
  if (ok(a.res)) return { ...passed(`${what} was accepted (HTTP ${a.res.status}).`), details };
  const stop = unjudged(a.res, details, { wall: false });
  if (stop !== undefined) return stop;
  return {
    ...failed(`${what} got HTTP ${a.res.status}.`, 'Accept a request from the server\'s own origin, and one with no Origin.'),
    details,
  };
}

const originInvalid403: ConformanceCheck = async (ctx) => {
  const skip = notLocal(ctx);
  if (skip !== undefined) return skip;
  const control = await withOrigin(ctx, localOrigin(ctx));
  if (isOutcome(control)) return control;
  if (!ok(control.res))
    return {
      ...prerequisite(
        `The control with Origin: ${localOrigin(ctx)} got HTTP ${control.res.status}: a 403 to a foreign Origin would show a server that refuses everything, not a protection.`,
      ),
      details: [control.detail],
    };
  const a = await withOrigin(ctx, FOREIGN_ORIGIN);
  if (isOutcome(a)) return a;
  const details = [control.detail, a.detail];
  if (a.res.status === 403) return { ...passed(`Origin: ${FOREIGN_ORIGIN} got 403, Origin: ${localOrigin(ctx)} was accepted.`), details };
  const stop = unjudged(a.res, details, { wall: false });
  if (stop !== undefined) return stop;
  return {
    ...failed(
      `Origin: ${FOREIGN_ORIGIN} got HTTP ${a.res.status}.`,
      'Check the Origin of every request and answer an Origin that is present and not the server\'s own with 403 Forbidden.',
    ),
    details,
  };
};

/** What a TCP connection to host:port got within CONNECT_MS: `open`, `refused`, no answer, or the socket error's code. */
const reach = (host: string, p: number): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect({ host, port: p });
    const done = (got: string) => {
      socket.destroy();
      resolve(got);
    };
    socket.setTimeout(CONNECT_MS, () => done(`no answer in ${CONNECT_MS} ms`));
    socket.once('connect', () => done('open'));
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? 'refused' : (e.code ?? 'error').toLowerCase()));
  });

/** The addresses of this machine outside loopback (link-local IPv6 left out: it needs a zone to connect). */
export const outsideAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && !a.internal && !a.address.toLowerCase().startsWith('fe80:'))
    .map((a) => a!.address);

const bindLoopback: ConformanceCheck = async (ctx) => {
  const skip = notLocal(ctx);
  if (skip !== undefined) return skip;
  const addresses = outsideAddresses();
  if (addresses.length === 0)
    return { state: 'could-not-run', reason: 'needs-input', actual: 'This machine has no outside address to try the port at.' };
  const p = port(new URL(target(ctx).url));
  const got = await Promise.all(addresses.map((a) => reach(a, p)));
  const open = got.filter((g) => g === 'open').length;
  // Each try is kept as the address's family and what it got; the addresses themselves stay out of the report: they say
  // where this machine is. Not `details`: those are HTTP exchanges, and this is a bare TCP connect.
  const tried = `(${addresses.map((a, i) => `${isIPv6(a) ? 'IPv6' : 'IPv4'} ${got[i]}`).join(', ')})`;
  if (open === 0) return passed(`Port ${p} did not answer at any of ${addresses.length} outside address(es) of this machine ${tried}.`);
  return failed(
    `Port ${p} answered at ${open} of ${addresses.length} outside address(es) of this machine ${tried}.`,
    'Bind a local server to 127.0.0.1 (or ::1), not to 0.0.0.0 or every interface.',
  );
};

const hostAdvice: ConformanceCheck = async (ctx) => {
  const skip = notLocal(ctx);
  if (skip !== undefined) return skip;
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const a = await ask(ctx, s, probeMethod(ctx), { set: [['Host', FOREIGN_HOST]] });
  const details = [a.detail];
  const stop = unjudged(a.res, details, { wall: false });
  if (stop !== undefined) return stop;
  if (!ok(a.res)) return { ...passed(`Host: ${FOREIGN_HOST} got HTTP ${a.res.status}.`), details };
  return {
    ...failed(
      `Host: ${FOREIGN_HOST} was accepted (HTTP ${a.res.status}).`,
      'Not a requirement of the specification, practical advice: refuse a Host that is not a name of this server (403 or 421), so a page that rebinds a name to 127.0.0.1 cannot reach the server even without an Origin.',
    ),
    details,
  };
};

export const SECURITY: Record<string, ConformanceCheck> = {
  'http-origin-invalid-403': originInvalid403,
  'http-origin-localhost-accepted': (ctx) => accepted(ctx, localOrigin(ctx)),
  'http-origin-absent-accepted': (ctx) => accepted(ctx, null),
  'http-bind-loopback': bindLoopback,
  'http-host-rebinding-advice': hostAdvice,
};
