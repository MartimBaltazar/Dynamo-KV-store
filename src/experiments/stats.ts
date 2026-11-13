export interface Summary {
  mean: number;
  /** Sample standard deviation across seeds. */
  sd: number;
  n: number;
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length;
  if (n === 0) return { mean: NaN, sd: NaN, n };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, n };
}

export function show(s: Summary, digits = 1): string {
  return s.n === 0 ? 'n/a' : `${s.mean.toFixed(digits)} ± ${s.sd.toFixed(digits)}`;
}

/** Renders rows as a GitHub-flavoured markdown table. */
export function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}
