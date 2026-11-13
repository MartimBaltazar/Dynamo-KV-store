import type { NodeId } from '../engine/types.ts';
import type { Token } from '../ring/ring.ts';
import type { Status } from '../swim/membership.ts';

const NS = 'http://www.w3.org/2000/svg';
const RING_R = 372;
const TOKEN_R = 268;
const KEY_R = 244;
const CLIENT_R = 80;
const MAX_PACKETS = 500;

export interface Packet {
  from: NodeId;
  to: NodeId;
  /** CSS class that colors the packet. */
  cls: string;
  t0: number;
  t1: number;
  lost: boolean;
}

export interface KeyDot {
  key: string;
  /** Position on the ring, 0..1 of the hash space. */
  at: number;
  state: 'ok' | 'divergent' | 'siblings';
}

export interface RingState {
  now: number;
  packets: Packet[];
  selected: ReadonlySet<NodeId>;
  keys: KeyDot[];
  selectedKey: string | null;
  /** Owners of the selected key. */
  owners: NodeId[];
  isUp(id: NodeId): boolean;
  isSlow(id: NodeId): boolean;
  isIsolated(id: NodeId): boolean;
  incarnation(id: NodeId): number;
  hints(id: NodeId): number;
  belief(observer: NodeId, subject: NodeId): Status | undefined;
}

