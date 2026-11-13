import type { Ctx, NodeId, SimNode } from '../engine/types.ts';
import { Ring } from '../ring/ring.ts';
import { SwimNode } from '../swim/node.ts';
import { Coordinator, type CoordHost } from './coordinator.ts';
import { HintStore } from './hints.ts';
import { bucketOf, MERKLE_DEPTH } from './merkle.ts';
import { isSwimMsg, type ClusterConfig, type Msg } from './messages.ts';
import { Replica } from './replica.ts';
import { reconcile, type Version } from './vclock.ts';

type C = Ctx<Msg>;

const HOT_REFRESH = 1000;
const LENT_TTL = 3000;

/** Event rate per second, exponentially decayed over about a second. */
class Decaying {
  private level = 0;
  private at = 0;

  bump(now: number): void {
    this.level = this.value(now) + 1;
    this.at = now;
  }

  value(now: number): number {
    return this.level * Math.exp(-(now - this.at) / 1000);
  }
}

/**
 * A full Dynamo-style node: SWIM membership, local replica storage, request
 * coordination, hinted handoff and Merkle anti-entropy.
 *
 * Ring membership is explicit: the list of members is given to the node, the
 * way an operator would add or remove nodes. SWIM declaring a member dead does
 * not remove it from the ring; it only makes coordinators route around it.
 */
export class StoreNode implements SimNode<Msg>, CoordHost {
  readonly id: NodeId;
  readonly cfg: ClusterConfig;
  readonly swim: SwimNode;
  /** Data and hints survive a restart, like a disk. */
  readonly replica: Replica;
  readonly hints: HintStore;

  private readonly coord: Coordinator;
  private readonly members: NodeId[];
  private ringCache: { key: string; ring: Ring } | null = null;
  private readonly handoffs = new Map<number, { target: NodeId; entries: [string, Version[]][] }>();
  private hid = 0;

  // Work queue: one replica operation at a time, each taking cfg.serviceTime.
  private busyUntil = 0;
  private readonly jobs = new Map<number, () => void>();
  private jobSeq = 0;
  /** Replica operations handled since start. */
  ops = 0;
  private readonly rate = new Decaying();

  // Hot keys. An owner tracks read rates and lends copies; an extra replica holds lent copies.
  private readonly keyRates = new Map<string, Decaying>();
  /** Hot keys this node owns, and how many extra replicas each currently has. */
  private readonly hotOwned = new Map<string, number>();
  private readonly lent = new Map<string, { versions: Version[]; extras: number; expires: number }>();

  constructor(id: NodeId, cfg: ClusterConfig, seeds: NodeId[], members: NodeId[], prev?: StoreNode) {
    this.id = id;
    this.members = members;
    this.cfg = cfg;
    this.swim = new SwimNode(id, cfg, seeds, prev?.swim);
    this.replica = prev?.replica ?? new Replica();
    this.hints = prev?.hints ?? new HintStore();
    this.coord = new Coordinator(this, prev?.coord.durable);
  }

  // --- CoordHost -------------------------------------------------------------

  ring(): Ring {
    const key = `${this.members.length}:${this.cfg.vnodes}`;
    if (this.ringCache?.key !== key) this.ringCache = { key, ring: new Ring(this.members, this.cfg.vnodes) };
    return this.ringCache.ring;
  }

  isDead(id: NodeId): boolean {
    return id !== this.id && this.swim.table.get(id)?.status === 'dead';
  }

  storeLocal(key: string, version: Version, hintFor: NodeId | undefined, ctx: C): void {
    if (hintFor && hintFor !== this.id) {
      this.hints.add(hintFor, key, version, ctx.now + this.cfg.hintTtl);
      ctx.emit('hint', { for: hintFor, key });
    } else {
      this.applyOwn(key, [version], ctx);
    }
  }

  /** A stand-in also serves reads from the hints it holds, and an extra replica from its lent copy. */
  readLocal(key: string, ctx: C): Version[] {
    this.noteRead(key, ctx);
    const lent = this.lent.get(key);
    return reconcile([...this.replica.get(key), ...this.hints.versionsFor(key), ...(lent && lent.expires > ctx.now ? lent.versions : [])]);
  }

  repairLocal(key: string, versions: Version[], ctx: C): void {
    this.applyOwn(key, versions, ctx);
  }

  defer(ctx: C, job: () => void): void {
    this.ops++;
    this.rate.bump(ctx.now);
    if (this.cfg.serviceTime <= 0) return job();
    this.busyUntil = Math.max(ctx.now, this.busyUntil) + Math.round(this.cfg.serviceTime);
    const id = ++this.jobSeq;
    this.jobs.set(id, job);
    ctx.setTimer(this.busyUntil - ctx.now, `kv:job:${id}`);
  }

  loadNow(now: number): number {
    return this.rate.value(now);
  }

  /** Writes to this node's own data; a hot key's lent copies are refreshed at once. */
  private applyOwn(key: string, versions: readonly Version[], ctx: C): void {
    if (this.replica.apply(key, versions) && this.hotOwned.has(key)) this.lend(key, ctx);
  }

