import type { Input, NodeId, SimEvent } from '../engine/types.ts';
import type { Update } from '../swim/membership.ts';

/** What the narrator may ask the simulation about. */
export interface WorldView {
  isUp(id: NodeId): boolean;
  slowNodes(): NodeId[];
}

export interface Line {
  text: string;
  /** Higher is shown sooner when several things are waiting. */
  prio: number;
  /** A newer line of the same kind replaces an older one that has not been shown yet. */
  kind: string;
  /** Wall-clock time it was first queued; lines that wait too long are dropped as stale. */
  queuedAt?: number;
}

/** Shortest time a sentence stays up, and how long a waiting one stays worth showing. */
const DWELL = 3000;
const URGENT_DWELL = 1200;
const STALE_AFTER = 20_000;
const MAX_BACKLOG = 4;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Turns simulation events into one plain sentence at a time, so a viewer can
 * follow what the cluster is doing. Events are translated as they happen; the
 * sentence on screen only changes once it has been readable for a while, and
 * the most important thing that happened in the meantime wins.
 */
export class Narrator {
  private readonly world: WorldView;
  private pending: Line[] = [];
  private shown: Line = { text: '', prio: 0, kind: 'idle' };
  /** Wall-clock time of the latest frame, so queued lines can be dated. */
  private wall = 0;
  private shownAt = 0;
  /** Subjects someone currently suspects or has called dead, so each episode is announced once. */
  private suspected = new Set<NodeId>();
  private declaredDead = new Set<NodeId>();

  constructor(world: WorldView) {
    this.world = world;
  }

  /** Starts over with an opening sentence. */
  reset(text: string): void {
    this.pending = [];
    this.suspected.clear();
    this.declaredDead.clear();
    this.shown = { text, prio: 0, kind: 'opening' };
    this.shownAt = -Infinity;
  }

  push(text: string, prio: number, kind: string): void {
    this.pending = this.pending.filter((l) => l.kind !== kind);
    this.pending.push({ text, prio, kind, queuedAt: this.wall });
  }

  onEvent(e: SimEvent): void {
    if (e.type === 'input') return this.onInput(e.input);
    if (e.type !== 'state') return;
    switch (e.kind) {
      case 'member':
        return this.onMember(e.node, e.data as Update);
      case 'hint': {
        const d = e.data as { for: NodeId; key: string };
        this.push(`${d.for} isn't answering, so ${e.node} keeps ${d.key} for it as a hint.`, 3, 'hint');
        return;
      }
      case 'handoff': {
        const d = e.data as { from: NodeId; keys: number };
        this.push(`${d.from} hands ${plural(d.keys, 'held write')} back to ${e.node}, which is caught up again.`, 3, 'handoff');
        return;
      }
      case 'repair': {
        const d = e.data as { key: string; to: NodeId[] };
        this.push(`A read found an old copy of ${d.key} on ${d.to.join(', ')} and fixed it.`, 2, 'repair');
        return;
      }
      case 'ae': {
        const d = e.data as { peer: NodeId; changed: number };
        if (d.changed > 0) this.push(`${e.node} compared fingerprints with ${d.peer} and fixed ${plural(d.changed, 'stale key')}.`, 2, 'ae');
        return;
      }
      case 'hedge':
        this.push('A read was slower than usual, so it asked another copy too instead of waiting.', 2, 'hedge');
        return;
      case 'hot': {
        const d = e.data as { key: string; on: boolean };
        this.push(
          d.on ? `${d.key} is read very often, so ${e.node} lends extra copies to spread the load.` : `${d.key} cooled down, so its extra copies are dropped.`,
          d.on ? 3 : 2,
          `hot:${d.key}`,
        );
        return;
      }
      case 'res': {
        const d = e.data as { ok: boolean };
        if (d.ok) return;
        const slow = this.world.slowNodes();
        this.push(
          slow.length ? `A request failed after waiting too long for slow ${slow.join(', ')}.` : 'A request failed: too few copies answered in time.',
          3,
          'fail',
        );
        return;
      }
    }
  }

