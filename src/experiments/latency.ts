import type { SimEvent } from '../engine/types.ts';
import type { ClientRes } from '../store/client.ts';
import { createStoreCluster, isClient } from '../store/cluster.ts';
import { improvedRouting, type ClusterConfig } from '../store/messages.ts';
import { StoreMetrics } from '../store/metrics.ts';
import type { StoreNode } from '../store/node.ts';
import { show, summarize, table } from './stats.ts';

/**
 * Latency and load experiment: classic request handling against the improved
 * one (hedged reads, latency-aware routing, load cap, hot-key replicas), on
 * identical seeds, networks, faults and workloads.
 *
 * 10 nodes, 6 clients at 50 requests a second each, 90% reads, 200 keys. Every
 * replica read or write takes 5 ms of a node's time and nodes work on one at a
 * time, so a node saturates at 200 operations a second and queues beyond that.
 */

const SIZE = 10;
const CLIENTS = 6;
const SETTLE = 15_000;
const OBSERVE = 60_000;
const LOAD_CAP = 1.25;

const world: Partial<ClusterConfig> = { rate: 50, readRatio: 0.9, keys: 200, serviceTime: 5 };

export interface Scenario {
  /** Workload settings in force from the start. */
  config?: Partial<ClusterConfig>;
  /** Make one node's links 10x slower once the cluster has settled. */
  slowNode?: boolean;
  /** Share of all requests that suddenly go to one key once the cluster has settled. */
  viral?: number;
}

export interface Outcome {
  p50: number;
  p95: number;
  p99: number;
  /** p99 for requests on keys other than the viral one. */
  p99Others: number;
  failed: number;
  staleReads: number;
  /** Busiest node's replica operations over the average node's, across the window. */
  peakOverAvg: number;
  /** Seconds after the fault until the busiest node stays within the load cap; null if it never does. */
  settledAfter: number | null;
  hedgesPer100: number;
  messages: number;
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);

export function trial(seed: number, mode: Partial<ClusterConfig>, scenario: Scenario): Outcome {
  const sim = createStoreCluster({ seed, size: SIZE, clients: CLIENTS, config: { ...world, ...scenario.config, ...mode } });
  const metrics = new StoreMetrics();
  const stores = sim.nodeIds().filter((id) => !isClient(id));
  const latencies: number[] = [];
  const others: number[] = [];
  let failed = 0;
  let messages = 0;
  let requests = 0;
  let observing = false;
  sim.onEvent((e: SimEvent) => {
    if (!observing) return;
    metrics.onEvent(e);
    if (e.type === 'send') messages++;
    if (e.type !== 'state' || e.kind !== 'res') return;
    const res = e.data as ClientRes;
    requests++;
    // A failed request counts at the time the client gave up, so failures cannot hide in the percentiles.
    if (!res.ok) failed++;
    latencies.push(res.latency);
    if (res.key !== 'k0') others.push(res.latency);
  });

  sim.runUntil(SETTLE);
  observing = true;
  if (scenario.slowNode) sim.input({ type: 'slow', node: 'n3', factor: 10 });
  if (scenario.viral) sim.input({ type: 'config', patch: { hotShare: scenario.viral } });

  // Sample every node's work once a simulated second; judge balance over 5-second windows.
  const ops = () => stores.map((id) => (sim.getNode(id) as StoreNode).ops);
  const samples = [ops()];
  for (let t = SETTLE + 1000; t <= SETTLE + OBSERVE; t += 1000) {
    sim.runUntil(t);
    samples.push(ops());
  }
  const WINDOW = 5;
  const balanced: boolean[] = [];
  for (let i = WINDOW; i < samples.length; i++) {
    const delta = samples[i].map((v, n) => v - samples[i - WINDOW][n]);
    balanced.push(Math.max(...delta) <= (delta.reduce((a, b) => a + b, 0) / delta.length) * LOAD_CAP);
  }
  const total = samples.at(-1)!.map((v, n) => v - samples[0][n]);
  // End of the first 5-second window from which the busiest node stays within the cap for good.
  let first = balanced.length;
  while (first > 0 && balanced[first - 1]) first--;
  const settledAfter = first === balanced.length ? null : first + WINDOW;

  latencies.sort((a, b) => a - b);
  others.sort((a, b) => a - b);
  return {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    p99Others: percentile(others, 0.99),
    failed: (failed / Math.max(1, requests)) * 100,
    staleReads: metrics.staleReads,
    peakOverAvg: Math.max(...total) / (total.reduce((a, b) => a + b, 0) / total.length),
    settledAfter,
    hedgesPer100: (metrics.hedges / Math.max(1, requests)) * 100,
    messages,
  };
}

