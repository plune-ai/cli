// Tool names on the model's wire. Providers refuse a name outside [a-zA-Z0-9_-]{1,64}; MCP allows more (`files/read`).
// The model is offered a safe name and its calls are mapped back, so the transcript and every check see the server's.

const SAFE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX = 64;

/**
 * A wire name for each server name, in list order. A name that is already safe keeps itself; any other has each
 * unsafe character replaced by `_` and is cut to 64. A name taken already gets `_2`, `_3`, …: the same list always
 * maps the same way.
 */
export function wireNames(names: readonly string[]): {
  toWire: Map<string, string>;
  toServer: Map<string, string>;
} {
  const toWire = new Map<string, string>();
  const toServer = new Map<string, string>();
  // Safe names first, so a renamed one never takes the name of a tool that had it.
  for (const name of names)
    if (SAFE.test(name) && !toServer.has(name)) {
      toWire.set(name, name);
      toServer.set(name, name);
    }
  for (const name of names) {
    if (toWire.has(name)) continue;
    const base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX) || 'tool';
    let wire = base;
    for (let n = 2; toServer.has(wire); n++) wire = `${base.slice(0, MAX - `_${n}`.length)}_${n}`;
    toWire.set(name, wire);
    toServer.set(wire, name);
  }
  return { toWire, toServer };
}
