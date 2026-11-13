import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay } from '../../src/engine/simulator.ts';
import { trial } from '../../src/experiments/detection.ts';
import { summarize } from '../../src/experiments/stats.ts';
import { clusterOptions, createCluster, type ClusterOptions } from '../../src/swim/cluster.ts';
import { improvedDetector } from '../../src/swim/node.ts';
import { phi, phiTimeout, stats } from '../../src/swim/phi.ts';

const seeds = [1, 2, 3, 4, 5, 6];
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test('phi grows with lateness and is about 0.3 at the mean', () => {
  assert.ok(Math.abs(phi(100, 100, 10) - Math.log10(2)) < 0.01);
  let prev = 0;
  for (let t = 100; t <= 200; t += 10) {
    const p = phi(t, 100, 10);
    assert.ok(p >= prev);
    prev = p;
  }
  assert.ok(phi(60, 100, 10) < 0.01, 'an early reply is not suspicious');
});

test('phi timeout adapts to each peer: later for slow or erratic peers', () => {
  const steady = Array.from({ length: 20 }, (_, i) => 80 + (i % 3));
  const slow = steady.map((x) => x * 10);
  const erratic = Array.from({ length: 20 }, (_, i) => 80 + (i % 2) * 120);
  const t = phiTimeout(steady, 6);
  assert.ok(t > stats(steady).mean && t < 200, `steady peer: ${t}`);
  assert.ok(phiTimeout(slow, 6) > 800);
  assert.ok(phiTimeout(erratic, 6) > t * 2);
  assert.ok(phiTimeout(steady, 3) < t, 'a lower threshold is less patient');
  assert.ok(Math.abs(phi(t, stats(steady).mean, stats(steady).std) - 6) < 0.01);
});

test('improved detector still detects a real death, about as fast as classic', () => {
  const classic = seeds.map((s) => trial(s, {}, {}).detection);
  const ours = seeds.map((s) => trial(s, improvedDetector, {}).detection);
  assert.ok(ours.every((d) => d !== null));
  const slowdown = summarize(ours as number[]).mean - summarize(classic as number[]).mean;
  assert.ok(slowdown < 1500, `mean slowdown ${slowdown} ms`);
});

test('under 20% loss the improved detector makes far fewer false death verdicts', () => {
  const classic = total(seeds.map((s) => trial(s, {}, { loss: 0.2 }).falseDeads));
  const ours = total(seeds.map((s) => trial(s, improvedDetector, { loss: 0.2 }).falseDeads));
  assert.ok(classic > 100, `classic: ${classic}`);
  assert.ok(ours < classic / 20, `ours: ${ours} vs classic: ${classic}`);
});

test('a slow but live node is not declared dead by the improved detector', () => {
  const classic = total(seeds.map((s) => trial(s, {}, { slowNode: true }).aboutSlow));
  const ours = seeds.map((s) => trial(s, improvedDetector, { slowNode: true }));
  assert.ok(classic > 0, 'classic does declare it dead');
  assert.equal(total(ours.map((o) => o.aboutSlow)), 0);
  assert.ok(total(ours.map((o) => o.bySlow)) < total(seeds.map((s) => trial(s, {}, { slowNode: true }).bySlow)), 'and it accuses others less');
});

test('improved detector runs are deterministic and replayable', () => {
  const o: ClusterOptions = { seed: 5, size: 12, swim: { ...improvedDetector, selfDoubt: 1 }, network: { loss: 0.25, reorder: 0.1 } };
  const live = createCluster(o);
  live.runUntil(10_000);
  live.input({ type: 'kill', node: 'n2' });
  live.input({ type: 'slow', node: 'n4', factor: 10 });
  live.runUntil(40_000);
  assert.equal(JSON.stringify(replay(clusterOptions(o), live.inputs, 40_000).log), JSON.stringify(live.log));
});