export const modes: Record<string, Partial<ClusterConfig>> = {
  classic: {},
  ours: improvedRouting,
};

export const ablation: Record<string, Partial<ClusterConfig>> = {
  classic: {},
  'hedged reads only': { hedge: 1 },
  'hedge + smart routing': { hedge: 1, smartRouting: 1 },
  'hedge + smart + load cap': { hedge: 1, smartRouting: 1, loadCap: LOAD_CAP },
  'all four (ours)': improvedRouting,
};

function run(seeds: number[], mode: Partial<ClusterConfig>, scenario: Scenario) {
  const o = seeds.map((seed) => trial(seed, mode, scenario));
  const col = (f: (x: Outcome) => number) => summarize(o.map(f).filter((v) => !Number.isNaN(v)));
  const settled = o.filter((x) => x.settledAfter !== null).map((x) => x.settledAfter!);
  return {
    p50: col((x) => x.p50),
    p95: col((x) => x.p95),
    p99: col((x) => x.p99),
    p99Others: col((x) => x.p99Others),
    failed: col((x) => x.failed),
    stale: col((x) => x.staleReads),
    peak: col((x) => x.peakOverAvg),
    hedges: col((x) => x.hedgesPer100),
    messages: col((x) => x.messages / 1000),
    settled: summarize(settled),
    neverSettled: o.length - settled.length,
  };
}

/** Runs the whole experiment and returns a markdown report. */
export function report(seedCount = 10): string {
  const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
  const each = <T>(variants: Record<string, Partial<ClusterConfig>>, scenario: Scenario, row: (name: string, r: ReturnType<typeof run>) => T) =>
    Object.entries(variants).map(([name, mode]) => row(name, run(seeds, mode, scenario)));
  const out: string[] = [];
  out.push('# Latency and load: classic request handling vs improved');
  out.push(
    `Generated by \`npm run experiment latency\`. ${SIZE} nodes, ${CLIENTS} clients at 50 requests/s each, 90% reads, 200 keys, N=3 R=2 W=2. ` +
      'Each replica read or write costs a node 5 ms and nodes do one at a time, so a node saturates at 200 operations/s. ' +
      `${seedCount} seeds per row, mean ± standard deviation. The cluster settles for ${SETTLE / 1000} s, then the fault is applied and ${OBSERVE / 1000} s are measured. ` +
      '"Ours" turns on hedged reads, latency-aware routing, the 1.25x load cap and hot-key replicas. Latencies are client-side, in ms; a failed request counts as the time until the client gave up.',
  );

  out.push('## One node 10x slower');
  out.push(table(['Mode', 'p50', 'p95', 'p99', 'Failed %'], each(modes, { slowNode: true }, (n, r) => [n, show(r.p50), show(r.p95), show(r.p99), show(r.failed, 2)])));

  out.push('## Skewed workload (zipf 1.2)');
  out.push(
    table(
      ['Mode', 'Busiest node / average', 'p50', 'p99', 'Failed %'],
      each(modes, { config: { zipf: 1.2 } }, (n, r) => [n, show(r.peak, 2), show(r.p50), show(r.p99), show(r.failed, 2)]),
    ),
  );

  out.push('## One key goes viral (half of all traffic)');
  out.push('"Balanced after" is how long until the busiest node stays within 1.25x the average for the rest of the run, judged over 5-second windows (so 5 is the best possible).');
  out.push(
    table(
      ['Mode', 'Busiest node / average', 'Balanced after (s)', 'Never balanced', 'p99, other keys', 'Failed %', 'Stale reads'],
      each(modes, { viral: 0.5 }, (n, r) => [n, show(r.peak, 2), show(r.settled), String(r.neverSettled), show(r.p99Others), show(r.failed, 2), show(r.stale)]),
    ),
  );

  out.push('## Normal load, no faults: what the improvements cost');
  out.push(
    table(
      ['Mode', 'Hedges per 100 requests', 'Messages (thousands)', 'p50', 'p99', 'Stale reads'],
      each(modes, {}, (n, r) => [n, show(r.hedges, 2), show(r.messages), show(r.p50), show(r.p99), show(r.stale)]),
    ),
  );

  out.push('## Which part does the work');
  const rows: string[][] = [];
  for (const [name, mode] of Object.entries(ablation)) {
    const slow = run(seeds, mode, { slowNode: true });
    const viral = run(seeds, mode, { viral: 0.5 });
    rows.push([name, show(slow.p99), show(viral.peak, 2), show(viral.p99Others), show(viral.failed, 2)]);
  }
  out.push(table(['Mode', 'Slow node: p99', 'Viral key: busiest / average', 'Viral key: p99, other keys', 'Viral key: failed %'], rows));

  return out.join('\n\n') + '\n';
}
