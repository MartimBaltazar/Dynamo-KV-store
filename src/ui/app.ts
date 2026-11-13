import { defaultNetwork, type NetworkConfig } from '../engine/network.ts';
import type { NodeId, SimEvent } from '../engine/types.ts';
import { hash32 } from '../ring/hash.ts';
import { Ring } from '../ring/ring.ts';
import type { Status, Update } from '../swim/membership.ts';
import { SwimMetrics } from '../swim/metrics.ts';
import { improvedDetector } from '../swim/node.ts';
import { createStoreCluster, defaultClusterConfig, isClient, type StoreSim } from '../store/cluster.ts';
import { improvedRouting, type ClientRequest, type ClusterConfig } from '../store/messages.ts';
import { StoreMetrics } from '../store/metrics.ts';
import type { StoreNode } from '../store/node.ts';
import { fingerprint } from '../store/vclock.ts';
import { button, checkbox, hint, numberField, readout, row, section, slider } from './controls.ts';
import { MerkleView } from './merkleView.ts';
import { RingView, type KeyDot, type Packet } from './ringView.ts';

const MAX_EVENTS_PER_FRAME = 20_000;
const LOG_LINES = 80;
const CLIENTS = 2;
const LOAD_WINDOW = 5000;

/** Everything that separates "Improved" from "Classic Dynamo". */
const improvements: Record<string, number> = { ...improvedDetector, ...improvedRouting };

// Settings survive a reset; the simulation itself does not.
const cfg: ClusterConfig = { ...defaultClusterConfig };
const net: NetworkConfig = { ...defaultNetwork };
let seed = 1;
let size = 10;
let playing = true;
let speed = 1;
let showGossip = false;

let sim!: StoreSim;
let swimMetrics!: SwimMetrics;
let storeMetrics!: StoreMetrics;
let storeIds: NodeId[] = [];
let ring!: Ring;
let packets: Packet[] = [];
let logLines: { cls: string; text: string }[] = [];
let logDirty = true;
let carry = 0;
let keyDots: KeyDot[] = [];
let opsHistory: { t: number; ops: number[] }[] = [];
let lastSlowRender = 0;
let selectedKey: string | null = null;
const selected = new Set<NodeId>();

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const view = new RingView(
  $<SVGSVGElement>('#ring'),
  (id) => {
    if (id === null) selected.clear();
    else if (!selected.delete(id)) selected.add(id);
    lastSlowRender = 0;
  },
  (key) => {
    selectedKey = selectedKey === key ? null : key;
    lastSlowRender = 0;
  },
);

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const store = (id: NodeId) => sim.getNode(id) as StoreNode;
const ownersOf = (key: string) => ring.preferenceList(key, Math.round(cfg.n));
const isImproved = () => cfg.phi === 1 && cfg.hedge === 1;

/** Three packet families on screen; gossip is hidden unless asked for. */
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

function reset(): void {
  sim = createStoreCluster({ seed, size, clients: CLIENTS, config: cfg, network: net, logLimit: 5000 });
  swimMetrics = new SwimMetrics((id) => !isClient(id));
  storeMetrics = new StoreMetrics();
  storeIds = sim.nodeIds().filter((id) => !isClient(id));
  ring = new Ring(storeIds, cfg.vnodes);
  packets = [];
  logLines = [];
  keyDots = [];
  opsHistory = [];
  carry = 0;
  selectedKey = null;
  selected.clear();
  view.setNodes(storeIds, sim.nodeIds().filter(isClient));
  sim.onEvent(onEvent);
}

function onEvent(e: SimEvent): void {
  swimMetrics.onEvent(e);
  storeMetrics.onEvent(e);
  switch (e.type) {
    case 'send':
    case 'drop': {
      if (e.type === 'drop' && e.reason === 'down') break;
      const cls = packetClass[e.kind] ?? 'gossip';
      if (cls === 'gossip' && !showGossip) break;
      const lost = e.type === 'drop';
      packets.push({ from: e.from, to: e.to, cls, t0: e.t, t1: lost ? e.t + sim.network.config.latencyMean : e.arrive, lost });
      break;
    }
    case 'state': {
      if (e.kind === 'member') {
        const u = e.data as Update;
        if (u.id === e.node) {
          if (u.inc > 0) addLog('alive', `${secs(e.t)}  ${e.node} says it is alive after all`);
        } else if (u.status !== 'alive' || u.inc > 0) {
          addLog(u.status, `${secs(e.t)}  ${e.node} now thinks ${u.id} is ${u.status}`);
        }
      } else if (e.kind === 'repair') {
        const d = e.data as { key: string; to: NodeId[] };
        addLog('repair', `${secs(e.t)}  read repair fixed ${d.key} on ${d.to.join(', ')}`);
      } else if (e.kind === 'handoff') {
        const d = e.data as { from: NodeId; keys: number };
        addLog('repair', `${secs(e.t)}  ${d.from} handed ${d.keys} held write(s) back to ${e.node}`);
      } else if (e.kind === 'ae') {
        const d = e.data as { peer: NodeId; changed: number };
        if (d.changed) addLog('repair', `${secs(e.t)}  background check fixed ${d.changed} key(s) on ${e.node}`);
      }
      break;
    }
    case 'input': {
      const i = e.input;
      const what =
        i.type === 'kill' || i.type === 'restart'
          ? `${i.type} ${i.node}`
          : i.type === 'partition'
            ? `isolate ${i.groups[0].join(', ')}`
            : i.type === 'slow'
              ? `${i.node} ${i.factor === 1 ? 'back to normal speed' : `${i.factor}x slower`}`
              : i.type === 'heal'
                ? 'heal partition'
                : null;
      if (what) addLog('input', `${secs(e.t)}  > ${what}`);
      break;
    }
  }
}

