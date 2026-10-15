import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * The bulk routes of the platform for a report's files (platform ADR 0051): `uploads-batch`, `complete-batch` and
 * `direct-batch` take up to this many files a request and answer 200 with one verdict per item, in order.
 */
export const FILES_BATCH_MAX = 100;
/** `direct-batch`: the bytes of one request together, decoded. A request over it is refused as a whole. */
export const DIRECT_BATCH_BYTES = 6 * 1024 * 1024;
/** Requests of this kind in flight at once, each carrying up to `FILES_BATCH_MAX` files (the PUTs are bounded apart, by `uploadConcurrency`). */
export const BATCH_PIPELINES = 2;

/** One verdict of a batch. Only the fields this side reads. */
export interface BatchVerdict {
  index?: number;
  status?: string;
  id?: string;
  code?: string;
  retryable?: boolean;
  url?: string;
  headers?: Record<string, string>;
}

/** SHA-256 (hex) of a file, read as a stream: memory stays at one chunk whatever the size. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest('hex');
}

export const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Codes of a refusal that are about the customer's bucket, not about the platform's own storage. */
export const BUCKET_CODES: ReadonlySet<string> = new Set([
  'bucket_unreachable',
  'not_connected',
  'platform_not_configured',
  'upload_expired',
  'file_mismatch',
  'file_missing',
]);
