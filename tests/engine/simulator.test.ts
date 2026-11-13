import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay, Simulator, type SimOptions } from '../../src/engine/simulator.ts';
import type { Ctx, NodeId, SimNode } from '../../src/engine/types.ts';

type Msg = { type: 'hello'; n: number } | { type: 'reply'; n: number };
interface Cfg {
  period: number;
}

/** Toy protocol: every period, greet a random peer; peers reply. */
class Chatter implements SimNode<Msg> {
  received = 0;
  timers = 0;
  private peers: NodeId[];
  private cfg: Cfg;

  constructor(peers: NodeId[], cfg: Cfg) {
    this.peers = peers;
    this.cfg = cfg;
  }
  onStart(ctx: Ctx<Msg>): void {
    ctx.setTimer(this.cfg.period, 'tick');
  }
  onMessage(from: NodeId, msg: Msg, ctx: Ctx<Msg>): void {
    this.received++;
    if (msg.type === 'hello') ctx.send(from, { type: 'reply', n: msg.n });
  }
  onTimer(_tag: string, ctx: Ctx<Msg>): void {
    this.timers++;
    const others = this.peers.filter((p) => p !== ctx.self);
    ctx.send(ctx.rng.pick(others), { type: 'hello', n: this.timers });
    ctx.emit('ticked', this.timers);
    ctx.setTimer(this.cfg.period, 'tick');
  }
}

const ids = ['a', 'b', 'c', 'd'];
function opts(seed: number, network = {}): SimOptions<Msg, Cfg> {
  return { seed, nodes: ids, config: { period: 100 }, network, createNode: (_id, cfg) => new Chatter(ids, cfg) };
}

test('same seed produces a byte-identical event log', () => {
  const net = { loss: 0.1, duplication: 0.1, reorder: 0.2 };
  const a = new Simulator(opts(11, net));
  const b = new Simulator(opts(11, net));
  a.runUntil(5000);
  b.runUntil(5000);
  assert.ok(a.log.length > 300);
  assert.equal(JSON.stringify(a.log), JSON.stringify(b.log));

  const c = new Simulator(opts(12, net));
  c.runUntil(5000);
  assert.notEqual(JSON.stringify(a.log), JSON.stringify(c.log));
});

test('replaying the recorded input script reproduces the run', () => {
  const live = new Simulator(opts(21));
  live.runUntil(700);
  live.input({ type: 'kill', node: 'b' });
  live.runUntil(1500);
  live.input({ type: 'network', patch: { loss: 0.4 } });
  live.input({ type: 'partition', groups: [['a'], ['c', 'd']] });
  live.runUntil(2600);
  live.input({ type: 'restart', node: 'b' });
  live.input({ type: 'heal' });
  live.input({ type: 'config', patch: { period: 37 } });
  live.runUntil(4000);

  const again = replay(opts(21), live.inputs, 4000);
  assert.equal(JSON.stringify(again.log), JSON.stringify(live.log));
  assert.equal(again.now, 4000);
});

test('clock and log times never go backwards', () => {
  const sim = new Simulator(opts(31, { reorder: 0.5 }));
  sim.runUntil(3000);
  for (let i = 1; i < sim.log.length; i++) assert.ok(sim.log[i].t >= sim.log[i - 1].t);
  assert.equal(sim.now, 3000);
});

test('a killed node gets no timers or messages; restart gives it a fresh life', () => {
  const sim = new Simulator(opts(41));
  sim.runUntil(1000);
  sim.input({ type: 'kill', node: 'a' });
  const dead = sim.getNode('a') as Chatter;
  const { timers, received } = dead;
  sim.runUntil(3000);
  assert.equal(dead.timers, timers);
  assert.equal(dead.received, received);
  assert.ok(sim.log.some((e) => e.type === 'drop' && e.reason === 'down' && e.to === 'a'));

  sim.input({ type: 'restart', node: 'a' });
  sim.runUntil(4000);
  const fresh = sim.getNode('a') as Chatter;
  assert.notEqual(fresh, dead);
  assert.ok(fresh.timers >= 9 && fresh.timers <= 10, 'only one timer chain is running');
  assert.equal(dead.timers, timers, 'timers from the previous life never fire');
});

test('partition drops cross-group messages until healed', () => {
  const sim = new Simulator(opts(51));
  sim.input({ type: 'partition', groups: [['a', 'b'], ['c', 'd']] });
  sim.runUntil(3000);
  const delivered = sim.log.filter((e) => e.type === 'deliver');
  assert.ok(delivered.length > 0);
  const side = (id: string) => (id === 'a' || id === 'b' ? 0 : 1);
  for (const e of delivered) if (e.type === 'deliver') assert.equal(side(e.from), side(e.to));
  assert.ok(sim.log.some((e) => e.type === 'drop' && e.reason === 'partition'));

  sim.input({ type: 'heal' });
  const mark = sim.log.length;
  sim.runUntil(6000);
  assert.ok(sim.log.slice(mark).some((e) => e.type === 'deliver' && side(e.from) !== side(e.to)));
});

test('live config changes take effect; step and event budget work', () => {
  const sim = new Simulator(opts(61));
  sim.runUntil(1000);
  const before = (sim.getNode('a') as Chatter).timers;
  sim.input({ type: 'config', patch: { period: 10 } });
  sim.runUntil(2000);
  assert.ok((sim.getNode('a') as Chatter).timers - before > 80);

  assert.equal(sim.runUntil(3000, 5), false);
  assert.ok(sim.now < 3000);
  assert.equal(sim.step(), true);
});

test('logLimit bounds memory and listeners see every event', () => {
  const sim = new Simulator({ ...opts(71), logLimit: 100 });
  let seen = 0;
  sim.onEvent(() => seen++);
  sim.runUntil(20_000);
  assert.ok(sim.log.length <= 200);
  assert.ok(seen > 1000);
});