function addLog(cls: string, text: string): void {
  logLines.push({ cls, text });
  if (logLines.length > LOG_LINES * 2) logLines = logLines.slice(-LOG_LINES);
  logDirty = true;
}

/** Red if most live peers think it is dead, amber if any doubt it, green otherwise. */
function believed(id: NodeId): Status {
  let voters = 0;
  let dead = 0;
  let doubt = 0;
  for (const o of storeIds) {
    if (o === id || !sim.isUp(o)) continue;
    voters++;
    const b = swimMetrics.belief(o, id)?.status;
    if (b === 'dead') dead++;
    if (b && b !== 'alive') doubt++;
  }
  if (voters > 0 && dead * 2 > voters) return 'dead';
  return doubt > 0 ? 'suspect' : 'alive';
}

/** Applies a config change live, as a recorded input. */
function apply(patch: Partial<ClusterConfig>): void {
  Object.assign(cfg, patch);
  sim.input({ type: 'config', patch: patch as Record<string, number> });
}

// --- sidebar ---------------------------------------------------------------

const side = $<HTMLElement>('#side');

const run = section(side, 'Run');
const runRow = row(run);
const playBtn = button(runRow, 'Pause', () => {
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
}, 'primary');
button(runRow, 'Step', () => {
  playing = false;
  playBtn.textContent = 'Play';
  sim.step();
});
button(runRow, 'Reset', reset);
slider(run, { label: 'Speed', min: -1, max: 2, step: 0.05, value: 0, format: (v) => `${(10 ** v).toFixed(v < 0 ? 2 : 1)}x` }, (v) => {
  speed = 10 ** v;
});

const modeSec = section(side, 'Mode');
const modeRow = row(modeSec);
const classicBtn = button(modeRow, 'Classic Dynamo', () => setImproved(false));
const improvedBtn = button(modeRow, 'Improved', () => setImproved(true));
const modeHint = hint(modeSec, '');
function setImproved(on: boolean): void {
  apply(Object.fromEntries(Object.entries(improvements).map(([k, v]) => [k, on ? v : 0])));
  syncMode();
}
function syncMode(): void {
  const on = isImproved();
  classicBtn.className = on ? '' : 'primary';
  improvedBtn.className = on ? 'primary' : '';
  modeHint.textContent = on
    ? 'Fewer false "dead" calls; reads avoid slow nodes; popular keys get extra copies.'
    : 'Fixed timeouts; every read asks all replicas; popular keys stay on 3 nodes.';
}
syncMode();

const faults = section(side, 'Break things');
const faultHint = hint(faults, '');
const faultRow = row(faults);
const each = (fn: (id: NodeId) => void) => () => [...selected].forEach(fn);
const killBtn = button(faultRow, 'Kill', each((id) => sim.input({ type: 'kill', node: id })), 'danger');
const restartBtn = button(faultRow, 'Restart', each((id) => sim.input({ type: 'restart', node: id })));
const slowBtn = button(faultRow, 'Slow', each((id) => sim.input({ type: 'slow', node: id, factor: sim.network.slow.has(id) ? 1 : 10 })));
const isolateBtn = button(faultRow, 'Isolate', () => sim.input({ type: 'partition', groups: [[...selected]] }));
const healBtn = button(faultRow, 'Heal', () => sim.input({ type: 'heal' }));

function syncButtons(): void {
  const ids = [...selected];
  killBtn.disabled = !ids.some((id) => sim.isUp(id));
  restartBtn.disabled = !ids.some((id) => !sim.isUp(id));
  isolateBtn.disabled = ids.length === 0 || ids.length === sim.nodeIds().length;
  slowBtn.disabled = ids.length === 0;
  healBtn.disabled = sim.network.partitions.length === 0;
  const text = ids.length ? `Selected: ${ids.join(', ')}` : 'Tap nodes to select them.';
  if (faultHint.textContent !== text) faultHint.textContent = text;
}

