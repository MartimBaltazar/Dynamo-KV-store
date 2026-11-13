import type { NodeId } from '../engine/types.ts';
import type { Status } from '../swim/membership.ts';

const NS = 'http://www.w3.org/2000/svg';
const RING_R = 365;
const MAX_PACKETS = 400;

export interface Packet {
  from: NodeId;
  to: NodeId;
  kind: string;
  t0: number;
  t1: number;
  lost: boolean;
}

export interface RingState {
  now: number;
  packets: Packet[];
  selected: ReadonlySet<NodeId>;
  isUp(id: NodeId): boolean;
  isSlow(id: NodeId): boolean;
  isIsolated(id: NodeId): boolean;
  incarnation(id: NodeId): number;
  belief(observer: NodeId, subject: NodeId): Status | undefined;
}

interface NodeEls {
  group: SVGGElement;
  inc: SVGTextElement;
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

/**
 * Nodes on a circle, packets flying along chords, and around every node a
 * halo that shows what each peer believes about it.
 */
export class RingView {
  private readonly svg: SVGSVGElement;
  private readonly onPick: (id: NodeId | null) => void;
  private ids: NodeId[] = [];
  private readonly pos = new Map<NodeId, { x: number; y: number }>();
  private readonly nodes = new Map<NodeId, NodeEls>();
  private packetLayer!: SVGGElement;
  private readonly pool: SVGCircleElement[] = [];

  constructor(svg: SVGSVGElement, onPick: (id: NodeId | null) => void) {
    this.svg = svg;
    this.onPick = onPick;
    svg.addEventListener('click', () => this.onPick(null));
  }

  setNodes(ids: NodeId[]): void {
    this.ids = ids;
    this.svg.replaceChildren();
    this.pos.clear();
    this.nodes.clear();
    this.pool.length = 0;

    const n = ids.length;
    const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
    const r = Math.max(9, Math.min(26, ((RING_R * Math.PI) / n) * 0.36));
    const haloR = r + Math.max(5, r * 0.36);
    const haloW = Math.max(3, r * 0.26);
    const span = (Math.PI / n) * 0.8;

    el('circle', { class: 'guide', r: RING_R }, this.svg);
    this.packetLayer = el('g', {}, this.svg);

    ids.forEach((id, i) => {
      const x = RING_R * Math.cos(angle(i));
      const y = RING_R * Math.sin(angle(i));
      this.pos.set(id, { x, y });

      const group = el('g', { class: 'node', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, this.svg);
      group.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onPick(id);
      });

      const halo = new Map<NodeId, SVGPathElement>();
      ids.forEach((observer, j) => {
        if (j === i) return;
        const a0 = angle(j) - span;
        const a1 = angle(j) + span;
        const p = (a: number) => `${(haloR * Math.cos(a)).toFixed(2)} ${(haloR * Math.sin(a)).toFixed(2)}`;
        const d = `M ${p(a0)} A ${haloR} ${haloR} 0 0 1 ${p(a1)}`;
        halo.set(observer, el('path', { class: 'halo', d, 'stroke-width': haloW }, group));
      });

      el('circle', { class: 'cut', r: haloR + haloW + 4 }, group);
      el('circle', { class: 'pick', r: haloR + haloW }, group);
      el('circle', { class: 'body', r }, group);
      const label = el('text', { 'font-size': Math.max(8, r * 0.62), y: -r * 0.12 }, group);
      label.textContent = id;
      const inc = el('text', { class: 'inc', 'font-size': Math.max(6, r * 0.4), y: r * 0.52 }, group);
      this.nodes.set(id, { group, inc, halo });
    });
  }

  render(s: RingState): void {
    for (const id of this.ids) {
      const els = this.nodes.get(id)!;
      const cls = ['node'];
      if (!s.isUp(id)) cls.push('down');
      if (s.isSlow(id)) cls.push('slow');
      if (s.selected.has(id)) cls.push('selected');
      if (s.isIsolated(id)) cls.push('isolated');
      set(els.group, 'class', cls.join(' '));
      const inc = `i${s.incarnation(id)}`;
      if (els.inc.textContent !== inc) els.inc.textContent = inc;
      for (const [observer, path] of els.halo) {
        const belief = s.belief(observer, id) ?? '';
        set(path, 'class', `halo ${belief}${s.isUp(observer) ? '' : ' stale'}`);
      }
    }
    this.renderPackets(s);
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
      set(dot, 'class', `pk ${p.kind}${p.lost ? ' lost' : ''}`);
      dot.setAttribute('cx', (a.x + (b.x - a.x) * f).toFixed(1));
      dot.setAttribute('cy', (a.y + (b.y - a.y) * f).toFixed(1));
      dot.setAttribute('opacity', p.lost ? (1 - progress).toFixed(2) : '1');
    });
  }
}
