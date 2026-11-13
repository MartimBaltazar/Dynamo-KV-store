import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay } from '../../src/engine/simulator.ts';
import type { SimEvent } from '../../src/engine/types.ts';
import { Ring } from '../../src/ring/ring.ts';
import type { ClientReq, ClientRes } from '../../src/store/client.ts';
import { createStoreCluster, isClient, storeClusterOptions, type StoreClusterOptions, type StoreSim } from '../../src/store/cluster.ts';
import type { ClientRequest } from '../../src/store/messages.ts';
import { StoreMetrics } from '../../src/store/metrics.ts';
import type { StoreNode } from '../../src/store/node.ts';
import { fingerprint } from '../../src/store/vclock.ts';

interface Run {
  sim: StoreSim;
  metrics: StoreMetrics;
  /** Client results, each with the coordinator it went through. */
  results: (ClientRes & { coord: string; t: number })[];
}

function start(o: StoreClusterOptions): Run {
  const sim = createStoreCluster(o);
  const metrics = new StoreMetrics();
  const coords = new Map<string, string>();
  const results: Run['results'] = [];
  sim.onEvent((e: SimEvent) => {
    metrics.onEvent(e);
    if (e.type !== 'state') return;
    if (e.kind === 'req') coords.set((e.data as ClientReq).id, (e.data as ClientReq).coord);
    if (e.kind === 'res') results.push({ ...(e.data as ClientRes), coord: coords.get((e.data as ClientRes).id)!, t: e.t });
  });
  return { sim, metrics, results };
}

const store = (sim: StoreSim, id: string) => sim.getNode(id) as StoreNode;
const stores = (sim: StoreSim) => sim.nodeIds().filter((id) => !isClient(id));
const ask = (sim: StoreSim, client: string, payload: ClientRequest) => sim.input({ type: 'request', node: client, payload });
const owners = (sim: StoreSim, key: string) => new Ring(stores(sim), sim.config.vnodes).preferenceList(key, sim.config.n);

/** Keys whose owners do not all hold the same sibling set. */
function divergentKeys(sim: StoreSim): string[] {
  const keys = new Set(stores(sim).flatMap((id) => store(sim, id).replica.keys()));
  return [...keys].filter((key) => new Set(owners(sim, key).map((id) => fingerprint(store(sim, id).replica.get(key)))).size > 1);
}

const quiet = { rate: 0 };

test('no faults, R+W>N: every request succeeds, no stale reads, replicas agree', () => {
  for (const seed of [1, 2, 3]) {
    const { sim, metrics } = start({ seed, size: 8, config: { rate: 10 } });
    sim.runUntil(60_000);
    assert.ok(metrics.gets.ok + metrics.puts.ok > 900, 'workload ran');
    assert.equal(metrics.gets.fail + metrics.puts.fail, 0);
    assert.equal(metrics.staleReads, 0);
    sim.input({ type: 'config', patch: quiet });
    sim.runUntil(63_000);
    assert.deepEqual(divergentKeys(sim), []);
    for (const key of store(sim, 'n0').replica.keys()) assert.ok(owners(sim, key).includes('n0'), 'data only lands on owners');
  }
});

