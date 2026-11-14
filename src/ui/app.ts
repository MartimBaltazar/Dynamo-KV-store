import type { Input, NodeId } from '../engine/types.ts';
import type { NetworkConfig } from '../engine/network.ts';
import type { ClientRequest, ClusterConfig } from '../store/messages.ts';
import { button, hint, row, slider } from './controls.ts';
import { Lane } from './lane.ts';
import { RingView } from './ringView.ts';
import { scenarios, type MetricKey, type Scenario } from './scenarios.ts';

/** Simulated milliseconds per real millisecond. Slow-mo applies only while something visible is travelling. */
const SPEEDS = {
  slow: { label: 'Slow', busy: 0.1, idle: 3 },
  normal: { label: 'Normal', busy: 1, idle: 1 },
  fast: { label: 'Fast', busy: 6, idle: 6 },
} as const;
type SpeedMode = keyof typeof SPEEDS;

const LABELS: Record<MetricKey, string> = {
  avail: 'Requests that succeeded',
  p99: 'Slowest 1% of requests',
  stale: 'Reads that missed a write',
  divergent: 'Keys whose copies disagree',
  load: 'Busiest node vs average',
  detect: 'Time to notice a failure',
  falseDead: 'Healthy nodes called dead',
};
const ORDER: MetricKey[] = ['avail', 'p99', 'stale', 'divergent', 'load', 'detect', 'falseDead'];
/** Which direction is better, for marking the winner of a highlighted row. */
const HIGHER_IS_BETTER: Partial<Record<MetricKey, boolean>> = { avail: true };

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

// --- state -----------------------------------------------------------------

let scenario: Scenario = scenarios[0];
let size = scenario.size;
let playing = true;
let mode: SpeedMode = 'slow';
let clock = 0;
let carry = 0;
let script: Scenario['script'] = [];
let selectedKey: string | null = null;
const selected = new Set<NodeId>();
let lastTable = 0;

const picker = {
  node: (id: NodeId | null) => {
    if (id === null) selected.clear();
    else if (!selected.delete(id)) selected.add(id);
  },
  key: (key: string) => {
    selectedKey = selectedKey === key ? null : key;
  },
};

const classicView = new RingView($<SVGSVGElement>('#ring-classic'), picker.node, picker.key);
const improvedView = new RingView($<SVGSVGElement>('#ring-improved'), picker.node, picker.key);
const classic = new Lane(false, classicView);
const improved = new Lane(true, improvedView);
const lanes = [classic, improved];
const both = (fn: (l: Lane) => void) => lanes.forEach(fn);

// --- scenarios -------------------------------------------------------------

const chips = $<HTMLElement>('#scenarios');
const chipEls = new Map<string, HTMLButtonElement>();
for (const s of scenarios) chipEls.set(s.id, button(chips, s.title, () => load(s)));

function load(s: Scenario, nodes = s.size, keepPlay = false): void {
  scenario = s;
  size = nodes;
  clock = 0;
  carry = 0;
  script = [...s.script].sort((a, b) => a.t - b.t);
  selected.clear();
  selectedKey = null;
  both((l) => l.start(s, nodes));
  for (const [id, el] of chipEls) el.className = id === s.id ? 'primary' : '';
  $('#story').textContent = s.story;
  $('#watch').textContent = s.watch;
  buildTable();
  if (!keepPlay) buildPlay();
  lastTable = 0;
}

// --- controls --------------------------------------------------------------

const controls = $<HTMLElement>('#controls');
const playBtn = button(controls, 'Pause', () => {
  playing = !playing;
  playBtn.textContent = playing ? 'Pause' : 'Play';
}, 'primary');
button(controls, 'Restart', () => load(scenario, size));
const speedWrap = document.createElement('span');
speedWrap.className = 'speed';
controls.appendChild(speedWrap);
const speedBtns = new Map<SpeedMode, HTMLButtonElement>();
for (const m of Object.keys(SPEEDS) as SpeedMode[]) {
  speedBtns.set(m, button(speedWrap, SPEEDS[m].label, () => {
    mode = m;
    for (const [k, b] of speedBtns) b.className = k === m ? 'primary' : '';
  }, m === mode ? 'primary' : ''));
}
const clockEl = document.createElement('span');
clockEl.className = 'clock';
controls.appendChild(clockEl);

