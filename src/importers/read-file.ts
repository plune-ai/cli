import * as fs from 'node:fs';

/**
 * A report file as text, without the one UTF-8 byte order mark an editor or a Windows tool may put
 * at its start. JSON.parse refuses the mark outright, so a Lighthouse report saved with one read as
 * no report at all; every format `run import` reads goes through here, so none of them sees it.
 */
export function readReportFile(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
