import { EventQueue } from './eventQueue.ts';
import { SimNetwork, type NetworkConfig } from './network.ts';
import { Rng } from './rng.ts';
import type { Ctx, Input, Message, NodeId, ScriptedInput, SimEvent, SimNode } from './types.ts';

type Pending<M> =
  | { k: 'deliver'; id: number; from: NodeId; to: NodeId; msg: M }
  | { k: 'timer'; node: NodeId; tag: string; epoch: number };

interface Slot<M extends Message> {
  node: SimNode<M>;
  ctx: Ctx<M>;
  up: boolean;
  /** Bumped on kill and restart so timers from a previous life never fire. */
  epoch: number;
}

export interface SimOptions<M extends Message, C extends object> {
  seed: number;
  nodes: NodeId[];
  /** Protocol configuration shared by all nodes; mutated live by `config` inputs. */
  config: C;
  network?: Partial<NetworkConfig>;
  /** `prev` is the node's previous instance on restart (its "disk"). */
  createNode: (id: NodeId, config: C, prev?: SimNode<M>) => SimNode<M>;
  /** Keep only the most recent N log entries. Unlimited when omitted. */
  logLimit?: number;
}

/**
 * Deterministic discrete-event simulator: a virtual clock, a priority queue of
 * pending deliveries and timers, and one seeded RNG. Same seed plus same input
 * script yields a byte-identical event log.
 */
export class Simulator<M extends Message, C extends object> {
  now = 0;
  readonly rng: Rng;
  readonly network: SimNetwork;
  readonly config: C;
  readonly log: SimEvent[] = [];
  /** Every input applied so far, with the virtual time it was applied at. */
  readonly inputs: ScriptedInput[] = [];

  private readonly queue = new EventQueue<Pending<M>>();
  private readonly slots = new Map<NodeId, Slot<M>>();
  private readonly listeners: ((e: SimEvent) => void)[] = [];
  private readonly createNode: SimOptions<M, C>['createNode'];
  private readonly logLimit: number;
  private msgId = 0;

  constructor(opts: SimOptions<M, C>) {
    this.rng = new Rng(opts.seed);
    this.network = new SimNetwork(opts.network);
    this.config = opts.config;
    this.createNode = opts.createNode;
    this.logLimit = opts.logLimit ?? Infinity;
    for (const id of opts.nodes) this.boot(id);
  }

  /** Call before running to observe events from the very first one. */
  onEvent(listener: (e: SimEvent) => void): void {
    this.listeners.push(listener);
    for (const e of this.log) listener(e);
  }

  nodeIds(): NodeId[] {
    return [...this.slots.keys()];
  }

  isUp(id: NodeId): boolean {
    return this.slots.get(id)?.up ?? false;
  }

  getNode(id: NodeId): SimNode<M> | undefined {
    return this.slots.get(id)?.node;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Processes the next event. Returns false when nothing is scheduled. */
  step(): boolean {
    const next = this.queue.pop();
    if (!next) return false;
    this.now = next.time;
    const ev = next.item;
    if (ev.k === 'deliver') {
      const slot = this.slots.get(ev.to);
      const base = { t: this.now, id: ev.id, from: ev.from, to: ev.to, kind: ev.msg.type };
      if (!slot?.up) {
        this.record({ ...base, type: 'drop', reason: 'down' });
      } else {
        this.record({ ...base, type: 'deliver' });
        slot.node.onMessage(ev.from, ev.msg, slot.ctx);
      }
    } else {
      const slot = this.slots.get(ev.node);
      if (slot?.up && slot.epoch === ev.epoch) slot.node.onTimer(ev.tag, slot.ctx);
    }
    return true;
  }

  /**
   * Processes every event scheduled at or before `t`, then sets the clock to `t`.
   * If `maxEvents` runs out first, the clock stays at the last processed event
   * and the method returns false.
   */
  runUntil(t: number, maxEvents = Infinity): boolean {
    let n = 0;
    while (this.queue.peekTime() <= t) {
      if (n++ >= maxEvents) return false;
      this.step();
    }
    if (t > this.now) this.now = t;
    return true;
  }

  /** Applies an external input at the current virtual time and records it. */
  input(raw: Input): void {
    const input = structuredClone(raw);
    this.inputs.push({ t: this.now, input });
    this.record({ t: this.now, type: 'input', input });
    switch (input.type) {
      case 'kill': {
        const slot = this.slots.get(input.node);
        if (!slot?.up) return;
        slot.up = false;
        slot.epoch++;
        this.record({ t: this.now, type: 'down', node: input.node });
        return;
      }
      case 'restart': {
        const slot = this.slots.get(input.node);
        if (!slot || slot.up) return;
        slot.node = this.createNode(input.node, this.config, slot.node);
        slot.up = true;
        slot.epoch++;
        this.record({ t: this.now, type: 'up', node: input.node });
        slot.node.onStart(slot.ctx);
        return;
      }
      case 'addNode':
        if (!this.slots.has(input.node)) this.boot(input.node);
        return;
      case 'partition':
        this.network.partitions = input.groups;
        return;
      case 'heal':
        this.network.partitions = [];
        return;
      case 'slow':
        if (input.factor === 1) this.network.slow.delete(input.node);
        else this.network.slow.set(input.node, input.factor);
        return;
      case 'network':
        Object.assign(this.network.config, input.patch);
        return;
      case 'config':
        Object.assign(this.config, input.patch);
        return;
    }
  }

  private boot(id: NodeId): void {
    const slot: Slot<M> = {
      node: this.createNode(id, this.config),
      ctx: this.makeCtx(id),
      up: true,
      epoch: 0,
    };
    this.slots.set(id, slot);
    this.record({ t: this.now, type: 'up', node: id });
    slot.node.onStart(slot.ctx);
  }

  private makeCtx(self: NodeId): Ctx<M> {
    const sim = this;
    return {
      self,
      rng: this.rng,
      get now() {
        return sim.now;
      },
      send: (to, msg) => this.send(self, to, msg),
      setTimer: (delay, tag) => {
        const epoch = this.slots.get(self)!.epoch;
        this.queue.push(this.now + Math.max(1, Math.round(delay)), { k: 'timer', node: self, tag, epoch });
      },
      emit: (kind, data) => this.record({ t: this.now, type: 'state', node: self, kind, data }),
    };
  }

  private send(from: NodeId, to: NodeId, msg: M): void {
    const plan = this.network.plan(from, to, this.rng);
    if (plan.dropped) {
      this.record({ t: this.now, type: 'drop', id: ++this.msgId, from, to, kind: msg.type, reason: plan.dropped });
      return;
    }
    for (const delay of plan.delays) {
      const id = ++this.msgId;
      const arrive = this.now + delay;
      this.record({ t: this.now, type: 'send', id, from, to, kind: msg.type, arrive });
      this.queue.push(arrive, { k: 'deliver', id, from, to, msg });
    }
  }

  private record(e: SimEvent): void {
    this.log.push(e);
    if (this.log.length > this.logLimit * 2) this.log.splice(0, this.log.length - this.logLimit);
    for (const l of this.listeners) l(e);
  }
}

/** Re-runs a recorded input script against a fresh simulator, up to time `until`. */
export function replay<M extends Message, C extends object>(
  opts: SimOptions<M, C>,
  script: readonly ScriptedInput[],
  until: number,
): Simulator<M, C> {
  const sim = new Simulator(opts);
  for (const { t, input } of script) {
    if (t > until) break;
    sim.runUntil(t);
    sim.input(input);
  }
  sim.runUntil(until);
  return sim;
}
