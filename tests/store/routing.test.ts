import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay } from '../../src/engine/simulator.ts';
import { trial } from '../../src/experiments/latency.ts';
import { Ring } from '../../src/ring/ring.ts';
import { createStoreCluster, isClient, storeClusterOptions, type StoreClusterOptions } from '../../src/store/cluster.ts';
import { LatencyTable } from '../../src/store/latency.ts';
import { improvedRouting } from '../../src/store/messages.ts';
import { StoreMetrics } from '../../src/store/metrics.ts';
import type { StoreNode } from '../../src/store/node.ts';
import { fingerprint } from '../../src/store/vclock.ts';

test('latency table: silence counts as slowness, and old measurements fade', () => {
  const t = new LatencyTable();
  assert.equal(t.get('a', 0), undefined);
  t.observe('a', 100, 0);
  t.observe('a', 200, 0);
  assert.equal(t.get('a', 0), 120);
  t.stillWaiting('a', 900, 0);
  assert.equal(t.get('a', 0), 900, 'a peer that has not answered is at least that slow');
  t.stillWaiting('a', 50, 0);
  assert.equal(t.get('a', 0), 900, 'a short wait never makes a peer look faster');
  assert.equal(t.get('a', 20_000), 450, 'estimates halve every 20 s so slow peers get retried');
});

test('improved routing keeps the guarantees: no failures, no stale reads, replicas agree', () => {
  const sim = createStoreCluster({ seed: 3, size: 8, config: { ...improvedRouting, rate: 20, serviceTime: 2 } });
  const metrics = new StoreMetrics();
  sim.onEvent((e) => metrics.onEvent(e));
  sim.runUntil(60_000);
  assert.ok(metrics.gets.ok + metrics.puts.ok > 2000);
  assert.equal(metrics.gets.fail + metrics.puts.fail, 0);
  assert.equal(metrics.staleReads, 0);
  sim.input({ type: 'config', patch: { rate: 0 } });
  sim.runUntil(70_000);
  const stores = sim.nodeIds().filter((id) => !isClient(id));
  const ring = new Ring(stores, sim.config.vnodes);
  const node = (id: string) => sim.getNode(id) as StoreNode;
  for (const key of new Set(stores.flatMap((id) => node(id).replica.keys()))) {
    const held = ring.preferenceList(key, 3).map((id) => fingerprint(node(id).replica.get(key)));
    assert.equal(new Set(held).size, 1, `${key} in sync`);
  }
});

test('a node working one operation at a time queues under load', () => {
  const run = (serviceTime: number) => {
    const sim = createStoreCluster({ seed: 1, size: 5, clients: 4, config: { rate: 40, serviceTime } });
    const metrics = new StoreMetrics();
    sim.onEvent((e) => metrics.onEvent(e));
    sim.runUntil(30_000);
    return metrics.percentile(0.5);
  };
  assert.ok(run(9) > run(0) + 20, 'near saturation, waiting in the queue dominates');
});

test('one slow node: improved routing removes the latency tail and the failures', () => {
  const classic = trial(1, {}, { slowNode: true });
  const ours = trial(1, improvedRouting, { slowNode: true });
  assert.ok(classic.p99 > 1000, `classic p99 ${classic.p99}`);
  assert.ok(ours.p99 < 300, `ours p99 ${ours.p99}`);
  assert.ok(ours.failed < classic.failed / 10);
  assert.equal(ours.staleReads, 0);
});

test('a viral key: improved routing spreads the load within the cap and protects other keys', () => {
  const classic = trial(2, {}, { viral: 0.5 });
  const ours = trial(2, improvedRouting, { viral: 0.5 });
  assert.ok(classic.peakOverAvg > 2, `classic busiest/average ${classic.peakOverAvg}`);
  assert.equal(classic.settledAfter, null, 'classic never gets within the cap');
  assert.ok(ours.peakOverAvg < 1.25, `ours busiest/average ${ours.peakOverAvg}`);
  assert.ok(ours.settledAfter !== null && ours.settledAfter <= 10, `balanced after ${ours.settledAfter}s`);
  assert.ok(ours.p99Others < classic.p99Others);
  assert.equal(ours.staleReads, 0);
});

test('at normal load hedging is rare and total traffic does not grow', () => {
  const classic = trial(3, {}, {});
  const ours = trial(3, improvedRouting, {});
  assert.ok(ours.hedgesPer100 < 1, `hedges per 100 requests: ${ours.hedgesPer100}`);
  assert.ok(ours.messages <= classic.messages);
  assert.ok(ours.p99 < classic.p99 * 1.1, 'the price is a few ms: waiting for 2 chosen replicas, not the fastest 2 of 3');
});

test('improved routing runs are deterministic and replayable', () => {
  const o: StoreClusterOptions = { seed: 9, size: 7, clients: 3, config: { ...improvedRouting, rate: 30, serviceTime: 3, hotShare: 0.4 }, network: { loss: 0.05 } };
  const live = createStoreCluster(o);
  live.runUntil(5000);
  live.input({ type: 'slow', node: 'n2', factor: 10 });
  live.input({ type: 'kill', node: 'n5' });
  live.runUntil(15_000);
  assert.equal(JSON.stringify(replay(storeClusterOptions(o), live.inputs, 15_000).log), JSON.stringify(live.log));
});
