import type { Ctx, NodeId, SimNode } from '../engine/types.ts';
import { Disseminator, retransmitLimit } from './gossip.ts';
import { MemberTable, type Update } from './membership.ts';
import { phiTimeout } from './phi.ts';

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

  // --- improvements over the classic detector; each is 0 (off) or 1 (on) ---

  /** Per-peer adaptive ping timeout from that peer's own reply times (phi-accrual). */
  phi: number;
  /** Wait until a reply is this improbable: 10^-phiThreshold. */
  phiThreshold: number;
  /** A node whose probes keep failing assumes it may be the problem and slows its accusations. */
  selfDoubt: number;
  /** Suspicion lasts longer when few nodes confirm it, shorter when many do. */
  dynamicSuspicion: number;
  /** With dynamicSuspicion: an unconfirmed suspicion lasts suspectTimeout x this. */
  suspectMaxMult: number;
  /** With dynamicSuspicion: independent confirmations needed to reach the minimum timeout. */
  suspectConfirmations: number;
}

export const defaultSwimConfig: SwimConfig = {
  protocolPeriod: 1000,
  pingTimeout: 300,
  indirectK: 3,
  suspectTimeout: 3000,
  piggybackMax: 6,
  retransmitMult: 3,
  reconnectEvery: 5,
  phi: 0,
  phiThreshold: 6,
  selfDoubt: 0,
  dynamicSuspicion: 0,
  suspectMaxMult: 4,
  suspectConfirmations: 2,
};

/**
 * The improved detector. Self-doubt is left out on purpose: in the
 * experiments it bought nothing and slowed real detection, so it stays an
 * optional switch for study (see experiments/failure-detection.md).
 */
export const improvedDetector = { phi: 1, dynamicSuspicion: 1 } as const;