  // --- SimNode ---------------------------------------------------------------

  onStart(ctx: C): void {
    this.swim.onStart(ctx);
    ctx.setTimer(1 + ctx.rng.int(Math.max(1, this.cfg.hintInterval)), 'kv:hint');
    ctx.setTimer(1 + ctx.rng.int(Math.max(1, this.cfg.antiEntropyInterval || 1000)), 'kv:ae');
    ctx.setTimer(HOT_REFRESH, 'kv:hot');
  }

  onTimer(tag: string, ctx: C): void {
    if (!tag.startsWith('kv:')) return this.swim.onTimer(tag, ctx);
    if (tag === 'kv:hint') {
      ctx.setTimer(Math.max(50, this.cfg.hintInterval), 'kv:hint');
      this.replayHints(ctx);
    } else if (tag === 'kv:ae') {
      ctx.setTimer(Math.max(50, this.cfg.antiEntropyInterval || 1000), 'kv:ae');
      if (this.cfg.antiEntropyInterval > 0) this.startAntiEntropy(ctx);
    } else if (tag.startsWith('kv:rt:')) {
      this.coord.onTimeout(Number(tag.slice(6)), ctx);
    } else if (tag.startsWith('kv:hg:')) {
      this.coord.onHedge(Number(tag.slice(6)), ctx);
    } else if (tag.startsWith('kv:job:')) {
      const id = Number(tag.slice(7));
      const job = this.jobs.get(id);
      this.jobs.delete(id);
      job?.();
    } else if (tag === 'kv:hot') {
      ctx.setTimer(HOT_REFRESH, 'kv:hot');
      this.refreshHotKeys(ctx);
    }
  }

  onMessage(from: NodeId, msg: Msg, ctx: C): void {
    if (isSwimMsg(msg)) return this.swim.onMessage(from, msg, ctx);
    switch (msg.type) {
      case 'get':
        return this.coord.get(from, msg.id, msg.key, ctx);
      case 'put':
        return this.coord.put(from, msg.id, msg.key, msg.value, msg.context, ctx);
      case 'store':
        return this.defer(ctx, () => {
          this.storeLocal(msg.key, msg.version, msg.hintFor, ctx);
          ctx.send(from, { type: 'store-ack', rid: msg.rid, load: this.loadNow(ctx.now) });
        });
      case 'store-ack':
        return this.coord.onStoreAck(from, msg.rid, ctx, msg.load);
      case 'fetch':
        return this.defer(ctx, () => {
          const versions = this.readLocal(msg.key, ctx);
          const lent = this.lent.get(msg.key);
          const hot = this.hotOwned.get(msg.key) ?? (lent && lent.expires > ctx.now ? lent.extras : 0);
          ctx.send(from, { type: 'fetch-res', rid: msg.rid, versions, load: this.loadNow(ctx.now), hot });
        });
      case 'fetch-res':
        return this.coord.onFetchRes(from, msg.rid, msg.versions, ctx, msg.load, msg.hot);
      case 'repair':
        this.applyOwn(msg.key, msg.versions, ctx);
        return;
      case 'hot-add': {
        const held = this.lent.get(msg.key)?.versions ?? [];
        this.lent.set(msg.key, { versions: reconcile([...held, ...msg.versions]), extras: msg.extras, expires: ctx.now + LENT_TTL });
        return;
      }
      case 'handoff': {
        for (const [key, versions] of msg.entries) this.replica.apply(key, versions);
        ctx.emit('handoff', { from, keys: msg.entries.length });
        return ctx.send(from, { type: 'handoff-ack', hid: msg.hid });
      }
      case 'handoff-ack': {
        const sent = this.handoffs.get(msg.hid);
        if (sent?.target === from) this.hints.clear(from, sent.entries);
        this.handoffs.delete(msg.hid);
        return;
      }
      case 'ae-check':
        return this.onAeCheck(from, msg.level, msg.nodes, ctx);
      case 'ae-sync':
        return this.onAeSync(from, msg.buckets, msg.entries, msg.reply, ctx);
    }
  }

  // --- hot keys ------------------------------------------------------------------

  /** An owner counts reads per key; past the threshold the key gets extra read replicas. */
  private noteRead(key: string, ctx: C): void {
    if (!this.cfg.hotKeys) return;
    let rate = this.keyRates.get(key);
    if (!rate) this.keyRates.set(key, (rate = new Decaying()));
    rate.bump(ctx.now);
    if (this.hotOwned.has(key) || rate.value(ctx.now) < this.cfg.hotThreshold) return;
    if (!this.ring().preferenceList(key, Math.round(this.cfg.n)).includes(this.id)) return;
    this.hotOwned.set(key, this.extrasNeeded(key, 0, ctx.now));
    ctx.emit('hot', { key, on: true });
    this.lend(key, ctx);
  }

