/**
 * Exit codes of every `plune mcp` command that tests a server, in one place.
 * - `ok`: everything passed.
 * - `violations`: something was found at the `--fail-on` level.
 * - `usage`: the flags were wrong, or the server could not be reached (a `ConnectError`).
 * - `unmeasured`: the run finished but measured nothing, or a check that was to be measured could not run. Not
 *   measured is not zero; `plune diff` uses 3 for the same thing.
 */
export const MCP_EXIT = { ok: 0, violations: 1, usage: 2, unmeasured: 3 } as const;
