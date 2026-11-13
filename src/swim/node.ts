import type { Ctx, NodeId, SimNode } from '../engine/types.ts';
import { Disseminator, retransmitLimit } from './gossip.ts';
import { MemberTable, type Update } from './membership.ts';

export interface SwimConfig {
  /** Length of one protocol period in ms: each node probes one member per period. */
  protocolPeriod: number;
  /** How long to wait for a direct ack before asking others to probe. */
  pingTimeout: number;
  /** Number of members asked to probe indirectly (the `k` of SWIM). */
  indirectK: number;
  /** How long a member stays suspect before it is declared dead. */
  suspectTimeout: number;
  /** Maximum membership updates piggybacked on one message. */
  piggybackMax: number;
  /** Each update is gossiped about multiplier * log2(N) times. */
  retransmitMult: number;
  /** Every this many periods, try one member believed dead (heals partitions). */
  reconnectEvery: number;
}

export const defaultSwimConfig: SwimConfig = {
  protocolPeriod: 1000,
  pingTimeout: 300,
  indirectK: 3,
  suspectTimeout: 3000,
  piggybackMax: 6,
  retransmitMult: 3,
  reconnectEvery: 5,
};

export type SwimMsg =
  | { type: 'ping'; seq: number; updates: Update[] }
  | { type: 'ack'; seq: number; updates: Update[] }
  | { type: 'ping-req'; seq: number; target: NodeId; updates: Update[] }
  | { type: 'join'; inc: number }
  | { type: 'join-ack'; members: Update[] };

/** Data of the `member` state event a node emits whenever its view changes. */
export interface MemberChange extends Update {}

type C = Ctx<SwimMsg>;

/**
 * One SWIM participant: failure detection by direct and indirect probing,
 * suspicion with incarnation-based refutation, and membership dissemination
 * piggybacked on the probe traffic.
 */
export class SwimNode implements SimNode<SwimMsg> {
  readonly id: NodeId;
  readonly table = new MemberTable();
  /** Own incarnation number. Survives restarts, like a value kept on disk. */
  inc: number;

  private readonly cfg: SwimConfig;
  private readonly gossip = new Disseminator<Update>();
  private readonly joinTargets: NodeId[];
  private joined: boolean;
  private probeOrder: NodeId[] = [];
  private probeIdx = 0;
  private probe: { seq: number; target: NodeId; acked: boolean } | null = null;
  /** Indirect probes in flight on behalf of others, keyed by our own seq. */
  private readonly relays = new Map<number, { origin: NodeId; originSeq: number; tick: number }>();
  private seq = 0;
  private ticks = 0;

  constructor(id: NodeId, cfg: SwimConfig, seeds: NodeId[], prev?: SwimNode) {
    this.id = id;
    this.cfg = cfg;
    this.inc = prev ? prev.inc + 1 : 0;
    const known = new Set([...seeds, ...(prev?.table.ids() ?? [])]);
    known.delete(id);
    this.joinTargets = [...known];
    this.joined = this.joinTargets.length === 0;
  }

  onStart(ctx: C): void {
    this.table.apply({ id: this.id, status: 'alive', inc: this.inc }, ctx.now);
    ctx.emit('member', { id: this.id, status: 'alive', inc: this.inc } satisfies MemberChange);
    this.sendJoin(ctx);
    // Random phase so nodes do not all probe at the same instant.
    ctx.setTimer(1 + ctx.rng.int(this.cfg.protocolPeriod), 'tick');
  }

  onTimer(tag: string, ctx: C): void {
    if (tag === 'tick') return this.tick(ctx);
    if (tag.startsWith('pt:')) return this.pingTimedOut(Number(tag.slice(3)), ctx);
    if (tag.startsWith('st:')) {
      const cut = tag.lastIndexOf(':');
      return this.suspicionExpired(tag.slice(3, cut), Number(tag.slice(cut + 1)), ctx);
    }
  }

  onMessage(from: NodeId, msg: SwimMsg, ctx: C): void {
    switch (msg.type) {
      case 'ping':
        this.applyAll(msg.updates, ctx);
        ctx.send(from, { type: 'ack', seq: msg.seq, updates: this.updatesFor(from) });
        return;
      case 'ack': {
        this.applyAll(msg.updates, ctx);
        if (this.probe?.seq === msg.seq) {
          this.probe.acked = true;
          return;
        }
        const relay = this.relays.get(msg.seq);
        if (relay) {
          this.relays.delete(msg.seq);
          ctx.send(relay.origin, { type: 'ack', seq: relay.originSeq, updates: this.updatesFor(relay.origin) });
        }
        return;
      }
      case 'ping-req': {
        this.applyAll(msg.updates, ctx);
        const seq = ++this.seq;
        this.relays.set(seq, { origin: from, originSeq: msg.seq, tick: this.ticks });
        ctx.send(msg.target, { type: 'ping', seq, updates: this.updatesFor(msg.target) });
        return;
      }
      case 'join':
        this.apply({ id: from, status: 'alive', inc: msg.inc }, ctx);
        ctx.send(from, { type: 'join-ack', members: this.table.snapshot() });
        return;
      case 'join-ack':
        this.joined = true;
        this.applyAll(msg.members, ctx);
        return;
    }
  }