  /** Called when a majority of the cluster starts or stops believing a node is dead. */
  majorityDead(id: NodeId, dead: boolean): void {
    const up = this.world.isUp(id);
    if (dead) {
      this.push(
        up ? `Most nodes now wrongly think ${id} is dead, though it is fine.` : `Most nodes now agree ${id} is dead. Its writes go to stand-ins.`,
        up ? 5 : 4,
        `majority:${id}`,
      );
    } else if (up) {
      this.push(`${id} is accepted as alive again.`, 2, `majority:${id}`);
    }
  }

  private onMember(observer: NodeId, u: Update): void {
    if (u.status === 'alive') {
      const wasDoubted = this.suspected.delete(u.id);
      this.declaredDead.delete(u.id);
      if (wasDoubted && u.id === observer && u.inc > 0) this.push(`${u.id} tells everyone it is alive, so the doubt is dropped.`, 2, `refute:${u.id}`);
      return;
    }
    if (u.id === observer) return;
    const fine = this.world.isUp(u.id);
    const slow = this.world.slowNodes().includes(u.id);
    const why = slow ? 'it is only slow' : this.world.slowNodes().includes(observer) ? `${observer} is the slow one` : 'a packet was lost';
    if (u.status === 'suspect' && !this.suspected.has(u.id)) {
      this.suspected.add(u.id);
      this.push(
        fine
          ? `${observer} got no answer from ${u.id} and suspects it, though ${u.id} is fine (${why}).`
          : `${observer} got no answer from ${u.id} and suspects it.`,
        3,
        `suspect:${u.id}`,
      );
    } else if (u.status === 'dead' && !this.declaredDead.has(u.id)) {
      this.declaredDead.add(u.id);
      this.push(
        fine ? `${observer} wrongly calls ${u.id} dead. ${u.id} is fine (${why}).` : `${observer} gives up on ${u.id} and calls it dead.`,
        fine ? 5 : 3,
        `dead:${u.id}`,
      );
    }
  }

  private onInput(i: Input): void {
    switch (i.type) {
      case 'kill':
        return this.push(`${i.node} crashed.`, 4, `input:${i.node}`);
      case 'restart':
        return this.push(`${i.node} is back, with the data it had before.`, 4, `input:${i.node}`);
      case 'slow':
        return this.push(i.factor === 1 ? `${i.node} is back to normal speed.` : `${i.node} is now ${i.factor}x slower. It still answers, just late.`, 4, `input:${i.node}`);
      case 'partition':
        return this.push(`${i.groups[0].join(', ')} can no longer reach the other nodes.`, 4, 'input:net');
      case 'heal':
        return this.push('The network is repaired.', 4, 'input:net');
      case 'network':
        if (i.patch.loss !== undefined) this.push(i.patch.loss > 0 ? `The network now drops ${Math.round(i.patch.loss * 100)}% of packets.` : 'The network stopped dropping packets.', 4, 'input:loss');
        return;
      case 'config': {
        const share = i.patch.hotShare;
        if (share !== undefined) this.push(share > 0 ? `${Math.round(share * 100)}% of requests now ask for the same key, k0.` : 'Requests are spread over all keys again.', 4, 'input:hot');
        return;
      }
    }
  }

  /**
   * The sentence to show at wall-clock time `wall`. `idle` supplies a
   * description of the current state, used when nothing has happened for a while.
   */
  current(wall: number, idle: () => string): string {
    this.wall = wall;
    this.pending = this.pending.filter((l) => wall - (l.queuedAt ?? wall) < STALE_AFTER);
    // Too much waiting: drop the least important, oldest line until the backlog is short.
    while (this.pending.length > MAX_BACKLOG) {
      const drop = this.pending.reduce((a, b) => (b.prio < a.prio ? b : a));
      this.pending = this.pending.filter((l) => l !== drop);
    }
    const age = wall - this.shownAt;
    if (this.pending.length > 0) {
      // Tell the story in the order it happened; only something big (a crash, a wrong verdict) cuts the wait short.
      const next = this.pending[0];
      const urgent = next.prio >= 4 && this.shown.prio < 4;
      if (age >= (urgent ? URGENT_DWELL : DWELL)) {
        this.shown = next;
        this.shownAt = wall;
        this.pending.shift();
      }
    } else if (age >= 3 * DWELL && this.shown.prio > 0) {
      this.shown = { text: idle(), prio: 0, kind: 'idle' };
      this.shownAt = wall;
    }
    return this.shown.text;
  }
}
