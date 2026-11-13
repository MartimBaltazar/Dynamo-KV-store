import type { Ctx, NodeId } from '../engine/types.ts';
import type { Ring } from '../ring/ring.ts';
import { LatencyTable } from './latency.ts';
import type { Msg, StoreConfig } from './messages.ts';
import { fingerprint, reconcile, type VClock, type Version } from './vclock.ts';

/** What the coordinator needs from the node it lives in. */
export interface CoordHost {
  readonly id: NodeId;
  readonly cfg: StoreConfig;
  ring(): Ring;
  /** SWIM's verdict. Only used to skip replicas, never to change the ring. */
  isDead(id: NodeId): boolean;
  storeLocal(key: string, version: Version, hintFor: NodeId | undefined, ctx: Ctx<Msg>): void;
  readLocal(key: string, ctx: Ctx<Msg>): Version[];
  repairLocal(key: string, versions: Version[], ctx: Ctx<Msg>): void;
  /** Runs a replica operation on this node's work queue. */
  defer(ctx: Ctx<Msg>, job: () => void): void;
  /** This node's recent replica operations per second. */
  loadNow(now: number): number;
}

interface Target {
  node: NodeId;
  /** Set when `node` is a stand-in for an owner believed dead. */
  hintFor?: NodeId;
}

interface Pending {
  op: 'get' | 'put';
  client: NodeId;
  id: string;
  key: string;
  need: number;
  /** Everyone whose answer counts. */
  targets: NodeId[];
  /** Hedged reads: candidates not asked yet, best first. */
  spare: NodeId[];
  /** Who has been asked, and when. */
  sentAt: Map<NodeId, number>;
  acked: Set<NodeId>;
  responses: Map<NodeId, Version[]>;
  replied: boolean;
  ok: boolean;
  clock: VClock;
}

/** Data of the `coord` state event, for the request view. */
export interface CoordStart {
  rid: number;
  op: 'get' | 'put';
  key: string;
  targets: NodeId[];
  need: number;
}

const HOT_MEMORY = 2000;
const UNKNOWN_LATENCY = 50;

/**
 * Coordinates client requests: fans out to the key's replicas, answers the
 * client once R or W of them have replied, and repairs stale replicas after
 * a read. Any node can coordinate any key.
 *
 * Classic reads ask all N owners. With `hedge` on, a read asks only R
 * replicas and widens the net one replica at a time if they are slow.
 */
export class Coordinator {
  private readonly host: CoordHost;
  private readonly pending = new Map<number, Pending>();
  /** Per key, the highest counter this node has issued. Kept across restarts. */
  private readonly issued: Map<string, number>;
  private readonly latency = new LatencyTable();
  /** Last load each peer reported, replica ops per second. */
  private readonly load = new Map<NodeId, number>();
  /** Keys known to have extra read replicas right now: how many, and until when to believe it. */
  private readonly hot = new Map<string, { extras: number; until: number }>();
  private seq = 0;

  constructor(host: CoordHost, issued = new Map<string, number>()) {
    this.host = host;
    this.issued = issued;
  }

  /** State that must survive a restart. */
  get durable(): Map<string, number> {
    return this.issued;
  }

  /**
   * Clock for a new write: the client's context with this node's entry moved
   * past everything this node has issued for the key, so no two writes share
   * a clock.
   *
   * Classic Dynamo limitation, kept on purpose: two clients writing through
   * the SAME coordinator without reading in between do not become siblings;
   * the second silently supersedes the first. Through different coordinators
   * they do become siblings.
   */
  private nextClock(key: string, context: VClock): VClock {
    const self = this.host.id;
    const counter = Math.max(context[self] ?? 0, this.issued.get(key) ?? 0) + 1;
    this.issued.set(key, counter);
    return { ...context, [self]: counter };
  }

  /**
   * Replicas to contact. Strict quorum: exactly the N owners. Sloppy quorum:
   * owners believed dead are replaced by the next healthy nodes on the ring,
   * which hold the write as a hint.
   */
  plan(key: string): Target[] {
    const { cfg } = this.host;
    const walk = this.host.ring().walk(key);
    const owners = walk.slice(0, Math.round(cfg.n));
    if (!cfg.sloppy) return owners.map((node) => ({ node }));
    const standIns = walk.slice(owners.length).filter((id) => !this.host.isDead(id));
    const out: Target[] = [];
    for (const owner of owners) {
      if (!this.host.isDead(owner)) out.push({ node: owner });
      else if (standIns.length) out.push({ node: standIns.shift()!, hintFor: owner });
    }
    return out;
  }

