/**
 * Infection-style dissemination buffer. Items ride piggyback on protocol
 * messages; each is sent a bounded number of times (about log N) and then
 * forgotten. Freshest news goes first.
 *
 * Generic over the payload so later phases can gossip more than membership
 * (for example per-range Merkle roots) through the same channel.
 */
export class Disseminator<T> {
  private readonly queue = new Map<string, { item: T; sends: number }>();

  get size(): number {
    return this.queue.size;
  }

  /** Queues an item, replacing any older item with the same key. */
  enqueue(key: string, item: T): void {
    this.queue.delete(key);
    this.queue.set(key, { item, sends: 0 });
  }

  /**
   * Picks up to `max` items, least-sent first, and counts the transmission.
   * Items that have now been sent `limit` times are dropped.
   */
  take(max: number, limit: number): T[] {
    const picked = [...this.queue.entries()]
      .sort((a, b) => a[1].sends - b[1].sends)
      .slice(0, Math.max(0, max));
    for (const [key, entry] of picked) {
      entry.sends++;
      if (entry.sends >= limit) this.queue.delete(key);
    }
    return picked.map(([, entry]) => entry.item);
  }
}

/** Retransmit limit: multiplier * ceil(log2(n + 1)), at least 1. */
export function retransmitLimit(multiplier: number, clusterSize: number): number {
  return Math.max(1, Math.ceil(multiplier * Math.log2(clusterSize + 1)));
}
