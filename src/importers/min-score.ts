/**
 * `--min-score <category>=<n>` for a Lighthouse import, apart from the reader so the CLI can parse the
 * option without loading an importer.
 */

/** One `--min-score category=n`, added to the ones before it — commander's collector for a repeatable option. */
export function parseMinScore(value: string, previous: Record<string, number> = {}): Record<string, number> {
  const match = /^([A-Za-z0-9_-]+)=(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (match === null) throw new Error(`"${value}" is not category=score (for example performance=90).`);
  const score = Number(match[2]);
  if (score > 100) throw new Error(`"${value}" — a Lighthouse score is 0 to 100.`);
  return { ...previous, [match[1]!]: score };
}
