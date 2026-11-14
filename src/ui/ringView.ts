import type { NodeId } from '../engine/types.ts';
import type { Status } from '../swim/membership.ts';

const NS = 'http://www.w3.org/2000/svg';
const RING_R = 372;
const KEY_R = 262;
const CLIENT_R = 80;
const MAX_PACKETS = 400;

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
  /** What the rest of the cluster believes about this node. */
  status(id: NodeId): Status;
}

interface NodeEls {
  group: SVGGElement;
  /** Small line under the name: "down", "slow" or empty. */
  note?: SVGTextElement;
  client: boolean;
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

/**
 * The cluster picture. Outer circle: nodes, coloured by what the other nodes
 * believe about them (dashed when actually down). Inner circle: keys at their
 * place in the hash space. Centre: clients. Packets fly between them.
 */
export class RingView {
  private readonly svg: SVGSVGElement;
  private readonly onPick: (id: NodeId | null) => void;
  private readonly onPickKey: (key: string) => void;
  private readonly pos = new Map<NodeId, { x: number; y: number }>();
  private readonly nodes = new Map<NodeId, NodeEls>();
  private readonly keyDots = new Map<string, SVGCircleElement>();
  private readonly pool: SVGCircleElement[] = [];
  private readonly ownerLines: SVGLineElement[] = [];
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
    this.svg.replaceChildren();
    this.pos.clear();
    this.nodes.clear();
    this.keyDots.clear();
    this.pool.length = 0;
    this.ownerLines.length = 0;

    const n = ids.length;
    const r = Math.max(10, Math.min(30, ((RING_R * Math.PI) / n) * 0.42));

    el('circle', { class: 'guide', r: RING_R }, this.svg);
    el('circle', { class: 'guide inner', r: KEY_R }, this.svg);
    this.ownerLayer = el('g', {}, this.svg);
    this.keyLayer = el('g', {}, this.svg);
    this.packetLayer = el('g', {}, this.svg);

    ids.forEach((id, i) => {
      const p = polar(RING_R, -Math.PI / 2 + (2 * Math.PI * i) / n);
      const group = this.makeGroup(id, p);
      el('circle', { class: 'cut', r: r + 9 }, group);
      el('circle', { class: 'pick', r: r + 5 }, group);
      el('circle', { class: 'body', r }, group);
      el('text', { 'font-size': Math.max(16, r * 0.85), y: -r * 0.12 }, group).textContent = id;
      const note = el('text', { class: 'note', 'font-size': Math.max(12, r * 0.42), y: r * 0.5 }, group);
      this.nodes.set(id, { group, note, client: false });
    });

    clients.forEach((id, i) => {
      const p = clients.length === 1 ? { x: 0, y: 0 } : polar(CLIENT_R, Math.PI + (2 * Math.PI * i) / clients.length);
      const group = this.makeGroup(id, p);
      el('rect', { class: 'cut', x: -35, y: -25, width: 70, height: 50, rx: 11 }, group);
      el('rect', { class: 'pick', x: -31, y: -21, width: 62, height: 42, rx: 9 }, group);
      el('rect', { class: 'body', x: -26, y: -16, width: 52, height: 32, rx: 6 }, group);
      el('text', { 'font-size': 22 }, group).textContent = id;
      this.nodes.set(id, { group, client: true });
    });
  }

  render(s: RingState): void {
    for (const [id, els] of this.nodes) {
      const cls = ['node'];
      if (els.client) cls.push('client');
      else cls.push(s.status(id));
      if (!s.isUp(id)) cls.push('down');
      if (s.selected.has(id)) cls.push('selected');
      if (s.isIsolated(id)) cls.push('isolated');
      if (s.owners.includes(id)) cls.push('owner');
      set(els.group, 'class', cls.join(' '));
      if (els.note) {
        const note = !s.isUp(id) ? 'down' : s.isSlow(id) ? 'slow' : '';
        if (els.note.textContent !== note) els.note.textContent = note;
      }
    }
    this.renderKeys(s);
    this.renderPackets(s);
  }

  private makeGroup(id: NodeId, p: { x: number; y: number }): SVGGElement {
    this.pos.set(id, p);
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
      const p = polar(KEY_R, hashAngle(k.at));
      let dot = this.keyDots.get(k.key);
      if (!dot) {
        dot = el('circle', { r: 7, cx: p.x.toFixed(1), cy: p.y.toFixed(1) }, this.keyLayer);
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
    while (this.pool.length < shown.length) this.pool.push(el('circle', { r: 9 }, this.packetLayer));
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
