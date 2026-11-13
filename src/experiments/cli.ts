import { mkdirSync, writeFileSync } from 'node:fs';
import { report } from './detection.ts';

// Usage: node src/experiments/cli.ts [seeds] [--write]
const seeds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20);
const text = report(seeds);
if (process.argv.includes('--write')) {
  mkdirSync('experiments', { recursive: true });
  writeFileSync('experiments/failure-detection.md', text);
  console.log('wrote experiments/failure-detection.md');
} else {
  console.log(text);
}