test('strict quorum fails writes when an owner is down; sloppy quorum accepts them with hints', () => {
  const run = (sloppy: number) => {
    const r = start({ seed: 5, size: 6, config: { w: 3, r: 1, sloppy, rate: 10, readRatio: 0, readRepair: 0, antiEntropyInterval: 0 } });
    r.sim.runUntil(10_000);
    // Pause the workload while SWIM notices the death: a write sent to an owner
    // that is down but not yet declared dead is simply lost, hint or no hint.
    r.sim.input({ type: 'config', patch: quiet });
    r.sim.runUntil(11_000);
    r.sim.input({ type: 'kill', node: 'n2' });
    r.sim.runUntil(25_000);
    r.sim.input({ type: 'config', patch: { rate: 10 } });
    r.sim.runUntil(40_000);
    return r;
  };
  // Judge only requests sent to live coordinators.
  const failures = (r: Run) => r.results.filter((x) => x.t > 25_000 && x.coord !== 'n2' && !x.ok).length;

  const strict = run(0);
  assert.ok(failures(strict) > 10, `strict: ${failures(strict)} writes failed`);
  assert.equal(strict.metrics.hintsStored, 0);

  const sloppy = run(1);
  assert.equal(failures(sloppy), 0, 'sloppy: stand-ins complete the quorum');
  assert.ok(sloppy.metrics.hintsStored > 0);
  const depth = () => stores(sloppy.sim).reduce((n, id) => n + store(sloppy.sim, id).hints.depth, 0);
  assert.ok(depth() > 0);

  // The owner returns: hints flow back and it ends up with everything, with no other repair mechanism on.
  sloppy.sim.input({ type: 'config', patch: quiet });
  sloppy.sim.runUntil(41_000);
  sloppy.sim.input({ type: 'restart', node: 'n2' });
  sloppy.sim.runUntil(70_000);
  assert.equal(depth(), 0, 'hint queues drained');
  assert.ok(sloppy.metrics.hintsDelivered > 0);
  assert.deepEqual(divergentKeys(sloppy.sim), []);
});

test('hints expire after their TTL when handoff is off', () => {
  const { sim } = start({ seed: 6, size: 6, config: { rate: 10, readRatio: 0, hintedHandoff: 0, hintTtl: 5000 } });
  sim.runUntil(5000);
  sim.input({ type: 'kill', node: 'n1' });
  sim.runUntil(30_000);
  const depth = () => stores(sim).reduce((n, id) => n + store(sim, id).hints.depth, 0);
  assert.ok(depth() > 0);
  sim.input({ type: 'config', patch: quiet });
  sim.runUntil(40_000);
  assert.equal(depth(), 0);
});

test('R=W=1 under a partition gives stale reads; strict R+W>N gives errors instead', () => {
  const run = (config: Record<string, number>) => {
    const r = start({ seed: 7, size: 6, config: { rate: 10, keys: 8, ...config } });
    r.sim.runUntil(10_000);
    r.sim.input({ type: 'partition', groups: [['n0', 'n1', 'n2', 'c0']] });
    r.sim.runUntil(60_000);
    return r.metrics;
  };
  const weak = run({ r: 1, w: 1 });
  assert.ok(weak.staleReads > 0, `R=W=1: ${weak.staleReads} stale reads`);

  const strong = run({ r: 2, w: 2, sloppy: 0 });
  assert.equal(strong.staleReads, 0);
  assert.ok(strong.gets.fail + strong.puts.fail > 0, 'the minority side refuses instead of lying');
});

test('concurrent writes become siblings; a write with the read context resolves them', () => {
  const { sim, results } = start({ seed: 8, size: 6, config: quiet });
  sim.runUntil(8000);
  ask(sim, 'c0', { op: 'put', key: 'cart', value: 'milk', via: 'n1' });
  ask(sim, 'c1', { op: 'put', key: 'cart', value: 'eggs', via: 'n4' });
  sim.runUntil(9000);
  ask(sim, 'c0', { op: 'get', key: 'cart' });
  sim.runUntil(10_000);
  assert.equal(results.at(-1)!.siblings, 2);
  for (const id of owners(sim, 'cart')) {
    assert.deepEqual(store(sim, id).replica.get('cart').map((v) => v.value).sort(), ['eggs', 'milk']);
  }

  ask(sim, 'c0', { op: 'put', key: 'cart', value: 'milk+eggs' });
  sim.runUntil(11_000);
  ask(sim, 'c1', { op: 'get', key: 'cart' });
  sim.runUntil(12_000);
  assert.equal(results.at(-1)!.siblings, 1);
  for (const id of owners(sim, 'cart')) assert.deepEqual(store(sim, id).replica.get('cart').map((v) => v.value), ['milk+eggs']);
});

test('classic limitation: blind writes through the same coordinator do not become siblings', () => {
  const { sim } = start({ seed: 8, size: 6, config: quiet });
  sim.runUntil(8000);
  ask(sim, 'c0', { op: 'put', key: 'cart', value: 'milk', via: 'n1' });
  ask(sim, 'c1', { op: 'put', key: 'cart', value: 'eggs', via: 'n1' });
  sim.runUntil(9000);
  for (const id of owners(sim, 'cart')) assert.equal(store(sim, id).replica.get('cart').length, 1, 'one write silently won');
});

