import { defaultNetwork, type NetworkConfig } from '../engine/network.ts';
import type { Input, NodeId, SimEvent } from '../engine/types.ts';
import { hash32 } from '../ring/hash.ts';
import { Ring } from '../ring/ring.ts';
import type { Status } from '../swim/membership.ts';
import { SwimMetrics } from '../swim/metrics.ts';
import { createStoreCluster, isClient, type StoreSim } from '../store/cluster.ts';
import type { ClusterConfig } from '../store/messages.ts';
import { StoreMetrics } from '../store/metrics.ts';
import type { StoreNode } from '../store/node.ts';
import { fingerprint } from '../store/vclock.ts';
import { Narrator } from './narrator.ts';
import type { KeyDot, Packet, RingView } from './ringView.ts';
import { laneConfig, type MetricKey, type Scenario } from './scenarios.ts';

const LOAD_WINDOW = 5000;
const MAX_EVENTS_PER_FRAME = 20_000;

/** Three packet families on screen; pings and gossip stay hidden. */
const packetClass: Record<string, string> = {
  get: 'client',
  put: 'client',
  'get-res': 'client',
  'put-res': 'client',
  store: 'rep',
  fetch: 'rep',
  'store-ack': 'rep',
  'fetch-res': 'rep',
  repair: 'repair',
  handoff: 'repair',
  'handoff-ack': 'repair',
  'ae-check': 'repair',
  'ae-sync': 'repair',
};

export interface MetricValue {
  text: string;
  /** For comparing Classic with Improved; undefined when there is nothing to compare. */
  n?: number;
}

export interface LaneUi {
  selected: ReadonlySet<NodeId>;
  selectedKey: string | null;
}

/**
 * One simulated cluster with its metrics, caption and (optionally) picture.
 * The page runs two of them side by side: same seed, same faults, one with
 * classic Dynamo and one with both improvements.
 */
export class Lane {
  readonly improved: boolean;
  sim!: StoreSim;
  cfg!: ClusterConfig;
  net!: NetworkConfig;
  storeIds: NodeId[] = [];
  readonly narrator: Narrator;
  private readonly view: RingView | null;
  private swim!: SwimMetrics;
  private metrics!: StoreMetrics;
  private ring!: Ring;
  private packets: Packet[] = [];
  private keyDots: KeyDot[] = [];
  private opsHistory: { t: number; ops: number[] }[] = [];
  private belief = new Map<NodeId, Status>();
  private lastSlow = -Infinity;
  private opening = '';

  constructor(improved: boolean, view: RingView | null) {
    this.improved = improved;
    this.view = view;
    this.narrator = new Narrator({
      isUp: (id) => this.sim.isUp(id),
      slowNodes: () => this.storeIds.filter((id) => this.sim.network.slow.has(id)),
    });
  }

  start(s: Scenario, size = s.size): void {
    this.cfg = laneConfig(s, this.improved);
    this.net = { ...defaultNetwork, ...s.network };
    this.sim = createStoreCluster({ seed: s.seed, size, clients: 2, config: this.cfg, network: this.net, logLimit: 1000 });
    this.swim = new SwimMetrics((id) => !isClient(id));
    this.metrics = new StoreMetrics();
    this.storeIds = this.sim.nodeIds().filter((id) => !isClient(id));
    this.ring = new Ring(this.storeIds, this.cfg.vnodes);
    this.packets = [];
    this.keyDots = [];
    this.opsHistory = [];
    this.belief.clear();
    this.lastSlow = -Infinity;
    this.opening = s.story;
    this.narrator.reset(s.story);
    this.view?.setNodes(this.storeIds, this.sim.nodeIds().filter(isClient));
    this.sim.onEvent((e) => this.onEvent(e));
  }

  get now(): number {
    return this.sim.now;
  }

  /** Applies a fault or change right now, and keeps our copy of the settings current. */
  input(i: Input): void {
    if (i.type === 'config') Object.assign(this.cfg, i.patch);
    if (i.type === 'network') Object.assign(this.net, i.patch);
    this.sim.input(i);
  }

  runUntil(t: number): void {
    this.sim.runUntil(t, MAX_EVENTS_PER_FRAME);
  }

  ownersOf(key: string): NodeId[] {
    return this.ring.preferenceList(key, Math.round(this.cfg.n));
  }

  private store(id: NodeId): StoreNode {
    return this.sim.getNode(id) as StoreNode;
  }

  private onEvent(e: SimEvent): void {
    this.swim.onEvent(e);
    this.metrics.onEvent(e);
    this.narrator.onEvent(e);
    if (e.type !== 'send' && e.type !== 'drop') return;
    if (e.type === 'drop' && e.reason === 'down') return;
    const cls = packetClass[e.kind];
    if (!cls) return;
    const lost = e.type === 'drop';
    this.packets.push({ from: e.from, to: e.to, cls, t0: e.t, t1: lost ? e.t + this.sim.network.config.latencyMean : e.arrive, lost });
  }

  /** Red if most live peers think it is dead, amber if any doubt it, green otherwise. */
  believed(id: NodeId): Status {
    let voters = 0;
    let dead = 0;
    let doubt = 0;
    for (const o of this.storeIds) {
      if (o === id || !this.sim.isUp(o)) continue;
      voters++;
      const b = this.swim.belief(o, id)?.status;
      if (b === 'dead') dead++;
      if (b && b !== 'alive') doubt++;
    }
    if (voters > 0 && dead * 2 > voters) return 'dead';
    return doubt > 0 ? 'suspect' : 'alive';
  }

