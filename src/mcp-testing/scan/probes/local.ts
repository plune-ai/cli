/**
 * Whether a URL names this machine, for the purposes of consent and of a token over plain http: `localhost`, an address
 * in 127.0.0.0/8 and `[::1]`. A name under `.localhost` is not this machine here: it is decided by the name, and a
 * resolver may send it elsewhere. (The shared `isLocal` of the conformance suites also accepts `*.localhost`; it is left
 * as it is.)
 */
export function isThisMachine(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}