// --- metrics table ---------------------------------------------------------

const table = $<HTMLTableElement>('#metrics');
const cells = new Map<MetricKey, { classic: HTMLElement; improved: HTMLElement }>();

function buildTable(): void {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const t of ['', 'Classic Dynamo', 'Improved']) head.appendChild(Object.assign(document.createElement('th'), { textContent: t }));
  const body = table.createTBody();
  cells.clear();
  const keys = [...scenario.highlight, ...ORDER.filter((k) => !scenario.highlight.includes(k))];
  for (const k of keys) {
    const tr = body.insertRow();
    if (scenario.highlight.includes(k)) tr.className = 'hot';
    tr.insertCell().textContent = LABELS[k];
    const a = tr.insertCell();
    const b = tr.insertCell();
    cells.set(k, { classic: a, improved: b });
  }
}

function fillTable(): void {
  const [c, i] = [classic.readings(), improved.readings()];
  for (const [k, el] of cells) {
    const [x, y] = [c[k], i[k]];
    el.classic.textContent = x.text;
    el.improved.textContent = y.text;
    let winner: 'classic' | 'improved' | null = null;
    if (scenario.highlight.includes(k) && x.n !== undefined && y.n !== undefined && Math.abs(x.n - y.n) > Math.max(0.02 * Math.abs(x.n), 1e-9)) {
      const classicHigher = x.n > y.n;
      winner = classicHigher === (HIGHER_IS_BETTER[k] ?? false) ? 'classic' : 'improved';
    }
    el.classic.className = winner === 'classic' ? 'win' : '';
    el.improved.className = winner === 'improved' ? 'win' : '';
  }
}

// --- free play -------------------------------------------------------------

const play = $<HTMLElement>('#play');
let faultHint!: HTMLElement;
let keyHint!: HTMLElement;
let killBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let slowBtn!: HTMLButtonElement;
let isolateBtn!: HTMLButtonElement;
let healBtn!: HTMLButtonElement;
let getBtn!: HTMLButtonElement;
let putBtn!: HTMLButtonElement;
let clashBtn!: HTMLButtonElement;

const ask = (client: number, payload: ClientRequest) => both((l) => l.input({ type: 'request', node: `c${client}`, payload }));
const patch = (p: Partial<ClusterConfig>) => both((l) => l.input({ type: 'config', patch: p as Record<string, number> }));
const net = (p: Partial<NetworkConfig>) => both((l) => l.input({ type: 'network', patch: p }));