const RTT_WINDOW = 30;
const RTT_MIN_SAMPLES = 5;
const SELF_DOUBT_MAX = 4;

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
  /** Probes awaiting their verdict, by seq. */
  private readonly probes = new Map<number, { target: NodeId; acked: boolean; sentAt: number }>();
  /** Recent direct round-trip times per peer. */
  private readonly rtt = new Map<NodeId, number[]>();
  /** Self-doubt score: rises when our probes fail or we are suspected, falls when they succeed. */
  doubt = 0;
  private readonly suspicions = new Map<NodeId, { inc: number; start: number; by: Set<NodeId>; deadline: number }>();
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
    if (tag.startsWith('pd:')) return this.probeDeadline(Number(tag.slice(3)), ctx);
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
        const probe = this.probes.get(msg.seq);
        if (probe) {
          if (!probe.acked && from === probe.target) this.recordRtt(from, ctx.now - probe.sentAt);
          probe.acked = true;
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
    for (const [seq, relay] of this.relays) if (this.ticks - relay.tick > 2) this.relays.delete(seq);

    if (!this.joined) this.sendJoin(ctx);

    const target = this.nextProbeTarget(ctx);
    if (target) {
      const seq = ++this.seq;
      const timeout = this.pingTimeoutFor(target);
      this.probes.set(seq, { target, acked: false, sentAt: ctx.now });
      ctx.send(target, { type: 'ping', seq, updates: this.updatesFor(target) });
      ctx.setTimer(timeout, `pt:${seq}`);
      // Verdict after one period: time for the direct ping and, failing that,
      // the indirect probes. Only a peer too slow to answer within a period
      // gets longer, and a self-doubting node holds its accusation back longer.
      const patience = this.cfg.selfDoubt ? 1 + this.doubt : 1;
      ctx.setTimer(Math.max(this.cfg.protocolPeriod * patience, this.cfg.phi ? 1.25 * timeout : 0), `pd:${seq}`);
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

  /**
   * Classic: one fixed timeout for everyone. With phi: wait until a reply
   * from this peer would be improbably late by its own history. With
   * self-doubt: a node that suspects it is the slow one waits longer still.
   */
  private pingTimeoutFor(target: NodeId): number {
    let timeout = this.cfg.pingTimeout;
    const samples = this.rtt.get(target);
    if (this.cfg.phi && samples && samples.length >= RTT_MIN_SAMPLES) {
      timeout = Math.min(phiTimeout(samples, this.cfg.phiThreshold), this.cfg.protocolPeriod * 5);
    }
    return this.cfg.selfDoubt ? timeout * (1 + this.doubt) : timeout;
  }

  private recordRtt(peer: NodeId, ms: number): void {
    let samples = this.rtt.get(peer);
    if (!samples) this.rtt.set(peer, (samples = []));
    samples.push(ms);
    if (samples.length > RTT_WINDOW) samples.shift();
  }

  private pingTimedOut(seq: number, ctx: C): void {
    const probe = this.probes.get(seq);
    if (!probe || probe.acked) return;
    const target = probe.target;
    const helpers = this.table.withStatus('alive', 'suspect').filter((id) => id !== this.id && id !== target);
    for (const helper of ctx.rng.sample(helpers, Math.round(this.cfg.indirectK))) {
      ctx.send(helper, { type: 'ping-req', seq, target, updates: this.updatesFor(helper) });
    }
  }

  /** No direct or indirect ack in time means suspicion. */
  private probeDeadline(seq: number, ctx: C): void {
    const probe = this.probes.get(seq);
    if (!probe) return;
    this.probes.delete(seq);
    if (probe.acked) {
      this.doubt = Math.max(0, this.doubt - 1);
      return;
    }
    this.doubt = Math.min(SELF_DOUBT_MAX, this.doubt + 1);
    const m = this.table.get(probe.target);
    if (!m || m.status === 'dead') return;
    const by = this.cfg.dynamicSuspicion ? this.id : undefined;
    if (m.status === 'alive' || by) this.apply({ id: probe.target, status: 'suspect', inc: m.inc, by }, ctx);
  }

  // --- suspicion -------------------------------------------------------------

  /**
   * Classic: a fixed timeout. Dynamic: start at suspectTimeout x suspectMaxMult
   * and fall logarithmically to suspectTimeout as independent nodes confirm.
   * A node that really died is confirmed by many probers at once; a node that
   * one flaky observer lost touch with is not, and gets more time to refute.
   */
  private suspicionTimeout(confirmations: number): number {
    const min = this.cfg.suspectTimeout;
    if (!this.cfg.dynamicSuspicion) return min;
    const max = min * this.cfg.suspectMaxMult;
    const k = Math.max(1, Math.round(this.cfg.suspectConfirmations));
    const progress = Math.min(1, Math.log(confirmations + 1) / Math.log(k + 1));
    return max - (max - min) * progress;
  }

  private startSuspicion(u: Update, ctx: C): void {
    const by = new Set(u.by ? [u.by] : []);
    const deadline = ctx.now + this.suspicionTimeout(0);
    this.suspicions.set(u.id, { inc: u.inc, start: ctx.now, by, deadline });
    ctx.setTimer(deadline - ctx.now, `st:${u.id}:${u.inc}`);
  }

  /** Another node independently failed to reach a member we already suspect. */
  private confirmSuspicion(u: Update, ctx: C): void {
    const s = this.suspicions.get(u.id);
    if (!s || !u.by || s.by.has(u.by)) return;
    s.by.add(u.by);
    if (s.by.size <= this.cfg.suspectConfirmations + 1) this.gossip.enqueue(`${u.id}|${u.by}`, u);
    const deadline = s.start + this.suspicionTimeout(s.by.size - 1);
    if (deadline < s.deadline) {
      s.deadline = deadline;
      ctx.setTimer(Math.max(1, deadline - ctx.now), `st:${u.id}:${u.inc}`);
    }
  }

  private suspicionExpired(id: NodeId, inc: number, ctx: C): void {
    const m = this.table.get(id);
    if (m?.status !== 'suspect' || m.inc !== inc) return;
    // A confirmation may have moved the deadline; an earlier or later timer covers it.
    if (ctx.now < (this.suspicions.get(id)?.deadline ?? 0)) return;
    this.apply({ id, status: 'dead', inc }, ctx);
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
        // Being suspected is itself a hint that we may be the slow one.
        this.doubt = Math.min(SELF_DOUBT_MAX, this.doubt + 1);
        this.inc = u.inc + 1;
        this.record({ id: this.id, status: 'alive', inc: this.inc }, ctx);
      }
      return;
    }
    const current = this.table.get(u.id);
    if (u.status === 'suspect' && current?.status === 'suspect' && current.inc === u.inc) {
      if (this.cfg.dynamicSuspicion) this.confirmSuspicion(u, ctx);
      return;
    }
    if (!this.table.apply(u, ctx.now)) return;
    if (!current) this.probeOrder.splice(ctx.rng.int(this.probeOrder.length + 1), 0, u.id);
    this.gossip.enqueue(u.id, u);
    ctx.emit('member', { ...u } satisfies MemberChange);
    if (u.status === 'suspect') this.startSuspicion(u, ctx);
    else this.suspicions.delete(u.id);
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
