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
      this.replica.apply(key, [version]);
    }
  }

  /** A stand-in also serves reads from the hints it holds. */
  readLocal(key: string): Version[] {
    return reconcile([...this.replica.get(key), ...this.hints.versionsFor(key)]);
  }

  repairLocal(key: string, versions: Version[]): void {
    this.replica.apply(key, versions);
  }

  // --- SimNode ---------------------------------------------------------------

  onStart(ctx: C): void {
    this.swim.onStart(ctx);
    ctx.setTimer(1 + ctx.rng.int(Math.max(1, this.cfg.hintInterval)), 'kv:hint');
    ctx.setTimer(1 + ctx.rng.int(Math.max(1, this.cfg.antiEntropyInterval || 1000)), 'kv:ae');
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
        this.storeLocal(msg.key, msg.version, msg.hintFor, ctx);
        return ctx.send(from, { type: 'store-ack', rid: msg.rid });
      case 'store-ack':
        return this.coord.onStoreAck(from, msg.rid, ctx);
      case 'fetch':
        return ctx.send(from, { type: 'fetch-res', rid: msg.rid, versions: this.readLocal(msg.key) });
      case 'fetch-res':
        return this.coord.onFetchRes(from, msg.rid, msg.versions, ctx);
      case 'repair':
        this.replica.apply(msg.key, msg.versions);
        return;
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
