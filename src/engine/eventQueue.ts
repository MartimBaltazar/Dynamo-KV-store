export interface Scheduled<T> {
  time: number;
  seq: number;
  item: T;
}

/**
 * Min-heap ordered by (time, insertion sequence). The sequence tiebreak makes
 * the order of simultaneous events fully deterministic.
 */
export class EventQueue<T> {
  private heap: Scheduled<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  /** Time of the earliest event, or Infinity when empty. */
  peekTime(): number {
    return this.heap.length ? this.heap[0].time : Infinity;
  }

  push(time: number, item: T): void {
    const entry = { time, seq: this.seq++, item };
    const h = this.heap;
    let i = h.length;
    h.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(entry, h[parent])) break;
      h[i] = h[parent];
      i = parent;
    }
    h[i] = entry;
  }

  pop(): Scheduled<T> | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= h.length) break;
        if (child + 1 < h.length && before(h[child + 1], h[child])) child++;
        if (!before(h[child], last)) break;
        h[i] = h[child];
        i = child;
      }
      h[i] = last;
    }
    return top;
  }
}

function before<T>(a: Scheduled<T>, b: Scheduled<T>): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}
