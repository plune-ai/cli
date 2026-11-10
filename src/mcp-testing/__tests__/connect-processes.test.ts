// The process table the session reads to end a server's descendants: a line it cannot read is skipped, never the
// whole table, and a pid is killed only while it is still the process that was noted.

import { describe, expect, it } from 'vitest';
import { parseProcessTable, survivors } from '../connect/processes.js';

describe('CLI · mcp connect · process table', () => {
  it('CLI · mcp connect · a broken line is skipped and the rest of the table is kept', () => {
    const text = [
      '10 1 133',
      'You cannot call a method on a null-valued expression.',
      '11 10 134',
      '12 x 135',
      '13 10',
      '',
      '14 10 Tue Nov 10 12:00:00 2026',
    ].join('\r\n');
    expect(parseProcessTable(text)).toEqual([
      { pid: 10, ppid: 1, started: '133' },
      { pid: 11, ppid: 10, started: '134' },
      { pid: 14, ppid: 10, started: 'Tue Nov 10 12:00:00 2026' },
    ]);
  });

  it('CLI · mcp connect · only a pid with the start time it was noted with is still ours to kill', () => {
    const noted = [
      { pid: 20, ppid: 1, started: '100' },
      { pid: 21, ppid: 20, started: '101' },
      { pid: 22, ppid: 20, started: '102' },
    ];
    const now = [
      { pid: 20, ppid: 1, started: '100' },
      // 21 ended and the system gave its pid to someone else
      { pid: 21, ppid: 7, started: '999' },
    ];
    expect(survivors(noted, now)).toEqual([20]);
  });
});
