/**
 * Tiny markdown helpers. No deps, just enough to render a readable report
 * suitable for pasting into Slack / a PR description.
 */

export function mdTable(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const escape = (cell: string | number | null | undefined): string => {
    if (cell === null || cell === undefined) return '';
    const s = String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return s.length === 0 ? '' : s;
  };
  const head = `| ${headers.map(escape).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(escape).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

export function mdNum(n: number | null | undefined, digits = 3): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '-∞';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) return n.toFixed(0);
  // For small magnitudes, drop into scientific notation so the value is legible
  // instead of rounding to "0.0000".
  if (abs < Math.pow(10, -digits)) return n.toExponential(2);
  return n.toFixed(digits);
}

export function mdCode(s: string): string {
  return '`' + s + '`';
}