/** Rebuilt on every story, so the sliders always show what the cluster is really using. */
function buildPlay(): void {
  play.replaceChildren();
  const cfg = classic.cfg;
  faultHint = hint(play, '');
  const faultRow = row(play);
  const each = (fn: (id: NodeId) => Input) => () => [...selected].forEach((id) => both((l) => l.input(fn(id))));
  killBtn = button(faultRow, 'Kill', each((node) => ({ type: 'kill', node })), 'danger');
  restartBtn = button(faultRow, 'Restart node', each((node) => ({ type: 'restart', node })));
  slowBtn = button(faultRow, 'Slow', each((node) => ({ type: 'slow', node, factor: classic.sim.network.slow.has(node) ? 1 : 10 })));
  isolateBtn = button(faultRow, 'Isolate', () => both((l) => l.input({ type: 'partition', groups: [[...selected]] })));
  healBtn = button(faultRow, 'Heal', () => both((l) => l.input({ type: 'heal' })));

  keyHint = hint(play, '');
  const keyRow = row(play);
  getBtn = button(keyRow, 'Read key', () => ask(0, { op: 'get', key: selectedKey! }));
  putBtn = button(keyRow, 'Write key', () => ask(0, { op: 'put', key: selectedKey! }));
  clashBtn = button(keyRow, 'Two writes at once', () => {
    const [a, b] = classic.ownersOf(selectedKey!);
    ask(0, { op: 'put', key: selectedKey!, blind: true, via: a });
    ask(1, { op: 'put', key: selectedKey!, blind: true, via: b ?? a });
  });

  for (const [key, label] of [['n', 'Copies of each key (N)'], ['r', 'Copies a read waits for (R)'], ['w', 'Copies a write waits for (W)']] as const) {
    slider(play, { label, min: 1, max: 5, step: 1, value: cfg[key] }, (v) => patch({ [key]: v }));
  }
  slider(play, { label: 'Requests per client', min: 0, max: 50, step: 1, value: cfg.rate, format: (v) => `${v} /s` }, (v) => patch({ rate: v }));
  slider(play, { label: 'Share of reads', min: 0, max: 100, step: 5, value: Math.round(cfg.readRatio * 100), format: (v) => `${v}%` }, (v) => patch({ readRatio: v / 100 }));
  slider(play, { label: 'Packet loss', min: 0, max: 60, step: 1, value: Math.round(classic.net.loss * 100), format: (v) => `${v}%` }, (v) => net({ loss: v / 100 }));
  slider(play, { label: 'Network latency', min: 0, max: 300, step: 5, value: classic.net.latencyMean, format: (v) => `${v} ms` }, (v) => net({ latencyMean: v }));
  slider(play, { label: 'Nodes (restarts the story)', min: 3, max: 20, step: 1, value: size }, (v) => load(scenario, v, true));
}

function syncPlay(): void {
  const ids = [...selected];
  killBtn.disabled = !ids.some((id) => classic.sim.isUp(id));
  restartBtn.disabled = !ids.some((id) => !classic.sim.isUp(id));
  isolateBtn.disabled = ids.length === 0 || ids.length === classic.storeIds.length;
  slowBtn.disabled = ids.length === 0;
  healBtn.disabled = classic.sim.network.partitions.length === 0;
  getBtn.disabled = putBtn.disabled = clashBtn.disabled = selectedKey === null;
  const a = ids.length ? `Selected: ${ids.join(', ')}` : 'Tap nodes in either ring to select them.';
  if (faultHint.textContent !== a) faultHint.textContent = a;
  const b = selectedKey ? `Key ${selectedKey} lives on ${classic.ownersOf(selectedKey).join(', ')}.` : 'Tap a dot on an inner circle to pick a key.';
  if (keyHint.textContent !== b) keyHint.textContent = b;
}

// --- loop ------------------------------------------------------------------

/** Moves both clusters forward together, applying scripted faults at their exact time. */
function advance(ms: number): void {
  const target = clock + ms;
  while (script.length && script[0].t <= target) {
    const next = script.shift()!;
    both((l) => {
      l.runUntil(next.t);
      l.input(next.input);
    });
  }
  both((l) => l.runUntil(target));
  clock = target;
}

const captions = [$<HTMLElement>('#cap-classic'), $<HTMLElement>('#cap-improved')];
let last = performance.now();

function frame(t: number): void {
  const dt = Math.min(100, t - last);
  last = t;
  if (playing) {
    const speed = SPEEDS[mode];
    carry += dt * (lanes.some((l) => l.busy) ? speed.busy : speed.idle);
    const whole = Math.floor(carry);
    if (whole > 0) {
      carry -= whole;
      advance(whole);
    }
  }
  const ui = { selected, selectedKey };
  both((l) => l.draw(t, ui));
  lanes.forEach((l, i) => {
    const text = l.caption(t);
    if (captions[i].textContent !== text) captions[i].textContent = text;
  });
  if (t - lastTable > 250) {
    lastTable = t;
    fillTable();
    syncPlay();
  }
  const time = `${(clock / 1000).toFixed(1)} s`;
  if (clockEl.textContent !== time) clockEl.textContent = time;
  requestAnimationFrame(frame);
}

load(scenario);
requestAnimationFrame(frame);
