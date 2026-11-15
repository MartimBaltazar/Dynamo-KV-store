import type { NetworkConfig } from '../engine/network.ts';
import type { ScriptedInput } from '../engine/types.ts';
import { improvedDetector } from '../swim/node.ts';
import { defaultClusterConfig } from '../store/cluster.ts';
import { improvedRouting, type ClusterConfig } from '../store/messages.ts';

/** The seven numbers shown under the rings. */
export type MetricKey = 'avail' | 'p99' | 'stale' | 'divergent' | 'load' | 'detect' | 'falseDead';

/**
 * A story: a cluster setup plus a timed script of faults. Both lanes (Classic
 * and Improved) get exactly the same seed, setup and script, so any difference
 * between them comes from the algorithms alone.
 */
export interface Scenario {
  id: string;
  title: string;
  /** One sentence: what happens. */
  story: string;
  /** One sentence: what to look at. */
  watch: string;
  seed: number;
  size: number;
  config: Partial<ClusterConfig>;
  network: Partial<NetworkConfig>;
  script: ScriptedInput[];
  /** Metrics that tell this story; shown first. */
  highlight: MetricKey[];
}

export const scenarios: Scenario[] = [
  {
    id: 'node-dies',
    title: 'A node dies',
    story: 'n3 crashes at 1.5 s and comes back at 20 s with its old data.',
    watch: 'Writes meant for n3 are parked on a stand-in, then handed back. Nothing is lost.',
    seed: 1,
    size: 8,
    config: { rate: 2 },
    network: {},
    script: [
      { t: 1500, input: { type: 'kill', node: 'n3' } },
      { t: 20_000, input: { type: 'restart', node: 'n3' } },
    ],
    highlight: ['avail', 'stale', 'divergent', 'detect'],
  },
  {
    id: 'packet-loss',
    title: 'Packet loss',
    story: 'No node fails, but the network drops 25% of all packets.',
    watch: 'Does the cluster wrongly decide that a healthy node is dead? (Give it a minute, or use Fast.)',
    seed: 1,
    size: 12,
    config: { rate: 2 },
    network: { loss: 0.25 },
    script: [],
    highlight: ['falseDead'],
  },
  {
    id: 'slow-node',
    title: 'Slow node',
    story: 'n3 becomes 10 times slower at 3 s. It is alive, just sluggish.',
    watch: 'Requests that depend on n3 get slow. Can the cluster route around it?',
    seed: 1,
    size: 8,
    config: { rate: 8 },
    network: {},
    script: [{ t: 3000, input: { type: 'slow', node: 'n3', factor: 10 } }],
    highlight: ['p99', 'avail'],
  },
  {
    id: 'viral-key',
    title: 'Viral key',
    story: 'At 1.5 s, half of all requests suddenly ask for the same key, k0.',
    watch: 'The 3 nodes holding k0 get swamped. Can the load spread out?',
    seed: 1,
    size: 8,
    config: { rate: 50, readRatio: 0.9 },
    network: {},
    script: [{ t: 1500, input: { type: 'config', patch: { hotShare: 0.5 } } }],
    highlight: ['load', 'p99'],
  },
];

const classicOff = Object.fromEntries(Object.keys({ ...improvedDetector, ...improvedRouting }).map((k) => [k, 0]));

/** The full config for one lane. "Improved" turns on both improvements at once. */
export function laneConfig(s: Scenario, improved: boolean): ClusterConfig {
  const on = { ...improvedDetector, ...improvedRouting };
  return { ...defaultClusterConfig, ...s.config, ...(improved ? on : classicOff) } as ClusterConfig;
}
