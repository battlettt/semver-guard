import type { BreakingChange, CompareResult } from './model.js';

export type OutputFormat = 'table' | 'json';

export function formatJson(result: CompareResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

/** Renders a human-readable report with one row per breaking change. */
export function formatTable(result: CompareResult): string {
  const { summary } = result;
  const compared = `${summary.exportsBefore} export${summary.exportsBefore === 1 ? '' : 's'} in ${summary.filesBefore} file${summary.filesBefore === 1 ? '' : 's'}`;
  const header = `semver-guard: ${result.from} -> ${result.to} (${compared} checked)`;

  const accepted =
    summary.accepted !== undefined && summary.accepted > 0
      ? `\n${summary.accepted} accepted breaking change${summary.accepted === 1 ? ' was' : 's were'} suppressed by the baseline.`
      : '';

  if (result.changes.length === 0) {
    return `${header}\n\nNo breaking changes found.${accepted}\n`;
  }

  const headings = ['CHANGE', 'EXPORT', 'FILE', 'DETAILS'];
  const rows = result.changes.map((c) => [c.code, exportLabel(c), c.file, c.message]);
  const widths = [0, 1, 2].map((i) => Math.max(headings[i].length, ...rows.map((r) => r[i].length)));
  const indent = widths.reduce((sum, w) => sum + w + 2, 0);

  const pad = (cells: string[]) =>
    cells
      .map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]) : cell))
      .join('  ')
      .trimEnd();

  const lines = [header, '', pad(headings)];
  result.changes.forEach((change, i) => {
    lines.push(pad(rows[i]));
    if (change.before !== undefined) lines.push(`${' '.repeat(indent)}before: ${change.before}`);
    if (change.after !== undefined) lines.push(`${' '.repeat(indent)}after:  ${change.after}`);
    if (change.reexportedBy !== undefined) {
      lines.push(`${' '.repeat(indent)}also re-exported by: ${change.reexportedBy.join(', ')}`);
    }
  });

  const count = result.changes.length;
  lines.push(
    '',
    `${count} breaking change${count === 1 ? '' : 's'} found. Releasing this as a minor or patch version would break consumers; bump the major version.${accepted}`,
  );
  return lines.join('\n') + '\n';
}

function exportLabel(change: BreakingChange): string {
  return change.member !== undefined ? `${change.export}#${change.member}` : change.export;
}
