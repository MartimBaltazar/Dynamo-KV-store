import type { NodeId, SimEvent } from '../engine/types.ts';
import type { CoordStart } from '../store/coordinator.ts';

const SHOWN = 12;

interface Row {
  t: number;
  coord: NodeId;
  start: CoordStart;
  acks: NodeId[];
  done: boolean;
  ok: boolean;
}

/**
 * Recent coordinated requests: which replicas each fanned out to, how many
 * acks have come back against the quorum it needs, and how it ended.
 */
export class RequestView {
  private readonly root: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private dirty = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'requests';
    parent.appendChild(this.root);
  }

  clear(): void {
    this.rows.clear();
    this.dirty = true;
  }

  onEvent(e: SimEvent): void {
    if (e.type !== 'state') return;
    const d = e.data as { rid: number };
    const id = `${e.node}:${d?.rid}`;
    if (e.kind === 'coord') {
      this.rows.set(id, { t: e.t, coord: e.node, start: e.data as CoordStart, acks: [], done: false, ok: false });
      if (this.rows.size > SHOWN * 3) for (const k of [...this.rows.keys()].slice(0, this.rows.size - SHOWN)) this.rows.delete(k);
    } else if (e.kind === 'coord-ack') {
      this.rows.get(id)?.acks.push((e.data as { from: NodeId }).from);
    } else if (e.kind === 'coord-done') {
      const row = this.rows.get(id);
      if (row) {
        row.done = true;
        row.ok = (e.data as { ok: boolean }).ok;
      }
    } else return;
    this.dirty = true;
  }

  render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const recent = [...this.rows.values()].slice(-SHOWN).reverse();
    this.root.replaceChildren(
      ...recent.map((r) => {
        const line = document.createElement('div');
        const quorum = r.acks.length >= r.start.need;
        line.className = r.done ? (r.ok ? 'ok' : 'fail') : quorum ? 'ok' : 'wait';
        const head = document.createElement('span');
        head.textContent = `${(r.t / 1000).toFixed(2)}s ${r.start.op} ${r.start.key} @${r.coord} `;
        line.appendChild(head);
        for (const target of r.start.targets) {
          const chip = document.createElement('i');
          chip.textContent = target;
          if (r.acks.includes(target)) chip.className = 'acked';
          line.appendChild(chip);
        }
        const tail = document.createElement('b');
        tail.textContent = ` ${r.acks.length}/${r.start.need}${r.done ? (r.ok ? '' : ' failed') : ''}`;
        line.appendChild(tail);
        return line;
      }),
    );
  }
}