  /**
   * Enough extra replicas that each one serves about hotThreshold reads a
   * second. This node sees its own share, so total traffic is roughly that
   * times the number of replicas sharing it now.
   */
  private extrasNeeded(key: string, current: number, now: number): number {
    const n = Math.round(this.cfg.n);
    const total = (this.keyRates.get(key)?.value(now) ?? 0) * (n + current);
    const wanted = Math.ceil(total / this.cfg.hotThreshold) - n;
    return Math.max(1, Math.min(wanted, Math.round(this.cfg.hotExtra), this.members.length - n));
  }

  /** Sends the current value to the next nodes round the ring, which serve reads from it for a while. */
  private lend(key: string, ctx: C): void {
    const n = Math.round(this.cfg.n);
    const extras = this.hotOwned.get(key) ?? 0;
    const versions = this.replica.get(key);
    for (const extra of this.ring().walk(key, n + extras).slice(n)) {
      if (!this.isDead(extra)) ctx.send(extra, { type: 'hot-add', key, versions, extras });
    }
  }

  /**
   * Keeps lent copies alive while the key stays busy, resizes the set to the
   * traffic, and lets it lapse when the key cools. The cool-down level is well
   * below the trigger: once reads are spread out each owner sees fewer, and
   * that must not make the key flap.
   */
  private refreshHotKeys(ctx: C): void {
    for (const [key, extras] of this.hotOwned) {
      const rate = this.keyRates.get(key)?.value(ctx.now) ?? 0;
      if (!this.cfg.hotKeys || rate < this.cfg.hotThreshold / 4) {
        this.hotOwned.delete(key);
        ctx.emit('hot', { key, on: false });
      } else {
        this.hotOwned.set(key, this.extrasNeeded(key, extras, ctx.now));
        this.lend(key, ctx);
      }
    }
    for (const [key, rate] of this.keyRates) if (rate.value(ctx.now) < 0.05) this.keyRates.delete(key);
    for (const [key, copy] of this.lent) if (copy.expires <= ctx.now) this.lent.delete(key);
  }

  // --- hinted handoff ----------------------------------------------------------

  private replayHints(ctx: C): void {
    this.hints.expire(ctx.now);
    this.handoffs.clear();
    if (!this.cfg.hintedHandoff) return;
    for (const target of this.hints.targets()) {
      if (this.swim.table.get(target)?.status !== 'alive') continue;
      const entries = this.hints.entries(target);
      const hid = ++this.hid;
      this.handoffs.set(hid, { target, entries });
      ctx.send(target, { type: 'handoff', hid, entries });
    }
  }

  // --- Merkle anti-entropy -----------------------------------------------------

  /** Keys that both this node and `peer` are owners of: the only ones worth comparing. */
  sharedWith(peer: NodeId): (key: string) => boolean {
    const ring = this.ring();
    const n = Math.round(this.cfg.n);
    return (key) => {
      const owners = ring.preferenceList(key, n);
      return owners.includes(this.id) && owners.includes(peer);
    };
  }

  private startAntiEntropy(ctx: C): void {
    const peers = this.swim.table.withStatus('alive').filter((id) => id !== this.id);
    if (peers.length === 0) return;
    const peer = ctx.rng.pick(peers);
    const tree = this.replica.tree(this.sharedWith(peer));
    ctx.send(peer, { type: 'ae-check', level: 0, nodes: [[0, tree.levels[0][0]]] });
  }

  /**
   * The peer sent hashes for some tree nodes. Where ours differ, descend one
   * level and send our hashes back; at the leaves, send the actual data.
   */
  private onAeCheck(from: NodeId, level: number, nodes: [number, number][], ctx: C): void {
    const shared = this.sharedWith(from);
    const tree = this.replica.tree(shared);
    const differing = nodes.filter(([i, hash]) => tree.levels[level]?.[i] !== hash).map(([i]) => i);
    if (differing.length === 0) return;
    if (level === MERKLE_DEPTH) {
      ctx.send(from, { type: 'ae-sync', buckets: differing, entries: this.bucketEntries(shared, differing), reply: false });
    } else {
      const children = differing.flatMap((i) => [2 * i, 2 * i + 1]);
      ctx.send(from, { type: 'ae-check', level: level + 1, nodes: children.map((i) => [i, tree.levels[level + 1][i]]) });
    }
  }

  private onAeSync(from: NodeId, buckets: number[], entries: [string, Version[]][], reply: boolean, ctx: C): void {
    let changed = 0;
    for (const [key, versions] of entries) if (this.replica.apply(key, versions)) changed++;
    ctx.emit('ae', { peer: from, received: entries.length, changed });
    if (!reply) {
      ctx.send(from, { type: 'ae-sync', buckets, entries: this.bucketEntries(this.sharedWith(from), buckets), reply: true });
    }
  }

  private bucketEntries(shared: (key: string) => boolean, buckets: number[]): [string, Version[]][] {
    return this.replica.entries((key) => buckets.includes(bucketOf(key)) && shared(key));
  }
}
