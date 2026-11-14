import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lane } from '../../src/ui/lane.ts';
import { scenarios, type Scenario } from '../../src/ui/scenarios.ts';

/** Plays a scenario on a Classic and an Improved lane in lockstep, as the page does. */
function play(s: Scenario, seconds: number) {
  const lanes = [new Lane(false, null), new Lane(true, null)];
  lanes.forEach((l) => l.start(s));
  const script = [...s.script].sort((a, b) => a.t - b.t);
  for (let t = 0; t <= seconds * 1000; t += 100) {
    while (script.length && script[0].t <= t) {
      const next = script.shift()!;
      for (const l of lanes) {
        l.runUntil(next.t);
        l.input(next.input);
      }
    }
    for (const l of lanes) l.runUntil(t);
    if (t % 1000 === 0) lanes.forEach((l) => l.settle());
  }
  const [classic, improved] = lanes.map((l) => ({ r: l.readings(), lane: l }));
  return { classic, improved };
}

const get = (id: string) => scenarios.find((s) => s.id === id)!;
const n = (v: { n?: number }) => v.n ?? NaN;

test('every scenario starts both lanes from the same setup', () => {
  for (const s of scenarios) {
    const a = new Lane(false, null);
    const b = new Lane(true, null);
    a.start(s);
    b.start(s);
    assert.equal(a.storeIds.length, b.storeIds.length);
    assert.equal(a.cfg.phi, 0);
    assert.equal(b.cfg.phi, 1);
    assert.equal(a.cfg.rate, b.cfg.rate);
  }
});

test('a node dies: nothing is lost, and the cluster notices', () => {
  const { classic, improved } = play(get('node-dies'), 50);
  for (const side of [classic, improved]) {
    assert.equal(n(side.r.stale), 0);
    assert.ok(n(side.r.detect) > 0, 'the death is noticed');
    assert.ok(n(side.r.avail) > 0.9);
  }
});

test('packet loss: classic kills healthy nodes, improved does not', () => {
  const { classic, improved } = play(get('packet-loss'), 60);
  assert.ok(n(classic.r.falseDead) >= 5, `classic made ${n(classic.r.falseDead)} false verdicts`);
  assert.ok(n(improved.r.falseDead) * 3 <= n(classic.r.falseDead));
});

test('slow node: improved routes around it', () => {
  const { classic, improved } = play(get('slow-node'), 30);
  assert.ok(n(classic.r.p99) > 2 * n(improved.r.p99), `p99 ${n(classic.r.p99)} vs ${n(improved.r.p99)}`);
  assert.ok(n(improved.r.avail) > n(classic.r.avail));
});

test('viral key: improved spreads the load', () => {
  const { classic, improved } = play(get('viral-key'), 30);
  assert.ok(n(classic.r.load) > 1.8, `classic ${n(classic.r.load)}`);
  assert.ok(n(improved.r.load) < n(classic.r.load) - 0.5, `improved ${n(improved.r.load)}`);
});

test('the narrator describes what happens', () => {
  const s = get('node-dies');
  const { classic } = play(s, 12);
  // After the crash at 4 s, something about n3 must have been queued and shown.
  const text = classic.lane.caption(1e9);
  assert.ok(text.length > 0);
  assert.match(text, /n3|stand-in|hint|dead|suspect/i);
});