  put(client: NodeId, id: string, key: string, value: string, context: VClock, ctx: Ctx<Msg>): void {
    const version: Version = { value, clock: this.nextClock(key, context) };
    const targets = this.plan(key);
    const nodes = targets.map((t) => t.node);
    const rid = this.begin('put', client, id, key, Math.round(this.host.cfg.w), nodes, nodes, [], version.clock, ctx);
    for (const t of targets) {
      if (t.node === this.host.id) {
        this.host.defer(ctx, () => {
          this.host.storeLocal(key, version, t.hintFor, ctx);
          this.onStoreAck(this.host.id, rid, ctx);
        });
      } else {
        ctx.send(t.node, { type: 'store', rid, key, version, hintFor: t.hintFor });
      }
    }
  }

  get(client: NodeId, id: string, key: string, ctx: Ctx<Msg>): void {
    const { cfg } = this.host;
    const need = Math.round(cfg.r);
    const owners = this.plan(key).map((t) => t.node);
    if (!cfg.hedge) {
      const rid = this.begin('get', client, id, key, need, owners, owners, [], {}, ctx);
      for (const node of owners) this.fetch(rid, key, node, ctx);
      return;
    }
    const candidates = this.rank(key, [...owners, ...this.extraReplicas(key, owners, ctx.now)], ctx);
    const first = candidates.slice(0, need);
    const rid = this.begin('get', client, id, key, need, candidates, first, candidates.slice(need), {}, ctx);
    for (const node of first) this.fetch(rid, key, node, ctx);
    ctx.setTimer(this.hedgeDelay(first, ctx.now), `kv:hg:${rid}`);
  }

  /** The asked replicas are slower than usual: ask one more. */
  onHedge(rid: number, ctx: Ctx<Msg>): void {
    const p = this.pending.get(rid);
    if (!p || p.replied) return;
    this.noteSilent(p, ctx.now);
    const next = p.spare.shift();
    if (next === undefined) return;
    ctx.emit('hedge', { by: 'coordinator', key: p.key });
    p.sentAt.set(next, ctx.now);
    this.fetch(rid, p.key, next, ctx);
    ctx.setTimer(this.hedgeDelay([next], ctx.now), `kv:hg:${rid}`);
  }

  onStoreAck(from: NodeId, rid: number, ctx: Ctx<Msg>, load?: number): void {
    const p = this.pending.get(rid);
    if (!p || p.op !== 'put' || p.acked.has(from) || !p.targets.includes(from)) return;
    this.observe(p, from, load, ctx.now);
    this.progress(p, rid, from, ctx);
  }

  onFetchRes(from: NodeId, rid: number, versions: Version[], ctx: Ctx<Msg>, load?: number, hot = 0): void {
    const p = this.pending.get(rid);
    if (!p || p.op !== 'get' || p.acked.has(from) || !p.targets.includes(from)) return;
    this.observe(p, from, load, ctx.now);
    if (hot > 0) this.hot.set(p.key, { extras: hot, until: ctx.now + HOT_MEMORY });
    p.responses.set(from, versions);
    this.progress(p, rid, from, ctx);
  }

  onTimeout(rid: number, ctx: Ctx<Msg>): void {
    if (this.pending.has(rid)) this.finish(rid, ctx);
  }

  // --- improved read routing ---------------------------------------------------

  /** A hot key can also be read from the next nodes round the ring, which hold a lent copy. */
  private extraReplicas(key: string, owners: NodeId[], now: number): NodeId[] {
    const { cfg } = this.host;
    const hot = this.hot.get(key);
    if (!cfg.hotKeys || !hot || hot.until <= now) return [];
    const n = Math.round(cfg.n);
    return this.host
      .ring()
      .walk(key, n + hot.extras)
      .slice(n)
      .filter((id) => !owners.includes(id) && !this.host.isDead(id));
  }

  /**
   * Orders read candidates best first. Normal keys: fastest lately, with a
   * little noise so coordinators do not all stampede the same replica, and
   * with a node above the load cap counted as twice as slow. Hot keys: nodes
   * within the cap in random order, to spread the load, then the rest.
   */
  private rank(key: string, candidates: NodeId[], ctx: Ctx<Msg>): NodeId[] {
    const { cfg } = this.host;
    let overloaded = (_id: NodeId) => false;
    if (cfg.loadCap > 0) {
      this.load.set(this.host.id, this.host.loadNow(ctx.now));
      const loads = [...this.load.values()];
      const limit = (loads.reduce((a, b) => a + b, 0) / loads.length) * cfg.loadCap;
      overloaded = (id) => limit > 5 && (this.load.get(id) ?? 0) > limit;
    }
    if (cfg.hotKeys > 0 && (this.hot.get(key)?.until ?? 0) > ctx.now) {
      const shuffled = ctx.rng.shuffle([...candidates]);
      return [...shuffled.filter((id) => !overloaded(id)), ...shuffled.filter(overloaded)];
    }
    if (!cfg.smartRouting) return [...candidates.filter((id) => !overloaded(id)), ...candidates.filter(overloaded)];
    const score = new Map(
      candidates.map((id) => [id, (this.latencyOf(id, ctx.now) + 1) * (1 + 0.2 * ctx.rng.next()) * (overloaded(id) ? 2 : 1)]),
    );
    return [...candidates].sort((a, b) => score.get(a)! - score.get(b)!);
  }