const quorum = section(side, 'Copies');
const nrwSlider = (key: 'n' | 'r' | 'w', label: string) =>
  slider(quorum, { label, min: 1, max: 5, step: 1, value: cfg[key] }, (v) => apply({ [key]: v }));
nrwSlider('n', 'Copies of each key (N)');
nrwSlider('r', 'Copies a read waits for (R)');
nrwSlider('w', 'Copies a write waits for (W)');
const quorumHint = hint(quorum, '');

const stats = section(side, 'Metrics');
const showMetrics = readout(stats, {
  avail: 'Requests that succeeded',
  p99: 'Slowest 1% of requests',
  stale: 'Reads that missed a write',
  divergent: 'Keys whose copies disagree',
  load: 'Busiest node vs average',
  detect: 'Time to notice last failure',
  falseDead: 'Healthy nodes called dead',
});

const keySec = section(side, 'Key');
const keyHint = hint(keySec, '');
const versionsEl = document.createElement('div');
versionsEl.className = 'versions';
keySec.appendChild(versionsEl);
const keyRow = row(keySec);
const ask = (client: number, payload: ClientRequest) => sim.input({ type: 'request', node: `c${client}`, payload });
const getBtn = button(keyRow, 'Read', () => ask(0, { op: 'get', key: selectedKey! }));
const putBtn = button(keyRow, 'Write', () => ask(0, { op: 'put', key: selectedKey! }));
const clashBtn = button(keyRow, 'Two writes at once', () => {
  // Two clients write through two different coordinators: guaranteed conflicting versions.
  const [a, b] = ownersOf(selectedKey!);
  ask(0, { op: 'put', key: selectedKey!, blind: true, via: a });
  ask(1, { op: 'put', key: selectedKey!, blind: true, via: b ?? a });
});

const settings = section(side, 'Settings', false);
const cfgSlider = (key: keyof ClusterConfig, label: string, min: number, max: number, step: number, unit = '', scale = 1) =>
  slider(settings, { label, min, max, step, value: cfg[key] * scale, format: (v) => `${v}${unit}` }, (v) => apply({ [key]: v / scale }));
const cfgToggle = (key: keyof ClusterConfig, label: string) => checkbox(settings, label, cfg[key] === 1, (on) => apply({ [key]: on ? 1 : 0 }));
cfgToggle('sloppy', 'Stand-ins cover for dead owners');
cfgToggle('hintedHandoff', 'Stand-ins hand writes back');
cfgToggle('readRepair', 'Reads fix stale copies');
checkbox(settings, 'Background copy checks (Merkle)', cfg.antiEntropyInterval > 0, (on) => apply({ antiEntropyInterval: on ? 5000 : 0 }));
cfgSlider('rate', 'Requests per client', 0, 50, 1, ' /s');
cfgSlider('readRatio', 'Share of reads', 0, 100, 5, '%', 100);
cfgSlider('zipf', 'Key popularity skew', 0, 2, 0.1);
slider(settings, { label: 'Network latency', min: 0, max: 500, step: 5, value: net.latencyMean, format: (v) => `${v} ms` }, (v) => {
  net.latencyMean = v;
  sim.input({ type: 'network', patch: { latencyMean: v } });
});
slider(settings, { label: 'Packet loss', min: 0, max: 80, step: 1, value: net.loss * 100, format: (v) => `${v}%` }, (v) => {
  net.loss = v / 100;
  sim.input({ type: 'network', patch: { loss: net.loss } });
});
cfgSlider('suspectTimeout', 'Wait before calling a node dead', 200, 15_000, 100, ' ms');
checkbox(settings, 'Show gossip packets', showGossip, (on) => (showGossip = on));
slider(settings, { label: 'Nodes (resets)', min: 3, max: 40, step: 1, value: size }, (v) => {
  size = v;
  reset();
});
numberField(settings, 'Seed (resets)', seed, (v) => {
  seed = v;
  reset();
});

const inspect = section(side, 'Inspect', false);
const merkle = new MerkleView(inspect);
const logEl = document.createElement('div');
logEl.id = 'log';
inspect.appendChild(logEl);

// --- frame loop ------------------------------------------------------------

const statusEl = $<HTMLElement>('#status');
let last = performance.now();

function frame(t: number): void {
  const dt = Math.min(100, t - last);
  last = t;
  if (playing) {
    carry += dt * speed;
    const whole = Math.floor(carry);
    if (whole > 0) {
      carry -= whole;
      if (!sim.runUntil(sim.now + whole, MAX_EVENTS_PER_FRAME)) carry = 0;
    }
  }
  render(t);
  requestAnimationFrame(frame);
}