  /** One sentence about the present state, for when nothing new is happening. */
  describe(): string {
    const down = this.storeIds.filter((id) => !this.sim.isUp(id));
    if (down.length) return `${down.join(', ')} ${down.length > 1 ? 'are' : 'is'} down. Requests still work through the other copies.`;
    const slow = this.storeIds.filter((id) => this.sim.network.slow.has(id));
    if (slow.length) return `${slow.join(', ')} ${slow.length > 1 ? 'are' : 'is'} slow. ${slow.length > 1 ? 'They' : 'It'} still answer${slow.length > 1 ? '' : 's'}, just late.`;
    if (this.sim.network.partitions.length) return 'The network is split into two groups.';
    if (this.net.loss > 0) return `${Math.round(this.net.loss * 100)}% of packets are lost. Watch for healthy nodes turning amber or red.`;
    if (this.cfg.hotShare > 0) {
      const share = `${Math.round(this.cfg.hotShare * 100)}% of requests ask for k0`;
      return this.improved ? `${share}. Extra copies share the load.` : `${share}, so the ${Math.round(this.cfg.n)} nodes holding it do most of the work.`;
    }
    return 'All nodes are healthy.';
  }

  /** Busiest live node's work over the last few seconds, against the average. */
  private loadRatio(): number {
    if (this.opsHistory.length < 2) return NaN;
    const first = this.opsHistory[0];
    const latest = this.opsHistory[this.opsHistory.length - 1];
    const delta = this.storeIds.map((_, i) => latest.ops[i] - first.ops[i]).filter((_, i) => this.sim.isUp(this.storeIds[i]));
    const avg = delta.reduce((a, b) => a + b, 0) / Math.max(1, delta.length);
    return avg < 1 ? NaN : Math.max(...delta) / avg;
  }

  /** The seven numbers under the rings. */
  readings(): Record<MetricKey, MetricValue> {
    const m = this.metrics;
    const p99 = m.percentile(0.99);
    const load = this.loadRatio();
    const f = this.swim.failures.at(-1);
    const divergent = this.keyDots.filter((k) => k.state === 'divergent').length;
    const s = (t: number) => `${(t / 1000).toFixed(1)}s`;
    return {
      avail: { text: `${(m.availability * 100).toFixed(1)}%`, n: m.availability },
      p99: { text: Number.isNaN(p99) ? 'n/a' : `${Math.round(p99)} ms`, n: Number.isNaN(p99) ? undefined : p99 },
      stale: { text: String(m.staleReads), n: m.staleReads },
      divergent: { text: `${divergent} of ${this.keyDots.length}`, n: divergent },
      load: { text: Number.isNaN(load) ? 'n/a' : `${load.toFixed(2)}x`, n: Number.isNaN(load) ? undefined : load },
      detect: { text: !f ? 'n/a' : f.allDead === undefined ? 'not yet' : s(f.allDead), n: f?.allDead },
      falseDead: { text: String(this.swim.falseDeads), n: this.swim.falseDeads },
    };
  }

  /** Per-key comparison and belief changes; too heavy for every frame, so a few times a second. */
  private refresh(): void {
    this.opsHistory.push({ t: this.sim.now, ops: this.storeIds.map((id) => this.store(id).ops) });
    while (this.opsHistory.length > 2 && this.opsHistory[1].t <= this.sim.now - LOAD_WINDOW) this.opsHistory.shift();
    const keys = new Set<string>();
    for (const id of this.storeIds) for (const k of this.store(id).replica.keys()) keys.add(k);
    this.keyDots = [...keys].map((k) => {
      const held = this.ownersOf(k).map((id) => this.store(id).replica.get(k));
      const state: KeyDot['state'] = new Set(held.map(fingerprint)).size > 1 ? 'divergent' : held.some((v) => v.length > 1) ? 'siblings' : 'ok';
      return { key: k, at: hash32(k) / 2 ** 32, state };
    });
    for (const id of this.storeIds) {
      const b = this.believed(id);
      const was = this.belief.get(id) ?? 'alive';
      this.belief.set(id, b);
      if (b === 'dead' && was !== 'dead') this.narrator.majorityDead(id, true);
      else if (b !== 'dead' && was === 'dead') this.narrator.majorityDead(id, false);
    }
  }

  /** The sentence for under the ring. */
  caption(wall: number): string {
    return this.narrator.current(wall, () => this.describe());
  }

  draw(wall: number, ui: LaneUi): void {
    if (!this.view) return;
    const now = this.sim.now;
    this.packets = this.packets.filter((p) => p.t1 >= now);
    if (wall - this.lastSlow > 200) {
      this.lastSlow = wall;
      this.refresh();
    }
    const isolated = new Set(this.sim.network.partitions.flat());
    this.view.render({
      now,
      packets: this.packets,
      selected: ui.selected,
      keys: this.keyDots,
      selectedKey: ui.selectedKey,
      owners: ui.selectedKey ? this.ownersOf(ui.selectedKey) : [],
      isUp: (id) => this.sim.isUp(id),
      isSlow: (id) => this.sim.network.slow.has(id),
      isIsolated: (id) => isolated.has(id),
      status: (id) => this.believed(id),
    });
  }

  /** Headless hook for tests and the metrics table: refresh derived state now. */
  settle(): void {
    this.refresh();
  }

  get openingLine(): string {
    return this.opening;
  }
}
