import type { NodeId } from '../engine/types.ts';

const HALF_LIFE = 20_000;

/**
 * Smoothed response time per peer. Two details matter:
 *
 * - A peer that has not answered yet still tells us something: it is at
 *   least as slow as the time waited so far. Without that, a peer whose
 *   replies always arrive after we stopped waiting would look fast forever.
 * - Old measurements fade, so a peer that was slow gets another chance.
 */
export class LatencyTable {
  private readonly entries = new Map<NodeId, { ms: number; at: number }>();

  /** A reply arrived after `ms`. */
  observe(id: NodeId, ms: number, now: number): void {
    const e = this.entries.get(id);
    this.entries.set(id, { ms: e ? e.ms * 0.8 + ms * 0.2 : ms, at: now });
  }

  /** No reply after `waited` ms: the peer is at least that slow right now. */
  stillWaiting(id: NodeId, waited: number, now: number): void {
    const e = this.entries.get(id);
    this.entries.set(id, { ms: Math.max(e?.ms ?? 0, waited), at: now });
  }

  /** Current estimate, or undefined for a peer never measured. */
  get(id: NodeId, now: number): number | undefined {
    const e = this.entries.get(id);
    return e && e.ms * 0.5 ** ((now - e.at) / HALF_LIFE);
  }
}
