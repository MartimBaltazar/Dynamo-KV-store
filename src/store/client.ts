import type { Rng } from '../engine/rng.ts';
import type { Ctx, NodeId, SimNode } from '../engine/types.ts';
import { LatencyTable } from './latency.ts';
import type { ClientRequest, ClusterConfig, Msg } from './messages.ts';
import { contextOf, type VClock } from './vclock.ts';

type C = Ctx<Msg>;

/** Data of the client's `req` and `res` state events. */
export interface ClientReq {
  id: string;
  op: 'get' | 'put';
  key: string;
  coord: NodeId;
}

export interface ClientRes {
  id: string;
  op: 'get' | 'put';
  key: string;
  ok: boolean;
  latency: number;
  /** Number of versions a read returned. */
  siblings: number;
  /** Read: the context returned. Write: the clock of the version written. */
  clock: VClock;
}

/**
 * A simulated client. It talks to the cluster over the same lossy network as
 * everyone else, generates the background workload, and carries out requests
 * injected from outside. Like a real Dynamo client it remembers the context of
 * what it last read per key and sends it back when writing.
 */
export class ClientNode implements SimNode<Msg> {
  readonly id: NodeId;
  private readonly cfg: ClusterConfig;
  private readonly nodes: NodeId[];
  private readonly contexts = new Map<string, VClock>();
  private readonly pending = new Map<string, { op: 'get' | 'put'; key: string; t0: number; coord: NodeId; sent: Map<NodeId, number> }>();
  private readonly latency = new LatencyTable();
  /** Coordinators that recently failed to answer: until when to avoid them, and the backoff. */
  private readonly avoid = new Map<NodeId, { until: number; backoff: number }>();
  private zipf: { key: string; cumulative: number[] } | null = null;
  private seq = 0;
  private now = 0;

  constructor(id: NodeId, cfg: ClusterConfig, nodes: NodeId[]) {
    this.id = id;
    this.cfg = cfg;
    this.nodes = nodes;
  }

  onStart(ctx: C): void {
    ctx.setTimer(500 + ctx.rng.int(500), 'tick');
  }

  onTimer(tag: string, ctx: C): void {
    if (tag === 'tick') {
      const rate = this.cfg.rate;
      // Uniform jitter around the mean gap keeps clients from marching in step.
      ctx.setTimer(rate > 0 ? (1000 / rate) * (0.5 + ctx.rng.next()) : 200, 'tick');
      if (rate > 0) {
        const op = ctx.rng.chance(this.cfg.readRatio) ? 'get' : 'put';
        this.issue({ op, key: this.pickKey(ctx.rng) }, ctx);
      }
    } else if (tag.startsWith('hg:')) {
      this.hedgeRead(tag.slice(3), ctx);
    } else if (tag.startsWith('to:')) {
      const id = tag.slice(3);
      const p = this.pending.get(id);
      if (!p) return;
      // Back off from a silent coordinator, doubling each time it stays silent.
      for (const [coord, at] of p.sent) this.latency.stillWaiting(coord, ctx.now - at, ctx.now);
      const backoff = Math.min(60_000, (this.avoid.get(p.coord)?.backoff ?? 2500) * 2);
      this.avoid.set(p.coord, { until: ctx.now + backoff, backoff });
      this.done(id, false, 0, {}, ctx);
    }
  }

  onRequest(payload: unknown, ctx: C): void {
    this.issue(payload as ClientRequest, ctx);
  }

  onMessage(from: NodeId, msg: Msg, ctx: C): void {
    if (msg.type !== 'get-res' && msg.type !== 'put-res') return;
    const asked = this.pending.get(msg.id)?.sent.get(from);
    if (asked !== undefined) this.latency.observe(from, ctx.now - asked, ctx.now);
    if (msg.type === 'get-res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      const context = contextOf(msg.versions);
      if (msg.ok) this.contexts.set(p.key, context);
      this.done(msg.id, msg.ok, msg.versions.length, context, ctx);
    } else if (msg.type === 'put-res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.ok) this.contexts.set(p.key, msg.clock);
      this.done(msg.id, msg.ok, 0, msg.clock, ctx);
    }
  }