interface NodeEls {
  group: SVGGElement;
  inc?: SVGTextElement;
  hints?: SVGTextElement;
  halo: Map<NodeId, SVGPathElement>;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** Sets an attribute only when it changed; keeps per-frame DOM writes cheap. */
function set(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

const polar = (r: number, a: number) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const hashAngle = (at: number) => -Math.PI / 2 + 2 * Math.PI * at;

export const nodeHue = (index: number, count: number) => `hsl(${Math.round((index * 360) / count)} 70% 62%)`;

/**
 * The cluster picture. Outer circle: nodes, each with a halo showing what
 * every peer believes about it. Inner circle: the hash ring, with one tick
 * per virtual node colored by its owner, and the stored keys as dots.
 * Centre: clients. Packets fly along straight lines between all of them.
 */
export class RingView {
  private readonly svg: SVGSVGElement;
  private readonly onPick: (id: NodeId | null) => void;
  private readonly onPickKey: (key: string) => void;
  private ids: NodeId[] = [];
  private clients: NodeId[] = [];
  private readonly pos = new Map<NodeId, { x: number; y: number }>();
  private readonly nodes = new Map<NodeId, NodeEls>();
  private readonly keyDots = new Map<string, SVGCircleElement>();
  private readonly pool: SVGCircleElement[] = [];
  private readonly ownerLines: SVGLineElement[] = [];
  private tokenLayer!: SVGGElement;
  private ownerLayer!: SVGGElement;
  private keyLayer!: SVGGElement;
  private packetLayer!: SVGGElement;

  constructor(svg: SVGSVGElement, onPick: (id: NodeId | null) => void, onPickKey: (key: string) => void) {
    this.svg = svg;
    this.onPick = onPick;
    this.onPickKey = onPickKey;
    svg.addEventListener('click', () => this.onPick(null));
  }

  setNodes(ids: NodeId[], clients: NodeId[]): void {
    this.ids = ids;
    this.clients = clients;
    this.svg.replaceChildren();
    this.pos.clear();
    this.nodes.clear();
    this.keyDots.clear();
    this.pool.length = 0;
    this.ownerLines.length = 0;

    const n = ids.length;
    const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
    const r = Math.max(9, Math.min(26, ((RING_R * Math.PI) / n) * 0.36));
    const haloR = r + Math.max(5, r * 0.36);
    const haloW = Math.max(3, r * 0.26);
    const span = (Math.PI / n) * 0.8;

    el('circle', { class: 'guide', r: RING_R }, this.svg);
    el('circle', { class: 'guide inner', r: TOKEN_R }, this.svg);
    this.tokenLayer = el('g', {}, this.svg);
    this.ownerLayer = el('g', {}, this.svg);
    this.keyLayer = el('g', {}, this.svg);
    this.packetLayer = el('g', {}, this.svg);

    ids.forEach((id, i) => {
      const p = polar(RING_R, angle(i));
      this.pos.set(id, p);
      const group = this.makeGroup(id, p);

      const halo = new Map<NodeId, SVGPathElement>();
      ids.forEach((observer, j) => {
        if (j === i) return;
        const a = polar(haloR, angle(j) - span);
        const b = polar(haloR, angle(j) + span);
        const d = `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${haloR} ${haloR} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
        halo.set(observer, el('path', { class: 'halo', d, 'stroke-width': haloW }, group));
      });

      el('circle', { class: 'cut', r: haloR + haloW + 4 }, group);
      el('circle', { class: 'pick', r: haloR + haloW }, group);
      el('circle', { class: 'body', r }, group);
      el('circle', { class: 'tint', r: r - 3.5, stroke: nodeHue(i, n) }, group);
      const label = el('text', { 'font-size': Math.max(8, r * 0.62), y: -r * 0.12 }, group);
      label.textContent = id;
      const inc = el('text', { class: 'inc', 'font-size': Math.max(6, r * 0.4), y: r * 0.52 }, group);
      const out = polar(haloR + haloW + 16, angle(i));
      const hints = el('text', { class: 'hints', 'font-size': 15, x: out.x.toFixed(1), y: out.y.toFixed(1) }, group);
      this.nodes.set(id, { group, inc, hints, halo });
    });

    clients.forEach((id, i) => {
      const p = clients.length === 1 ? { x: 0, y: 0 } : polar(CLIENT_R, Math.PI + (2 * Math.PI * i) / clients.length);
      this.pos.set(id, p);
      const group = this.makeGroup(id, p);
      el('rect', { class: 'pick', x: -31, y: -21, width: 62, height: 42, rx: 9 }, group);
      el('rect', { class: 'cut', x: -35, y: -25, width: 70, height: 50, rx: 11 }, group);
      el('rect', { class: 'body', x: -26, y: -16, width: 52, height: 32, rx: 6 }, group);
      el('text', { 'font-size': 15 }, group).textContent = id;
      this.nodes.set(id, { group, halo: new Map() });
    });
  }

  /** Redraws the token ticks; call when the ring changes. */
  setTokens(tokens: readonly Token[]): void {
    this.tokenLayer.replaceChildren();
    const count = this.ids.length;
    for (const t of tokens) {
      const a = hashAngle(t.token / 2 ** 32);
      const p0 = polar(TOKEN_R - 7, a);
      const p1 = polar(TOKEN_R + 7, a);
      el(
        'line',
        { class: 'token', x1: p0.x.toFixed(1), y1: p0.y.toFixed(1), x2: p1.x.toFixed(1), y2: p1.y.toFixed(1), stroke: nodeHue(this.ids.indexOf(t.node), count) },
        this.tokenLayer,
      );
    }
  }

  render(s: RingState): void {
    for (const id of [...this.ids, ...this.clients]) {
      const els = this.nodes.get(id)!;
      const cls = ['node'];
      if (els.halo.size === 0) cls.push('client');
      if (!s.isUp(id)) cls.push('down');
      if (s.isSlow(id)) cls.push('slow');
      if (s.selected.has(id)) cls.push('selected');
      if (s.isIsolated(id)) cls.push('isolated');
      if (s.owners.includes(id)) cls.push('owner');
      set(els.group, 'class', cls.join(' '));
      if (els.inc) {
        const inc = `i${s.incarnation(id)}`;
        if (els.inc.textContent !== inc) els.inc.textContent = inc;
      }
      if (els.hints) {
        const depth = s.hints(id);
        const text = depth ? `${depth}h` : '';
        if (els.hints.textContent !== text) els.hints.textContent = text;
      }
      for (const [observer, path] of els.halo) {
        const belief = s.belief(observer, id) ?? '';
        set(path, 'class', `halo ${belief}${s.isUp(observer) ? '' : ' stale'}`);
      }
    }
    this.renderKeys(s);
    this.renderPackets(s);
  }

  private makeGroup(id: NodeId, p: { x: number; y: number }): SVGGElement {
    const group = el('g', { class: 'node', transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` }, this.svg);
    group.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onPick(id);
    });
    return group;
  }

  private renderKeys(s: RingState): void {
    const seen = new Set<string>();
    let selectedAt: { x: number; y: number } | null = null;
    for (const k of s.keys) {
      seen.add(k.key);
      let dot = this.keyDots.get(k.key);
      const p = polar(KEY_R, hashAngle(k.at));
      if (!dot) {
        dot = el('circle', { r: 6.5, cx: p.x.toFixed(1), cy: p.y.toFixed(1) }, this.keyLayer);
        el('title', {}, dot).textContent = k.key;
        dot.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onPickKey(k.key);
        });
        this.keyDots.set(k.key, dot);
      }
      const selected = k.key === s.selectedKey;
      if (selected) selectedAt = p;
      set(dot, 'class', `key ${k.state}${selected ? ' selected' : ''}`);
    }
    for (const [key, dot] of this.keyDots) {
      if (!seen.has(key)) {
        dot.remove();
        this.keyDots.delete(key);
      }
    }

    const owners = selectedAt ? s.owners : [];
    while (this.ownerLines.length < owners.length) this.ownerLines.push(el('line', { class: 'owner-line' }, this.ownerLayer));
    this.ownerLines.forEach((line, i) => {
      const to = owners[i] && this.pos.get(owners[i]);
      if (!to || !selectedAt) return set(line, 'visibility', 'hidden');
      set(line, 'visibility', 'visible');
      set(line, 'x1', selectedAt.x.toFixed(1));
      set(line, 'y1', selectedAt.y.toFixed(1));
      set(line, 'x2', to.x.toFixed(1));
      set(line, 'y2', to.y.toFixed(1));
    });
  }

  private renderPackets(s: RingState): void {
    const shown = s.packets.length > MAX_PACKETS ? s.packets.slice(-MAX_PACKETS) : s.packets;
    while (this.pool.length < shown.length) this.pool.push(el('circle', { r: 5 }, this.packetLayer));
    this.pool.forEach((dot, i) => {
      const p = shown[i];
      const a = p && this.pos.get(p.from);
      const b = p && this.pos.get(p.to);
      if (!p || !a || !b) {
        set(dot, 'visibility', 'hidden');
        return;
      }
      const progress = Math.min(1, Math.max(0, (s.now - p.t0) / Math.max(1, p.t1 - p.t0)));
      // A lost packet makes it halfway, fading out.
      const f = p.lost ? progress * 0.5 : progress;
      set(dot, 'visibility', 'visible');
      set(dot, 'class', `pk ${p.cls}${p.lost ? ' lost' : ''}`);
      dot.setAttribute('cx', (a.x + (b.x - a.x) * f).toFixed(1));
      dot.setAttribute('cy', (a.y + (b.y - a.y) * f).toFixed(1));
      dot.setAttribute('opacity', p.lost ? (1 - progress).toFixed(2) : '1');
    });
  }
}