/** Busiest live node's work over the last few seconds, against the average. */
function loadRatio(): string {
  opsHistory.push({ t: sim.now, ops: storeIds.map((id) => store(id).ops) });
  while (opsHistory.length > 2 && opsHistory[1].t <= sim.now - LOAD_WINDOW) opsHistory.shift();
  const [first, latest] = [opsHistory[0], opsHistory[opsHistory.length - 1]];
  const delta = storeIds.map((_, i) => latest.ops[i] - first.ops[i]).filter((_, i) => sim.isUp(storeIds[i]));
  const avg = delta.reduce((a, b) => a + b, 0) / Math.max(1, delta.length);
  return avg < 1 ? 'n/a' : `${(Math.max(...delta) / avg).toFixed(2)}x`;
}

/** Per-key comparison; too heavy for every frame, so refreshed a few times a second. */
function slowRender(): void {
  const keys = new Set<string>();
  for (const id of storeIds) for (const k of store(id).replica.keys()) keys.add(k);
  keyDots = [...keys].map((k) => {
    const held = ownersOf(k).map((id) => store(id).replica.get(k));
    const state: KeyDot['state'] = new Set(held.map(fingerprint)).size > 1 ? 'divergent' : held.some((v) => v.length > 1) ? 'siblings' : 'ok';
    return { key: k, at: hash32(k) / 2 ** 32, state };
  });

  const m = storeMetrics;
  const f = swimMetrics.failures.at(-1);
  const p99 = m.percentile(0.99);
  showMetrics({
    avail: `${(m.availability * 100).toFixed(1)}%`,
    p99: Number.isNaN(p99) ? 'n/a' : `${Math.round(p99)} ms`,
    stale: String(m.staleReads),
    divergent: `${keyDots.filter((k) => k.state === 'divergent').length} of ${keyDots.length}`,
    load: loadRatio(),
    detect: !f ? 'n/a' : f.allDead === undefined ? 'not yet' : secs(f.allDead),
    falseDead: String(swimMetrics.falseDeads),
  });

  quorumHint.textContent =
    cfg.r > cfg.n || cfg.w > cfg.n
      ? 'R or W is more than N: those requests can never succeed.'
      : cfg.r + cfg.w > cfg.n
        ? 'R + W > N: every read sees the latest write.'
        : 'R + W ≤ N: reads can miss the latest write.';

  getBtn.disabled = putBtn.disabled = clashBtn.disabled = selectedKey === null;
  if (selectedKey === null) {
    keyHint.textContent = 'Tap a dot on the inner circle to see where that key lives.';
    versionsEl.replaceChildren();
  } else {
    keyHint.textContent = `${selectedKey} is stored on:`;
    versionsEl.replaceChildren(
      ...ownersOf(selectedKey).map((id) => {
        const line = document.createElement('div');
        const versions = store(id).replica.get(selectedKey!);
        if (versions.length > 1) line.className = 'sib';
        const name = document.createElement('b');
        name.textContent = `${id}: `;
        line.append(name, versions.length ? versions.map((v) => v.value).join('  or  ') : '(nothing)');
        return line;
      }),
    );
  }

  const pair = [...selected].filter((id) => !isClient(id));
  if (pair.length === 2) {
    const [a, b] = pair;
    merkle.render({ a, b, treeA: store(a).replica.tree(store(a).sharedWith(b)), treeB: store(b).replica.tree(store(b).sharedWith(a)) });
  } else merkle.render(null);
}

function render(wall: number): void {
  const now = sim.now;
  packets = packets.filter((p) => p.t1 >= now);
  if (wall - lastSlowRender > 200) {
    lastSlowRender = wall;
    slowRender();
  }
  const isolated = new Set(sim.network.partitions.flat());

  view.render({
    now,
    packets,
    selected,
    keys: keyDots,
    selectedKey,
    owners: selectedKey ? ownersOf(selectedKey) : [],
    isUp: (id) => sim.isUp(id),
    isSlow: (id) => sim.network.slow.has(id),
    isIsolated: (id) => isolated.has(id),
    status: believed,
  });

  const text = `t = ${secs(now)} · ${swimMetrics.up.size}/${swimMetrics.all.length} nodes up · ${isImproved() ? 'Improved' : 'Classic Dynamo'}`;
  if (statusEl.textContent !== text) statusEl.textContent = text;

  if (logDirty) {
    logDirty = false;
    logEl.replaceChildren(
      ...logLines.slice(-LOG_LINES).map((l) => {
        const div = document.createElement('div');
        div.className = l.cls;
        div.textContent = l.text;
        return div;
      }),
    );
    logEl.scrollTop = logEl.scrollHeight;
  }
  syncButtons();
}

reset();
requestAnimationFrame(frame);