  private issue(req: ClientRequest, ctx: C): void {
    this.now = ctx.now;
    const id = `${this.id}:${++this.seq}`;
    const candidates = this.nodes.filter((n) => (this.avoid.get(n)?.until ?? 0) <= ctx.now);
    const coord = req.via ?? this.choose(candidates.length ? candidates : this.nodes, ctx.rng);
    this.pending.set(id, { op: req.op, key: req.key, t0: ctx.now, coord, sent: new Map([[coord, ctx.now]]) });
    ctx.emit('req', { id, op: req.op, key: req.key, coord } satisfies ClientReq);
    if (req.op === 'get') {
      ctx.send(coord, { type: 'get', id, key: req.key });
    } else {
      const context = req.blind ? {} : (this.contexts.get(req.key) ?? {});
      ctx.send(coord, { type: 'put', id, key: req.key, value: req.value ?? `${this.id}#${this.seq}`, context });
    }
    ctx.setTimer(this.cfg.requestTimeout * 3, `to:${id}`);
    if (this.cfg.hedge && req.op === 'get') ctx.setTimer(this.hedgeDelay(coord, ctx.now), `hg:${id}`);
  }

  /** Classic: any coordinator at random. Smart: the one that has answered fastest lately, with a little noise. */
  private choose(candidates: NodeId[], rng: Rng): NodeId {
    if (!this.cfg.smartRouting) return rng.pick(candidates);
    const now = this.now;
    let best = candidates[0];
    let bestScore = Infinity;
    for (const id of candidates) {
      const score = (this.latency.get(id, now) ?? 0) * (1 + 0.2 * rng.next());
      if (score < bestScore) [best, bestScore] = [id, score];
    }
    return best;
  }

  private hedgeDelay(coord: NodeId, now: number): number {
    return Math.min(Math.max(20, (this.latency.get(coord, now) ?? 100) * 2), this.cfg.requestTimeout);
  }

  /**
   * The coordinator is slower than usual: send the same read through another
   * one and take whichever answers first. Only reads are hedged; a write sent
   * twice would become two versions.
   */
  private hedgeRead(id: string, ctx: C): void {
    const p = this.pending.get(id);
    if (!p || p.sent.size > 1) return;
    this.latency.stillWaiting(p.coord, ctx.now - p.t0, ctx.now);
    const others = this.nodes.filter((n) => n !== p.coord && (this.avoid.get(n)?.until ?? 0) <= ctx.now);
    if (others.length === 0) return;
    const second = this.choose(others, ctx.rng);
    p.sent.set(second, ctx.now);
    ctx.emit('hedge', { by: 'client', key: p.key });
    ctx.send(second, { type: 'get', id, key: p.key });
  }

  private done(id: string, ok: boolean, siblings: number, clock: VClock, ctx: C): void {
    const p = this.pending.get(id)!;
    this.pending.delete(id);
    if (ok) this.avoid.delete(p.coord);
    ctx.emit('res', { id, op: p.op, key: p.key, ok, latency: ctx.now - p.t0, siblings, clock } satisfies ClientRes);
  }

  private pickKey(rng: Rng): string {
    if (this.cfg.hotShare > 0 && rng.chance(this.cfg.hotShare)) return 'k0';
    const count = Math.max(1, Math.round(this.cfg.keys));
    const s = this.cfg.zipf;
    if (s <= 0) return `k${rng.int(count)}`;
    const cacheKey = `${count}:${s}`;
    if (this.zipf?.key !== cacheKey) {
      let total = 0;
      const cumulative = Array.from({ length: count }, (_, i) => (total += 1 / (i + 1) ** s));
      this.zipf = { key: cacheKey, cumulative: cumulative.map((c) => c / total) };
    }
    const x = rng.next();
    const i = this.zipf.cumulative.findIndex((c) => x < c);
    return `k${i < 0 ? count - 1 : i}`;
  }
}
