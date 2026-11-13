import { defaultNetwork, type NetworkConfig } from '../engine/network.ts';
import type { NodeId, SimEvent } from '../engine/types.ts';
import { hash32 } from '../ring/hash.ts';
import { Ring } from '../ring/ring.ts';
import type { Update } from '../swim/membership.ts';
import { SwimMetrics } from '../swim/metrics.ts';
import { createStoreCluster, defaultClusterConfig, isClient, type StoreSim } from '../store/cluster.ts';
import type { ClientRequest, ClusterConfig } from '../store/messages.ts';
import { StoreMetrics } from '../store/metrics.ts';
import type { StoreNode } from '../store/node.ts';
import { clockKey, fingerprint } from '../store/vclock.ts';
import { button, checkbox, hint, numberField, readout, row, section, slider } from './controls.ts';
import { MerkleView } from './merkleView.ts';
import { RequestView } from './requestView.ts';
import { RingView, type KeyDot, type Packet } from './ringView.ts';

const MAX_EVENTS_PER_FRAME = 20_000;
const LOG_LINES = 80;
const CLIENTS = 2;

// Settings survive a reset; the simulation itself does not.
const cfg: ClusterConfig = { ...defaultClusterConfig };
const net: NetworkConfig = { ...defaultNetwork };
let seed = 1;
let size = 10;
let playing = true;
let speed = 1;
let showGossip = true;

let sim!: StoreSim;
let swimMetrics!: SwimMetrics;
let storeMetrics!: StoreMetrics;
let storeIds: NodeId[] = [];
let ringTruth!: Ring;
let ringKey = '';
let packets: Packet[] = [];
let logLines: { cls: string; text: string }[] = [];
let logDirty = true;
let carry = 0;
let keyDots: KeyDot[] = [];
let lastSlowRender = 0;
let selectedKey: string | null = null;
let newKeys = 0;
const selected = new Set<NodeId>();

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const ring = new RingView(
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

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const ms = (v: number | undefined | null) => (v == null || Number.isNaN(v) ? 'n/a' : `${Math.round(v)} ms`);
const store = (id: NodeId) => sim.getNode(id) as StoreNode;
const ownersOf = (key: string) => ringTruth.preferenceList(key, Math.round(cfg.n));

/** Four packet families keep the picture readable; anything not listed is gossip. */
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
  packets = [];
  logLines = [];
  keyDots = [];
  carry = 0;
  ringKey = '';
  selectedKey = null;
  selected.clear();
  requests.clear();
  ring.setNodes(storeIds, sim.nodeIds().filter(isClient));
  sim.onEvent(onEvent);
}

