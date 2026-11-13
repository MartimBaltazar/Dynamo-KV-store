import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimNetwork } from '../../src/engine/network.ts';
import { Rng } from '../../src/engine/rng.ts';

test('no faults: exactly one copy, latency within mean +/- jitter', () => {
  const net = new SimNetwork({ latencyMean: 50, latencyJitter: 10 });
  const rng = new Rng(1);
  for (let i = 0; i < 1000; i++) {
    const plan = net.plan('a', 'b', rng);
    assert.equal(plan.dropped, undefined);
    assert.equal(plan.delays.length, 1);
    assert.ok(plan.delays[0] >= 40 && plan.delays[0] <= 60);
  }
});

test('loss rate is respected', () => {
  const rng = new Rng(2);
  assert.equal(new SimNetwork({ loss: 1 }).plan('a', 'b', rng).dropped, 'loss');
  const net = new SimNetwork({ loss: 0.3 });
  let lost = 0;
  for (let i = 0; i < 10_000; i++) if (net.plan('a', 'b', rng).dropped) lost++;
  assert.ok(lost > 2_700 && lost < 3_300, `lost ${lost}`);
});

test('duplication delivers two copies', () => {
  const plan = new SimNetwork({ duplication: 1 }).plan('a', 'b', new Rng(3));
  assert.equal(plan.delays.length, 2);
});

test('reordering lets a later message overtake an earlier one', () => {
  const net = new SimNetwork({ latencyMean: 50, latencyJitter: 0, reorder: 0.5 });
  const rng = new Rng(4);
  const delays = Array.from({ length: 200 }, () => net.plan('a', 'b', rng).delays[0]);
  assert.ok(delays.some((d) => d === 50));
  assert.ok(delays.some((d) => d > 60));
});

test('partitions block cross-group traffic only', () => {
  const net = new SimNetwork();
  const rng = new Rng(5);
  net.partitions = [['a', 'b']];
  assert.ok(net.canReach('a', 'b'));
  assert.ok(net.canReach('c', 'd'), 'ungrouped nodes share the implicit group');
  assert.ok(!net.canReach('a', 'c'));
  assert.equal(net.plan('a', 'c', rng).dropped, 'partition');
  net.partitions = [];
  assert.equal(net.plan('a', 'c', rng).dropped, undefined);
});

test('slow nodes multiply latency on their links', () => {
  const net = new SimNetwork({ latencyMean: 50, latencyJitter: 0 });
  const rng = new Rng(6);
  net.slow.set('a', 4);
  assert.equal(net.plan('a', 'b', rng).delays[0], 200);
  assert.equal(net.plan('b', 'a', rng).delays[0], 200);
  assert.equal(net.plan('b', 'c', rng).delays[0], 50);
});
