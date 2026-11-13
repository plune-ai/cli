/**
 * The per-request metadata of the 2026-07-28 revision (basic/index, `_meta`, Per-request protocol fields): every
 * request of a modern run carries the protocol version and the client capabilities, which are required, and the
 * client's name, which a client SHOULD send. The capabilities are empty: this checker declares none, so a server that
 * needs one has to say so (-32021) rather than assume it.
 */

import { headerValue } from '../../../connect/session.js';

export const CLIENT = { name: 'plune-conformance', version: '1' };

export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  client: 'io.modelcontextprotocol/clientInfo',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
  logLevel: 'io.modelcontextprotocol/logLevel',
} as const;

export const modernMeta = (version: string): Record<string, unknown> => ({
  [META.version]: version,
  [META.client]: CLIENT,
  [META.capabilities]: {},
});

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One `x-mcp-header` annotation of an inputSchema: where it is (the keys from the root) and its value. */
export interface HeaderMark {
  path: string[];
  value: unknown;
  /** The schema that holds it. */
  schema: Record<string, unknown>;
}

/** Every `x-mcp-header` in a schema, wherever it is; a key of a `properties` map is a name, not an annotation. */
export function headerMarks(schema: unknown, path: string[] = [], inNames = false): HeaderMark[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => headerMarks(s, [...path, String(i)]));
  if (!isRecord(schema)) return [];
  const marks: HeaderMark[] = [];
  if (!inNames && 'x-mcp-header' in schema) marks.push({ path, value: schema['x-mcp-header'], schema });
  for (const [k, v] of Object.entries(schema)) {
    if (!inNames && k === 'x-mcp-header') continue;
    marks.push(...headerMarks(v, [...path, k], !inNames && k === 'properties'));
  }
  return marks;
}

/** Reached from the root through `properties` alone: properties, name, properties, name, ... */
export const staticallyReachable = (path: string[]): boolean =>
  path.length > 0 && path.length % 2 === 0 && path.every((k, i) => i % 2 === 1 || k === 'properties');

/**
 * The `Mcp-Param-{Name}` headers of a tools/call: each valid annotation whose argument has a value, the value as the
 * text of a string, an integer or a boolean, encoded as headerValue does (streamable-http, Client Behavior).
 */
export function paramHeaders(tool: Record<string, unknown>, args: Record<string, unknown>): [string, string][] {
  const headers: [string, string][] = [];
  for (const m of headerMarks(tool['inputSchema'])) {
    if (!staticallyReachable(m.path) || typeof m.value !== 'string') continue;
    const names = m.path.filter((_, i) => i % 2 === 1);
    let value: unknown = args;
    for (const n of names) value = isRecord(value) ? value[n] : undefined;
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value)))
      headers.push([`Mcp-Param-${m.value}`, headerValue(String(value))]);
  }
  return headers;
}