function onEvent(e: SimEvent): void {
  swimMetrics.onEvent(e);
  storeMetrics.onEvent(e);
  requests.onEvent(e);
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
          if (u.inc > 0) addLog('alive', `${secs(e.t)}  ${e.node} asserts it is alive (incarnation ${u.inc})`);
        } else {
          addLog(u.status, `${secs(e.t)}  ${e.node} sees ${u.id} as ${u.status} (i${u.inc})`);
        }
      } else if (e.kind === 'repair') {
        const d = e.data as { key: string; to: NodeId[] };
        addLog('repair', `${secs(e.t)}  ${e.node} read-repairs ${d.key} on ${d.to.join(', ')}`);
      } else if (e.kind === 'handoff') {
        const d = e.data as { from: NodeId; keys: number };
        addLog('handoff', `${secs(e.t)}  ${d.from} hands ${d.keys} hinted key(s) back to ${e.node}`);
      } else if (e.kind === 'ae') {
        const d = e.data as { peer: NodeId; changed: number };
        if (d.changed) addLog('ae', `${secs(e.t)}  anti-entropy: ${e.node} repaired ${d.changed} key(s) from ${d.peer}`);
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
              ? `${i.node} latency x${i.factor}`
              : i.type === 'heal'
                ? 'heal partition'
                : i.type === 'request'
                  ? `${i.node}: ${(i.payload as ClientRequest).op} ${(i.payload as ClientRequest).key}`
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
slider(run, { label: 'Nodes (resets)', min: 3, max: 40, step: 1, value: size }, (v) => {
  size = v;
  reset();
});
numberField(run, 'Seed (resets)', seed, (v) => {
  seed = v;
  reset();
});
checkbox(run, 'Show gossip packets', showGossip, (on) => (showGossip = on));

const faults = section(side, 'Faults');
const faultHint = hint(faults, '');
const faultRow = row(faults);
const each = (fn: (id: NodeId) => void) => () => [...selected].forEach(fn);
const killBtn = button(faultRow, 'Kill', each((id) => sim.input({ type: 'kill', node: id })), 'danger');
const restartBtn = button(faultRow, 'Restart', each((id) => sim.input({ type: 'restart', node: id })));
const isolateBtn = button(faultRow, 'Isolate', () => sim.input({ type: 'partition', groups: [[...selected]] }));
const slowBtn = button(faultRow, 'Slow x10', each((id) => sim.input({ type: 'slow', node: id, factor: sim.network.slow.has(id) ? 1 : 10 })));
const healBtn = button(faultRow, 'Heal', () => sim.input({ type: 'heal' }));

function syncButtons(): void {
  const ids = [...selected];
  killBtn.disabled = !ids.some((id) => sim.isUp(id));
  restartBtn.disabled = !ids.some((id) => !sim.isUp(id));
  isolateBtn.disabled = ids.length === 0 || ids.length === sim.nodeIds().length;
  slowBtn.disabled = ids.length === 0;
  healBtn.disabled = sim.network.partitions.length === 0;
  const text = ids.length ? `Selected: ${ids.join(', ')}` : 'Click nodes or clients to select them.';
  if (faultHint.textContent !== text) faultHint.textContent = text;
}

/** Slider bound to one numeric config key; applied live as a recorded input. */
function cfgSlider(parent: HTMLElement, key: keyof ClusterConfig, label: string, min: number, max: number, step: number, unit = '', scale = 1): void {
  slider(parent, { label, min, max, step, value: cfg[key] * scale, format: (v) => `${v}${unit}` }, (v) => {
    cfg[key] = v / scale;
    sim.input({ type: 'config', patch: { [key]: cfg[key] } });
  });
}

function cfgToggle(parent: HTMLElement, key: keyof ClusterConfig, label: string): void {
  checkbox(parent, label, cfg[key] === 1, (on) => {
    cfg[key] = on ? 1 : 0;
    sim.input({ type: 'config', patch: { [key]: cfg[key] } });
  });
}

const storeSec = section(side, 'Replication');
cfgSlider(storeSec, 'n', 'N: replicas per key', 1, 5, 1);
cfgSlider(storeSec, 'r', 'R: replies needed to read', 1, 5, 1);
cfgSlider(storeSec, 'w', 'W: acks needed to write', 1, 5, 1);
const quorumHint = hint(storeSec, '');
cfgToggle(storeSec, 'sloppy', 'Sloppy quorum');
cfgToggle(storeSec, 'hintedHandoff', 'Hinted handoff');
cfgToggle(storeSec, 'readRepair', 'Read repair');
checkbox(storeSec, 'Merkle anti-entropy', cfg.antiEntropyInterval > 0, (on) => {
  cfg.antiEntropyInterval = on ? 5000 : 0;
  sim.input({ type: 'config', patch: { antiEntropyInterval: cfg.antiEntropyInterval } });
});
checkbox(storeSec, 'Improved failure detector', cfg.phi === 1, (on) => {
  cfg.phi = cfg.dynamicSuspicion = on ? 1 : 0;
  sim.input({ type: 'config', patch: { phi: cfg.phi, dynamicSuspicion: cfg.dynamicSuspicion } });
});

const keySec = section(side, 'Selected key');
const keyHint = hint(keySec, '');
const versionsEl = document.createElement('div');
versionsEl.className = 'versions';
keySec.appendChild(versionsEl);
const keyRow = row(keySec);
const ask = (client: number, payload: ClientRequest) => sim.input({ type: 'request', node: `c${client}`, payload });
const getBtn = button(keyRow, 'Get', () => ask(0, { op: 'get', key: selectedKey! }));
const putBtn = button(keyRow, 'Put', () => ask(0, { op: 'put', key: selectedKey! }));
const clashBtn = button(keyRow, 'Concurrent puts', () => {
  // Two clients write at once through two different coordinators: guaranteed siblings.
  const [a, b] = ownersOf(selectedKey!);
  ask(0, { op: 'put', key: selectedKey!, blind: true, via: a });
  ask(1, { op: 'put', key: selectedKey!, blind: true, via: b ?? a });
});
button(keyRow, 'New key', () => {
  selectedKey = `user${++newKeys}`;
  ask(0, { op: 'put', key: selectedKey });
});

const stats = section(side, 'Metrics');
const showMetrics = readout(stats, {
  avail: 'Availability',
  latency: 'Latency p50 / p99',
  stale: 'Stale reads',
  siblings: 'Reads returning siblings',
  divergent: 'Keys with replicas out of sync',
  hints: 'Hints waiting',
  detection: 'Last failure detected in',
  falseDeads: 'False death verdicts',
});

const work = section(side, 'Workload', false);
cfgSlider(work, 'rate', 'Requests per client', 0, 50, 1, ' /s');
cfgSlider(work, 'readRatio', 'Reads', 0, 100, 5, '%', 100);
cfgSlider(work, 'keys', 'Keyspace', 1, 200, 1, ' keys');
cfgSlider(work, 'zipf', 'Key skew (zipf exponent)', 0, 2, 0.1);

const netSec = section(side, 'Network', false);
const netSlider = (key: keyof NetworkConfig, label: string, max: number, percent: boolean) =>
  slider(
    netSec,
    { label, min: 0, max, step: 1, value: percent ? net[key] * 100 : net[key], format: (v) => `${v}${percent ? '%' : ' ms'}` },
    (v) => {
      net[key] = percent ? v / 100 : v;
      sim.input({ type: 'network', patch: { [key]: net[key] } });
    },
  );
netSlider('latencyMean', 'Latency mean', 500, false);
netSlider('latencyJitter', 'Latency jitter', 250, false);
netSlider('loss', 'Loss', 80, true);
netSlider('duplication', 'Duplication', 50, true);
netSlider('reorder', 'Reordering', 50, true);

const advanced = section(side, 'Advanced', false);
cfgSlider(advanced, 'protocolPeriod', 'SWIM protocol period', 100, 3000, 50, ' ms');
cfgSlider(advanced, 'pingTimeout', 'SWIM ping timeout', 20, 1500, 10, ' ms');
cfgSlider(advanced, 'indirectK', 'SWIM indirect probes (k)', 0, 8, 1);
cfgSlider(advanced, 'suspectTimeout', 'SWIM suspect timeout', 200, 15_000, 100, ' ms');
cfgSlider(advanced, 'piggybackMax', 'Gossip updates per message', 0, 12, 1);
cfgSlider(advanced, 'vnodes', 'Virtual nodes per node', 1, 64, 1);
cfgSlider(advanced, 'requestTimeout', 'Request timeout', 100, 3000, 50, ' ms');
cfgSlider(advanced, 'hintTtl', 'Hint TTL', 1000, 120_000, 1000, ' ms');

const reqSec = section(side, 'Requests', false);
const requests = new RequestView(reqSec);

const merkleSec = section(side, 'Merkle tree diff', false);
const merkle = new MerkleView(merkleSec);

const logSec = section(side, 'Event log', false);
const logEl = document.createElement('div');
logEl.id = 'log';
logSec.appendChild(logEl);

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

/** Per-key replica comparison; too heavy for every frame, so refreshed a few times a second. */
function slowRender(): void {
  const key = `${storeIds.length}:${cfg.vnodes}`;
  if (key !== ringKey) {
    ringKey = key;
    ringTruth = new Ring(storeIds, cfg.vnodes);
    ring.setTokens(ringTruth.tokens);
  }

  const keys = new Set<string>();
  for (const id of storeIds) for (const k of store(id).replica.keys()) keys.add(k);
  keyDots = [...keys].map((k) => {
    const held = ownersOf(k).map((id) => store(id).replica.get(k));
    const state: KeyDot['state'] = new Set(held.map(fingerprint)).size > 1 ? 'divergent' : held.some((v) => v.length > 1) ? 'siblings' : 'ok';
    return { key: k, at: hash32(k) / 2 ** 32, state };
  });

  const m = storeMetrics;
  const failure = swimMetrics.failures.at(-1);
  showMetrics({
    avail: `${(m.availability * 100).toFixed(1)}%`,
    latency: `${ms(m.percentile(0.5))} / ${ms(m.percentile(0.99))}`,
    stale: String(m.staleReads),
    siblings: String(m.siblingReads),
    divergent: `${keyDots.filter((k) => k.state === 'divergent').length} of ${keyDots.length}`,
    hints: String(storeIds.reduce((n, id) => n + store(id).hints.depth, 0)),
    detection: failure ? (failure.allDead === undefined ? 'not yet' : `${(failure.allDead / 1000).toFixed(1)} s`) : 'n/a',
    falseDeads: String(swimMetrics.falseDeads),
  });

  const overlap = cfg.r + cfg.w > cfg.n;
  quorumHint.textContent =
    cfg.r > cfg.n || cfg.w > cfg.n
      ? 'R or W exceeds N: those requests can never succeed.'
      : overlap
        ? 'R + W > N: reads always see the latest write.'
        : 'R + W <= N: stale reads are possible.';

  // Selected key: what each owner holds.
  const hasKey = selectedKey !== null;
  getBtn.disabled = putBtn.disabled = clashBtn.disabled = !hasKey;
  if (!hasKey) {
    keyHint.textContent = 'Click a key dot on the inner ring.';
    versionsEl.replaceChildren();
  } else {
    const owners = ownersOf(selectedKey!);
    keyHint.textContent = `${selectedKey} is owned by ${owners.join(', ')}.`;
    versionsEl.replaceChildren(
      ...owners.map((id) => {
        const line = document.createElement('div');
        const versions = store(id).replica.get(selectedKey!);
        if (versions.length > 1) line.className = 'sib';
        const name = document.createElement('b');
        name.textContent = `${id}: `;
        line.append(name, versions.length ? versions.map((v) => `${v.value} [${clockKey(v.clock)}]`).join('  |  ') : '(nothing)');
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

  ring.render({
    now,
    packets,
    selected,
    keys: keyDots,
    selectedKey,
    owners: selectedKey ? ownersOf(selectedKey) : [],
    isUp: (id) => sim.isUp(id),
    isSlow: (id) => sim.network.slow.has(id),
    isIsolated: (id) => isolated.has(id),
    incarnation: (id) => store(id).swim.inc,
    hints: (id) => store(id).hints.depth,
    belief: (o, s) => swimMetrics.belief(o, s)?.status,
  });

  const converged = swimMetrics.convergedAt !== null;
  statusEl.innerHTML =
    `t = ${secs(now)} &middot; ${swimMetrics.up.size}/${swimMetrics.all.length} up &middot; ` +
    `<span class="${converged ? 'ok' : 'no'}">membership ${converged ? 'converged' : 'diverged'}</span>`;

  requests.render();

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
