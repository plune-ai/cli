// Which tools of a foreign server `plune` may call on its own (`--call`, the smoke mode): a tool that says it only
// reads, does not say it destroys, and needs no argument. Each tool left out comes back with the reason.

export type SkipReason = 'malformed' | 'not-read-only' | 'destructive' | 'required-arguments';

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
 * `allowWrite` drops the read-only requirement, never the other two. A tool that is not read-only counts as
 * destructive unless it says `destructiveHint: false`: that is the protocol's default for the hint.
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
  const destructive =
    annotations?.destructiveHint === true || (!readOnly && annotations?.destructiveHint !== false);
  if (destructive) return 'destructive';
  const required = inputSchema?.required;
  // Not a list: what it requires cannot be read, so it is not taken to require nothing.
  if (required !== undefined && !Array.isArray(required)) return 'malformed';
  if (Array.isArray(required) && required.length > 0) return 'required-arguments';
  return undefined;
}
