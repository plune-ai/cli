import { sha256 } from '../util/hash.js';

/**
 * The ceiling the platform's contract puts on `resultKey` (`resultSubmissionSchema`).
 *
 * Exported so the test asserts against the same number the fallback branch is chosen by, rather
 * than against a copy of it.
 */
export const RESULT_KEY_MAX = 200;

/** 128 bits of the digest. Long enough that a collision is not a thing that happens; short enough
 * that the key still fits beside the retry in a log line. */
const HASH_CHARS = 32;

/**
 * The reporter's own id for one result — minted by the client, never by the server.
 *
 * It has to be **the same string** the second time the same result is reported, because that is
 * the entire mechanism behind AC-04: `playwright merge-reports` runs the reporter again over the
 * merged blob, and the platform's unique index on `(run_id, result_key)` answers `duplicate`
 * instead of writing a second row. A key derived from anything that varies between the two passes
 * — a timestamp, a counter, a random id — would double every result silently.
 *
 * Readable while it fits: this string lands in the database and in error messages, and
 * `a1b2c3…#0` tells a person nothing about which test broke. Only when the plain form would
 * exceed what the contract accepts does it fall back to a digest — and the digest covers the test
 * id alone, so the retry stays visible and a flaky test's three attempts never collapse into one.
 */
export function resultKey(testId: string, retry: number): string {
  const plain = `${testId}#${retry}`;
  return plain.length <= RESULT_KEY_MAX ? plain : `${sha256(testId).slice(0, HASH_CHARS)}#${retry}`;
}
