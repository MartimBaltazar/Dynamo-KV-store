import type { SimEvent } from '../engine/types.ts';
import type { ClientReq, ClientRes } from './client.ts';
import { descends, merge, type VClock } from './vclock.ts';

const LATENCY_WINDOW = 500;

/**
 * Store-level metrics derived from the event log. The interesting one is the
 * stale read: a successful read that did not reflect a write acknowledged
 * before the read began.
 */
export class StoreMetrics {
  gets = { ok: 0, fail: 0 };
  puts = { ok: 0, fail: 0 };
  staleReads = 0;
  siblingReads = 0;
  readRepairs = 0;
  hintsStored = 0;
  hintsDelivered = 0;
  /** Keys shipped / actually changed by Merkle anti-entropy. */
  aeKeysSent = 0;
  aeKeysRepaired = 0;
  /** Extra requests sent because the first choice was slow. */
  hedges = 0;

  /** Per key: merged clock of every acknowledged write. */
  private readonly acked = new Map<string, VClock>();
  /** Per in-flight read: what had been acknowledged when it started. */
  private readonly readsInFlight = new Map<string, VClock | undefined>();
  private readonly latencies: number[] = [];

  onEvent(e: SimEvent): void {
    if (e.type !== 'state') return;
    switch (e.kind) {
      case 'req': {
        const req = e.data as ClientReq;
        if (req.op === 'get') this.readsInFlight.set(req.id, this.acked.get(req.key));
        return;
      }
      case 'res':
        return this.onResponse(e.data as ClientRes);
      case 'repair':
        this.readRepairs += (e.data as { to: string[] }).to.length;
        return;
      case 'hint':
        this.hintsStored++;
        return;
      case 'hedge':
        this.hedges++;
        return;
      case 'handoff':
        this.hintsDelivered += (e.data as { keys: number }).keys;
        return;
      case 'ae': {
        const d = e.data as { received: number; changed: number };
        this.aeKeysSent += d.received;
        this.aeKeysRepaired += d.changed;
        return;
      }
    }
  }

  /** Latency percentile (0..1) over recent requests, failures included; NaN when there are none. */
  percentile(p: number): number {
    if (this.latencies.length === 0) return NaN;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }

  get availability(): number {
    const ok = this.gets.ok + this.puts.ok;
    const total = ok + this.gets.fail + this.puts.fail;
    return total === 0 ? 1 : ok / total;
  }

  private onResponse(res: ClientRes): void {
    const tally = res.op === 'get' ? this.gets : this.puts;
    if (res.ok) tally.ok++;
    else tally.fail++;
    // A failed request counts at the moment the client gave up, so failures cannot hide in the percentile.
    this.latencies.push(res.latency);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
    if (res.op === 'put') {
      if (res.ok) this.acked.set(res.key, merge(this.acked.get(res.key) ?? {}, res.clock));
      return;
    }
    const mustReflect = this.readsInFlight.get(res.id);
    this.readsInFlight.delete(res.id);
    if (!res.ok) return;
    if (mustReflect && !descends(res.clock, mustReflect)) this.staleReads++;
    if (res.siblings > 1) this.siblingReads++;
  }
}
