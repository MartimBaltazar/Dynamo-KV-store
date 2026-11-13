import { defaultNetwork, type NetworkConfig } from '../engine/network.ts';
import type { NodeId, SimEvent } from '../engine/types.ts';
import { createCluster, type SwimSim } from '../swim/cluster.ts';
import type { Update } from '../swim/membership.ts';
import { SwimMetrics } from '../swim/metrics.ts';
import { defaultSwimConfig, type SwimConfig, type SwimNode } from '../swim/node.ts';
import { button, hint, numberField, readout, row, section, slider } from './controls.ts';
import { RingView, type Packet } from './ringView.ts';

const MAX_EVENTS_PER_FRAME = 20_000;
const LOG_LINES = 80;

// Settings survive a reset; the simulation itself does not.
const swim: SwimConfig = { ...defaultSwimConfig };
const net: NetworkConfig = { ...defaultNetwork };
let seed = 1;
let size = 10;
let playing = true;
let speed = 1;

let sim!: SwimSim;
let metrics!: SwimMetrics;
let packets: Packet[] = [];
let logLines: { cls: string; text: string }[] = [];
let logDirty = true;
let carry = 0;
const selected = new Set<NodeId>();

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const ring = new RingView($<SVGSVGElement>('#ring'), (id) => {
  if (id === null) selected.clear();
  else if (!selected.delete(id)) selected.add(id);
  syncButtons();
});

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
const ms = (v: number | undefined | null) => (v == null ? 'n/a' : `${Math.round(v)} ms`);

function reset(): void {
  sim = createCluster({ seed, size, swim, network: net, logLimit: 5000 });
  metrics = new SwimMetrics();
  packets = [];
  logLines = [];
  carry = 0;
  selected.clear();
  sim.onEvent(onEvent);
  ring.setNodes(sim.nodeIds());
  syncButtons();
}

function onEvent(e: SimEvent): void {
  metrics.onEvent(e);
  switch (e.type) {
    case 'send':
      packets.push({ from: e.from, to: e.to, kind: e.kind, t0: e.t, t1: e.arrive, lost: false });
      break;
    case 'drop':
      if (e.reason !== 'down') {
        packets.push({ from: e.from, to: e.to, kind: e.kind, t0: e.t, t1: e.t + sim.network.config.latencyMean, lost: true });
      }
      break;
    case 'state': {
      if (e.kind !== 'member') break;
      const u = e.data as Update;
      if (u.id === e.node) {
        if (u.inc > 0) addLog('alive', `${secs(e.t)}  ${e.node} asserts it is alive (incarnation ${u.inc})`);
      } else {
        addLog(u.status, `${secs(e.t)}  ${e.node} sees ${u.id} as ${u.status} (i${u.inc})`);
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
  faultHint.textContent = ids.length ? `Selected: ${ids.join(', ')}` : 'Click nodes on the ring to select them.';
}

const swimSec = section(side, 'SWIM');
const swimSlider = (key: keyof SwimConfig, label: string, min: number, max: number, step: number, unit = '') =>
  slider(swimSec, { label, min, max, step, value: swim[key], format: (v) => `${v}${unit}` }, (v) => {
    swim[key] = v;
    sim.input({ type: 'config', patch: { [key]: v } });
  });
swimSlider('protocolPeriod', 'Protocol period', 100, 3000, 50, ' ms');
swimSlider('pingTimeout', 'Ping timeout', 20, 1500, 10, ' ms');
swimSlider('indirectK', 'Indirect probes (k)', 0, 8, 1);
swimSlider('suspectTimeout', 'Suspect timeout', 200, 15000, 100, ' ms');
swimSlider('piggybackMax', 'Piggyback max updates', 0, 12, 1);
swimSlider('retransmitMult', 'Retransmit multiplier', 0.5, 6, 0.5);
swimSlider('reconnectEvery', 'Retry dead every N periods', 0, 20, 1);

const netSec = section(side, 'Network');
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

const metricsSec = section(side, 'Metrics');
const showMetrics = readout(metricsSec, {
  converged: 'Views match reality',
  convergence: 'Convergence time',
  messages: 'Messages sent / lost',
  failure: 'Last failure',
  suspect: 'First suspicion after',
  dead: 'First death verdict after',
  allDead: 'All nodes knew after',
  falseSuspects: 'False suspicions',
  falseDeads: 'False death verdicts',
});

const logSec = section(side, 'Membership log');
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
  render();
  requestAnimationFrame(frame);
}

function render(): void {
  const now = sim.now;
  packets = packets.filter((p) => p.t1 >= now);
  const isolated = new Set(sim.network.partitions.flat());

  ring.render({
    now,
    packets,
    selected,
    isUp: (id) => sim.isUp(id),
    isSlow: (id) => sim.network.slow.has(id),
    isIsolated: (id) => isolated.has(id),
    incarnation: (id) => (sim.getNode(id) as SwimNode).inc,
    belief: (o, s) => metrics.belief(o, s)?.status,
  });

  const converged = metrics.convergedAt !== null;
  statusEl.innerHTML = `t = ${secs(now)} &middot; ${metrics.up.size}/${metrics.all.length} up &middot; <span class="${converged ? 'ok' : 'no'}">${converged ? 'converged' : 'diverged'}</span>`;

  const f = metrics.failures.at(-1);
  showMetrics({
    converged: converged ? 'yes' : 'no',
    convergence: converged ? ms(metrics.convergedAt! - metrics.lastDisturbance) : 'n/a',
    messages: `${metrics.sent} / ${metrics.lost}`,
    failure: f ? `${f.node} at ${secs(f.t)}` : 'none',
    suspect: ms(f?.firstSuspect),
    dead: ms(f?.firstDead),
    allDead: ms(f?.allDead),
    falseSuspects: String(metrics.falseSuspects),
    falseDeads: String(metrics.falseDeads),
  });

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