  // --- protocol period -----------------------------------------------------

  private tick(ctx: C): void {
    this.ticks++;
    ctx.setTimer(this.cfg.protocolPeriod, 'tick');

    // Close the previous period: no direct or indirect ack means suspicion.
    if (this.probe && !this.probe.acked) {
      const m = this.table.get(this.probe.target);
      if (m?.status === 'alive') this.apply({ id: this.probe.target, status: 'suspect', inc: m.inc }, ctx);
    }
    this.probe = null;
    for (const [seq, relay] of this.relays) if (this.ticks - relay.tick > 2) this.relays.delete(seq);

    if (!this.joined) this.sendJoin(ctx);

    const target = this.nextProbeTarget(ctx);
    if (target) {
      const seq = ++this.seq;
      this.probe = { seq, target, acked: false };
      ctx.send(target, { type: 'ping', seq, updates: this.updatesFor(target) });
      ctx.setTimer(this.cfg.pingTimeout, `pt:${seq}`);
    }

    // Members believed dead are never probed, so two sides of a healed
    // partition would stay split forever. Occasionally knock on a dead door:
    // the ping tells the member we think it is dead, and it refutes if alive.
    if (this.cfg.reconnectEvery > 0 && this.ticks % Math.round(this.cfg.reconnectEvery) === 0) {
      const dead = this.table.withStatus('dead');
      if (dead.length) {
        const id = ctx.rng.pick(dead);
        ctx.send(id, { type: 'ping', seq: ++this.seq, updates: this.updatesFor(id) });
      }
    }
  }

  private pingTimedOut(seq: number, ctx: C): void {
    if (this.probe?.seq !== seq || this.probe.acked) return;
    const target = this.probe.target;
    const helpers = this.table.withStatus('alive', 'suspect').filter((id) => id !== this.id && id !== target);
    for (const helper of ctx.rng.sample(helpers, Math.round(this.cfg.indirectK))) {
      ctx.send(helper, { type: 'ping-req', seq, target, updates: this.updatesFor(helper) });
    }
  }

  private suspicionExpired(id: NodeId, inc: number, ctx: C): void {
    const m = this.table.get(id);
    if (m?.status === 'suspect' && m.inc === inc) this.apply({ id, status: 'dead', inc }, ctx);
  }

  /** Round-robin over a shuffled list, reshuffled each pass (bounds detection time). */
  private nextProbeTarget(ctx: C): NodeId | null {
    for (let tries = 0; tries <= this.probeOrder.length * 2; tries++) {
      if (this.probeIdx >= this.probeOrder.length) {
        if (this.probeOrder.length === 0) return null;
        ctx.rng.shuffle(this.probeOrder);
        this.probeIdx = 0;
      }
      const id = this.probeOrder[this.probeIdx++];
      const m = this.table.get(id);
      if (m && m.status !== 'dead') return id;
    }
    return null;
  }

  private sendJoin(ctx: C): void {
    if (this.joined) return;
    ctx.send(ctx.rng.pick(this.joinTargets), { type: 'join', inc: this.inc });
  }

  // --- membership ----------------------------------------------------------

  private applyAll(updates: Update[], ctx: C): void {
    for (const u of updates) this.apply(u, ctx);
  }

  private apply(u: Update, ctx: C): void {
    if (u.id === this.id) {
      // Someone thinks we are suspect or dead: refute with a higher incarnation.
      if (u.status !== 'alive' && u.inc >= this.inc) {
        this.inc = u.inc + 1;
        this.record({ id: this.id, status: 'alive', inc: this.inc }, ctx);
      }
      return;
    }
    const isNew = !this.table.has(u.id);
    if (!this.table.apply(u, ctx.now)) return;
    if (isNew) this.probeOrder.splice(ctx.rng.int(this.probeOrder.length + 1), 0, u.id);
    this.gossip.enqueue(u.id, u);
    ctx.emit('member', { ...u } satisfies MemberChange);
    if (u.status === 'suspect') ctx.setTimer(this.cfg.suspectTimeout, `st:${u.id}:${u.inc}`);
  }

  private record(u: Update, ctx: C): void {
    this.table.apply(u, ctx.now);
    this.gossip.enqueue(u.id, u);
    ctx.emit('member', { ...u } satisfies MemberChange);
  }

  /**
   * Updates to piggyback on a message to `to`. If we hold `to` suspect or
   * dead, say so first: it is the fastest way for a live member to refute.
   */
  private updatesFor(to: NodeId): Update[] {
    const limit = retransmitLimit(this.cfg.retransmitMult, this.table.size);
    const updates = this.gossip.take(Math.round(this.cfg.piggybackMax), limit);
    const m = this.table.get(to);
    if (m && m.status !== 'alive' && !updates.some((u) => u.id === to)) {
      updates.unshift({ id: to, status: m.status, inc: m.inc });
    }
    return updates;
  }
}
