import type { Ctx, NodeId } from '../engine/types.ts';
import type { Ring } from '../ring/ring.ts';
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
  readLocal(key: string): Version[];
  repairLocal(key: string, versions: Version[]): void;
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
  targets: NodeId[];
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

/**
 * Coordinates client requests: fans out to the key's replicas, answers the
 * client once R or W of them have replied, and repairs stale replicas after
 * a read. Any node can coordinate any key.
 */
export class Coordinator {
  private readonly host: CoordHost;
  private readonly pending = new Map<number, Pending>();
  /** Per key, the highest counter this node has issued. Kept across restarts. */
  private readonly issued: Map<string, number>;
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
    const rid = this.begin('put', client, id, key, Math.round(this.host.cfg.w), targets, version.clock, ctx);
    for (const t of targets) {
      if (t.node === this.host.id) {
        this.host.storeLocal(key, version, t.hintFor, ctx);
        this.onStoreAck(this.host.id, rid, ctx);
      } else {
        ctx.send(t.node, { type: 'store', rid, key, version, hintFor: t.hintFor });
      }
    }
  }

  get(client: NodeId, id: string, key: string, ctx: Ctx<Msg>): void {
    const targets = this.plan(key);
    const rid = this.begin('get', client, id, key, Math.round(this.host.cfg.r), targets, {}, ctx);
    for (const t of targets) {
      if (t.node === this.host.id) this.onFetchRes(this.host.id, rid, this.host.readLocal(key), ctx);
      else ctx.send(t.node, { type: 'fetch', rid, key });
    }
  }

  onStoreAck(from: NodeId, rid: number, ctx: Ctx<Msg>): void {
    const p = this.pending.get(rid);
    if (!p || p.op !== 'put' || p.acked.has(from) || !p.targets.includes(from)) return;
    this.progress(p, rid, from, ctx);
  }

  onFetchRes(from: NodeId, rid: number, versions: Version[], ctx: Ctx<Msg>): void {
    const p = this.pending.get(rid);
    if (!p || p.op !== 'get' || p.acked.has(from) || !p.targets.includes(from)) return;
    p.responses.set(from, versions);
    this.progress(p, rid, from, ctx);
  }

  onTimeout(rid: number, ctx: Ctx<Msg>): void {
    if (this.pending.has(rid)) this.finish(rid, ctx);
  }

  private begin(
    op: 'get' | 'put',
    client: NodeId,
    id: string,
    key: string,
    need: number,
    targets: Target[],
    clock: VClock,
    ctx: Ctx<Msg>,
  ): number {
    const rid = ++this.seq;
    const nodes = targets.map((t) => t.node);
    this.pending.set(rid, { op, client, id, key, need, targets: nodes, acked: new Set(), responses: new Map(), replied: false, ok: false, clock });
    ctx.emit('coord', { rid, op, key, targets: nodes, need } satisfies CoordStart);
    ctx.setTimer(this.host.cfg.requestTimeout, `kv:rt:${rid}`);
    return rid;
  }

  private progress(p: Pending, rid: number, from: NodeId, ctx: Ctx<Msg>): void {
    p.acked.add(from);
    ctx.emit('coord-ack', { rid, from });
    if (!p.replied && p.acked.size >= p.need) this.reply(p, true, ctx);
    if (p.acked.size === p.targets.length) this.finish(rid, ctx);
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
      if (node === this.host.id) this.host.repairLocal(p.key, merged);
      else ctx.send(node, { type: 'repair', key: p.key, versions: merged });
    }
    if (behind.length) ctx.emit('repair', { key: p.key, to: behind });
  }
}
