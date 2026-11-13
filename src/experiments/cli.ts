import { mkdirSync, writeFileSync } from 'node:fs';
import { report as detection } from './detection.ts';
import { report as latency } from './latency.ts';

// Usage: node src/experiments/cli.ts [detection|latency] [seeds] [--write]
const args = process.argv.slice(2);
const which = args.includes('latency') ? 'latency' : 'detection';
const seeds = args.find((a) => /^\d+$/.test(a));
const text = which === 'latency' ? latency(seeds ? Number(seeds) : 10) : detection(seeds ? Number(seeds) : 20);
if (args.includes('--write')) {
  const file = which === 'latency' ? 'experiments/latency-and-load.md' : 'experiments/failure-detection.md';
  mkdirSync('experiments', { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${file}`);
} else {
  console.log(text);
}
