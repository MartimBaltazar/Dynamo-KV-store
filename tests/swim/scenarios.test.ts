import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replay } from '../../src/engine/simulator.ts';
import { clusterOptions, createCluster, type ClusterOptions, type SwimSim } from '../../src/swim/cluster.ts';
import { SwimMetrics } from '../../src/swim/metrics.ts';
import type { SwimNode } from '../../src/swim/node.ts';

function start(o: ClusterOptions): { sim: SwimSim; metrics: SwimMetrics } {
  const sim = createCluster(o);
  const metrics = new SwimMetrics();
  sim.onEvent((e) => metrics.onEvent(e));
  return { sim, metrics };
}

const node = (sim: SwimSim, id: string) => sim.getNode(id) as SwimNode;
const seeds = [1, 2, 3, 4, 5];

test('a cluster bootstrapped through one seed converges with no false alarms', () => {
  for (const seed of seeds) {
    const { sim, metrics } = start({ seed, size: 10 });
    sim.runUntil(30_000);
    assert.ok(metrics.isConverged(), `seed ${seed} converged`);
    assert.ok(metrics.convergedAt !== null && metrics.convergedAt < 15_000, `seed ${seed}: ${metrics.convergedAt}`);
    assert.equal(metrics.falseSuspects, 0);
    assert.equal(metrics.falseDeads, 0);
    for (const id of sim.nodeIds()) assert.equal(node(sim, id).table.withStatus('alive').length, 10);
  }
});

test('killing 1 of 10: every survivor marks it dead within a bound', () => {
  for (const seed of seeds) {
    const { sim, metrics } = start({ seed, size: 10 });
    sim.runUntil(20_000);
    sim.input({ type: 'kill', node: 'n4' });
    sim.runUntil(50_000);
    const f = metrics.failures[0];
    // Worst case: a full round-robin pass before anyone probes it, one more
    // period to conclude, the suspicion timeout, then dissemination.
    const period = sim.config.protocolPeriod;
    assert.ok(f.firstSuspect !== undefined && f.firstSuspect <= 10 * period, `suspect after ${f.firstSuspect}`);
    assert.ok(f.firstDead !== undefined && f.firstDead >= sim.config.suspectTimeout);
    assert.ok(f.allDead !== undefined && f.allDead <= 10 * period + sim.config.suspectTimeout + 5 * period, `all dead after ${f.allDead}`);
    for (const id of sim.nodeIds()) if (id !== 'n4') assert.equal(node(sim, id).table.get('n4')!.status, 'dead');
    assert.equal(metrics.falseDeads, 0);
    assert.ok(metrics.isConverged());
  }
});

test('a longer suspect timeout delays the death verdict by that much', () => {
  const detect = (suspectTimeout: number) => {
    const { sim, metrics } = start({ seed: 9, size: 8, swim: { suspectTimeout } });
    sim.runUntil(20_000);
    sim.input({ type: 'kill', node: 'n3' });
    sim.runUntil(80_000);
    return metrics.failures[0];
  };
  const fast = detect(2000);
  const slow = detect(12_000);
  assert.equal(fast.firstSuspect, slow.firstSuspect);
  assert.equal(slow.firstDead! - fast.firstDead!, 10_000);
});

test('a restarted node rejoins with a higher incarnation and is alive everywhere', () => {
  const { sim, metrics } = start({ seed: 3, size: 10 });
  sim.runUntil(15_000);
  sim.input({ type: 'kill', node: 'n0' }); // the seed itself
  sim.runUntil(40_000);
  assert.equal(node(sim, 'n5').table.get('n0')!.status, 'dead');
  sim.input({ type: 'restart', node: 'n0' });
  sim.runUntil(60_000);
  assert.ok(metrics.isConverged());
  assert.equal(node(sim, 'n0').inc, 1);
  for (const id of sim.nodeIds()) {
    assert.deepEqual({ ...node(sim, id).table.get('n0')!, since: 0 }, { status: 'alive', inc: 1, since: 0 });
    assert.equal(node(sim, id).table.withStatus('alive').length, 10);
  }
});

test('under heavy loss a live node is suspected, refutes with a new incarnation, and survives', () => {
  const { sim, metrics } = start({ seed: 4, size: 10, swim: { suspectTimeout: 8000 }, network: { loss: 0.45 } });
  sim.runUntil(60_000);
  assert.ok(metrics.falseSuspects > 0, 'loss causes false suspicion');
  const refuted = sim.nodeIds().filter((id) => node(sim, id).inc > 0);
  assert.ok(refuted.length > 0, 'at least one node refuted');
  sim.input({ type: 'network', patch: { loss: 0 } });
  sim.runUntil(120_000);
  assert.ok(metrics.isConverged(), 'cluster recovers once the network is clean');
});

test('indirect probes prevent false suspicion when only one link is bad', () => {
  const run = (indirectK: number) => {
    const { sim, metrics } = start({ seed: 6, size: 8, swim: { indirectK } });
    sim.runUntil(10_000);
    // n1 and n2 cannot talk to each other, but both reach everyone else.
    const net = sim.network;
    const canReach = net.canReach.bind(net);
    net.canReach = (a, b) => !((a === 'n1' && b === 'n2') || (a === 'n2' && b === 'n1')) && canReach(a, b);
    sim.runUntil(70_000);
    return metrics.falseSuspects;
  };
  assert.ok(run(0) > 0, 'without ping-req the broken link causes suspicion');
  assert.equal(run(3), 0, 'with k=3 helpers vouch for the node');
});

test('a partition splits the view; healing reunites it', () => {
  const { sim, metrics } = start({ seed: 7, size: 10 });
  sim.runUntil(15_000);
  const left = ['n0', 'n1', 'n2', 'n3'];
  sim.input({ type: 'partition', groups: [left] });
  sim.runUntil(60_000);
  assert.deepEqual(node(sim, 'n0').table.withStatus('alive').sort(), left);
  assert.equal(node(sim, 'n7').table.withStatus('alive').length, 6);
  assert.ok(!metrics.isConverged());

  sim.input({ type: 'heal' });
  sim.runUntil(150_000);
  assert.ok(metrics.isConverged(), 'views reunite after heal');
  for (const id of sim.nodeIds()) assert.ok(node(sim, id).inc >= 1, `${id} refuted its death`);
});

test('piggybacked updates respect the configured bound', () => {
  const sim = createCluster({ seed: 8, size: 20, swim: { piggybackMax: 2 } });
  const sizes: number[] = [];
  for (const id of sim.nodeIds()) {
    const n = node(sim, id);
    const onMessage = n.onMessage.bind(n);
    n.onMessage = (from, msg, ctx) => {
      if ('updates' in msg) sizes.push(msg.updates.length);
      onMessage(from, msg, ctx);
    };
  }
  sim.runUntil(30_000);
  assert.ok(sizes.length > 500);
  // +1: a node may prepend its belief about the recipient.
  assert.ok(Math.max(...sizes) <= 3);
});

test('SWIM runs are deterministic and replayable', () => {
  const o: ClusterOptions = { seed: 77, size: 12, network: { loss: 0.2, duplication: 0.05, reorder: 0.1 } };
  const live = createCluster(o);
  live.runUntil(8000);
  live.input({ type: 'kill', node: 'n3' });
  live.runUntil(15_000);
  live.input({ type: 'config', patch: { protocolPeriod: 400, suspectTimeout: 1500 } });
  live.input({ type: 'restart', node: 'n3' });
  live.runUntil(30_000);
  const again = replay(clusterOptions(o), live.inputs, 30_000);
  assert.equal(JSON.stringify(again.log), JSON.stringify(live.log));
});