  private latencyOf(id: NodeId, now: number): number {
    return id === this.host.id ? 0 : (this.latency.get(id, now) ?? 0);
  }

  /** Twice the usual response time of the slowest replica asked. */
  private hedgeDelay(asked: NodeId[], now: number): number {
    const { cfg } = this.host;
    const usual = Math.max(...asked.map((id) => (id === this.host.id ? cfg.serviceTime : (this.latency.get(id, now) ?? UNKNOWN_LATENCY))));
    return Math.min(Math.max(10, usual * 2), cfg.requestTimeout / 2);
  }

  private observe(p: Pending, from: NodeId, load: number | undefined, now: number): void {
    if (from === this.host.id) return;
    this.latency.observe(from, now - (p.sentAt.get(from) ?? now), now);
    if (load !== undefined) this.load.set(from, load);
  }

  /** Replicas asked that have not answered are at least as slow as the wait so far. */
  private noteSilent(p: Pending, now: number): void {
    for (const [node, sentAt] of p.sentAt) {
      if (node !== this.host.id && !p.acked.has(node)) this.latency.stillWaiting(node, now - sentAt, now);
    }
  }

  // --- request lifecycle ---------------------------------------------------------

  private fetch(rid: number, key: string, node: NodeId, ctx: Ctx<Msg>): void {
    if (node === this.host.id) {
      this.host.defer(ctx, () => this.onFetchRes(node, rid, this.host.readLocal(key, ctx), ctx));
    } else {
      ctx.send(node, { type: 'fetch', rid, key });
    }
  }

  private begin(
    op: 'get' | 'put',
    client: NodeId,
    id: string,
    key: string,
    need: number,
    targets: NodeId[],
    askNow: NodeId[],
    spare: NodeId[],
    clock: VClock,
    ctx: Ctx<Msg>,
  ): number {
    const rid = ++this.seq;
    const sentAt = new Map(askNow.map((node) => [node, ctx.now]));
    this.pending.set(rid, { op, client, id, key, need, targets, spare, clock, sentAt, acked: new Set(), responses: new Map(), replied: false, ok: false });
    ctx.emit('coord', { rid, op, key, targets: askNow, need } satisfies CoordStart);
    ctx.setTimer(this.host.cfg.requestTimeout, `kv:rt:${rid}`);
    return rid;
  }

  private progress(p: Pending, rid: number, from: NodeId, ctx: Ctx<Msg>): void {
    p.acked.add(from);
    ctx.emit('coord-ack', { rid, from });
    if (!p.replied && p.acked.size >= p.need) this.reply(p, true, ctx);
    // Done when everyone asked has answered and nobody is left to ask.
    if (p.acked.size >= p.sentAt.size && (p.replied || p.spare.length === 0)) this.finish(rid, ctx);
  }

  private reply(p: Pending, ok: boolean, ctx: Ctx<Msg>): void {
    p.replied = true;
    p.ok = ok;
    if (p.op === 'put') ctx.send(p.client, { type: 'put-res', id: p.id, ok, clock: p.clock });
    else ctx.send(p.client, { type: 'get-res', id: p.id, ok, versions: ok ? reconcile([...p.responses.values()].flat()) : [] });
  }

  /** All replies are in, or time is up: answer if we have not, then read-repair. */
  private finish(rid: number, ctx: Ctx<Msg>): void {
    const p = this.pending.get(rid)!;
    this.pending.delete(rid);
    if (this.host.cfg.hedge) this.noteSilent(p, ctx.now);
    if (!p.replied) this.reply(p, false, ctx);
    if (p.op === 'get' && this.host.cfg.readRepair && p.responses.size > 0) this.readRepair(p, ctx);
    ctx.emit('coord-done', { rid, ok: p.ok, acks: p.acked.size });
  }

  private readRepair(p: Pending, ctx: Ctx<Msg>): void {
    const merged = reconcile([...p.responses.values()].flat());
    if (merged.length === 0) return;
    const want = fingerprint(merged);
    const owners = this.host.ring().preferenceList(p.key, Math.round(this.host.cfg.n));
    const behind = [...p.responses].filter(([node, v]) => owners.includes(node) && fingerprint(v) !== want).map(([node]) => node);
    for (const node of behind) {
      if (node === this.host.id) this.host.repairLocal(p.key, merged, ctx);
      else ctx.send(node, { type: 'repair', key: p.key, versions: merged });
    }
    if (behind.length) ctx.emit('repair', { key: p.key, to: behind });
  }
}