/** One owner misses a batch of writes while down, with hinted handoff off. Returns the run after it restarts. */
function missedWrites(config: Record<string, number>): Run & { victim: string } {
  const r = start({ seed: 9, size: 6, config: { ...quiet, sloppy: 0, hintedHandoff: 0, ...config } });
  const { sim } = r;
  sim.runUntil(8000);
  const victim = owners(sim, 'k0')[2];
  sim.input({ type: 'kill', node: victim });
  for (let i = 0; i < 30; i++) {
    sim.runUntil(sim.now + 100);
    ask(sim, 'c0', { op: 'put', key: `k${i}`, value: `v${i}`, via: owners(sim, 'k0')[0] });
  }
  sim.runUntil(sim.now + 2000);
  sim.input({ type: 'restart', node: victim });
  sim.runUntil(sim.now + 8000);
  return { ...r, victim };
}

test('with every repair mechanism off, a replica that missed writes stays behind forever', () => {
  const { sim, victim } = missedWrites({ readRepair: 0, antiEntropyInterval: 0 });
  assert.ok(divergentKeys(sim).length > 0);
  assert.deepEqual(store(sim, victim).replica.get('k0'), []);
  const before = divergentKeys(sim).length;
  sim.runUntil(sim.now + 120_000);
  assert.equal(divergentKeys(sim).length, before, 'permanent divergence');
});

test('read repair fixes exactly the keys that get read', () => {
  const { sim, metrics, victim } = missedWrites({ readRepair: 1, antiEntropyInterval: 0 });
  const before = divergentKeys(sim);
  assert.ok(before.includes('k0'));
  ask(sim, 'c0', { op: 'get', key: 'k0' });
  sim.runUntil(sim.now + 2000);
  assert.deepEqual(store(sim, victim).replica.get('k0').map((v) => v.value), ['v0']);
  assert.ok(metrics.readRepairs >= 1);
  assert.equal(divergentKeys(sim).length, before.length - 1, 'unread keys are still behind');
});

test('Merkle anti-entropy repairs everything without any reads, and ships only what differs', () => {
  const { sim, metrics } = missedWrites({ readRepair: 0, antiEntropyInterval: 1000 });
  const missing = divergentKeys(sim).length;
  sim.runUntil(sim.now + 60_000);
  assert.deepEqual(divergentKeys(sim), []);
  assert.ok(metrics.aeKeysRepaired >= missing);
  const settled = metrics.aeKeysSent;
  sim.runUntil(sim.now + 60_000);
  assert.equal(metrics.aeKeysSent, settled, 'once in sync, rounds compare one root hash and ship nothing');
});

test('store runs are deterministic and replayable under faults', () => {
  const o: StoreClusterOptions = { seed: 31, size: 7, config: { rate: 8, zipf: 1.1 }, network: { loss: 0.1, duplication: 0.05, reorder: 0.1 } };
  const live = createStoreCluster(o);
  live.runUntil(6000);
  live.input({ type: 'kill', node: 'n3' });
  live.input({ type: 'request', node: 'c0', payload: { op: 'put', key: 'x', value: '1' } });
  live.runUntil(14_000);
  live.input({ type: 'partition', groups: [['n0', 'n1', 'c0']] });
  live.runUntil(20_000);
  live.input({ type: 'heal' });
  live.input({ type: 'restart', node: 'n3' });
  live.input({ type: 'config', patch: { r: 1, w: 3, sloppy: 0 } });
  live.runUntil(30_000);
  const again = replay(storeClusterOptions(o), live.inputs, 30_000);
  assert.equal(JSON.stringify(again.log), JSON.stringify(live.log));
});

test('zipf workload concentrates traffic on a few keys', () => {
  const count = (zipf: number) => {
    const { sim, results } = start({ seed: 4, size: 5, config: { rate: 50, keys: 50, zipf } });
    sim.runUntil(30_000);
    const hits = results.filter((r) => r.key === 'k0').length;
    return hits / results.length;
  };
  assert.ok(count(0) < 0.05);
  assert.ok(count(1.2) > 0.2);
});
