// Minimal ANSI styler (ADR-RP01). Color is gated by an injected flag so renderers stay pure and
// testable — when color is off, every styler is the identity function (zero ANSI in files/pipes).

export interface Styler {
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

const CODE = { green: 32, red: 31, yellow: 33, dim: 2, bold: 1 } as const;

function wrap(code: number, s: string): string {
  return `[${code}m${s}[0m`;
}

export function createStyler(color: boolean): Styler {
  if (!color) {
    const id = (s: string): string => s;
    return { green: id, red: id, yellow: id, dim: id, bold: id };
  }
  return {
    green: (s) => wrap(CODE.green, s),
    red: (s) => wrap(CODE.red, s),
    yellow: (s) => wrap(CODE.yellow, s),
    dim: (s) => wrap(CODE.dim, s),
    bold: (s) => wrap(CODE.bold, s),
  };
}
