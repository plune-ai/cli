// Which tools of a foreign server `plune` may call on its own (`--call`, the smoke mode): a tool that says it only
// reads, does not say it destroys, and needs no argument. Each tool left out comes back with the reason.

export type SkipReason =
  | 'malformed'
  | 'not-read-only'
  | 'destructive'
  | 'no-destructive-hint'
  | 'required-arguments';

export interface SafeTool {
  name: string;
  [field: string]: unknown;
}

export interface SafeToolSelection<T> {
  safe: (T & SafeTool)[];
  skipped: { tool: T; reason: SkipReason }[];
}

type Annotations = { readOnlyHint?: unknown; destructiveHint?: unknown };

/**
 * `allowWrite` drops the read-only requirement, never the other two. A tool that is not read-only is called only when
 * it says `destructiveHint: false` (`no-destructive-hint` otherwise): the protocol's default for the hint is
 * destructive. Hints are read strictly: only the boolean `true` is read-only, and any `destructiveHint` that is not a
 * boolean counts as destructive.
 */
export function selectSafeTools<T>(
  tools: readonly T[],
  opts: { allowWrite?: boolean } = {},
): SafeToolSelection<T> {
  const selection: SafeToolSelection<T> = { safe: [], skipped: [] };
  for (const tool of tools) {
    const reason = skipReason(tool, opts.allowWrite === true);
    if (reason === undefined) selection.safe.push(tool as T & SafeTool);
    else selection.skipped.push({ tool, reason });
  }
  return selection;
}

function skipReason(tool: unknown, allowWrite: boolean): SkipReason | undefined {
  if (
    tool === null ||
    typeof tool !== 'object' ||
    typeof (tool as { name?: unknown }).name !== 'string'
  )
    return 'malformed';
  const { annotations, inputSchema } = tool as {
    annotations?: Annotations;
    inputSchema?: { required?: unknown };
  };
  const readOnly = annotations?.readOnlyHint === true;
  if (!readOnly && !allowWrite) return 'not-read-only';
  const hint = annotations?.destructiveHint;
  if (hint === true || (hint !== undefined && typeof hint !== 'boolean')) return 'destructive';
  if (!readOnly && hint !== false) return 'no-destructive-hint';
  const required = inputSchema?.required;
  // Not a list: what it requires cannot be read, so it is not taken to require nothing.
  if (required !== undefined && !Array.isArray(required)) return 'malformed';
  if (Array.isArray(required) && required.length > 0) return 'required-arguments';
  if (mayRequire(inputSchema)) return 'required-arguments';
  return undefined;
}

/**
 * A schema that can require something without a top-level `required`: through a combinator, a reference, a
 * dependency or a minimum count. Not resolved, only seen: `{}` might fail it, so it is not called with `{}`.
 */
function mayRequire(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (['allOf', 'anyOf', 'oneOf', '$ref', 'dependentRequired'].some((k) => k in s)) return true;
  return typeof s.minProperties === 'number' && s.minProperties > 0;
}
