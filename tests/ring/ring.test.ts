import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rng } from '../../src/engine/rng.ts';
import { hash32 } from '../../src/ring/hash.ts';
import { Ring } from '../../src/ring/ring.ts';

const names = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`);
const keys = (n: number) => Array.from({ length: n }, (_, i) => `key-${i}`);

test('hash32 is deterministic, 32-bit and well spread', () => {
  assert.equal(hash32('hello'), hash32('hello'));
  assert.notEqual(hash32('hello'), hash32('hellp'));
  const buckets = new Array(16).fill(0);
  for (const k of keys(16_000)) {
    const h = hash32(k);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    buckets[h >>> 28]++;
  }
  for (const c of buckets) assert.ok(c > 850 && c < 1150, `bucket ${c}`);
});

test('preference list has N distinct nodes and is a prefix of the walk', () => {
  const ring = new Ring(names(8), 16);
  for (const k of keys(500)) {
    const pref = ring.preferenceList(k, 3);
    assert.equal(pref.length, 3);
    assert.equal(new Set(pref).size, 3);
    const walk = ring.walk(k);
    assert.deepEqual(walk.slice(0, 3), pref);
    assert.deepEqual([...walk].sort(), names(8).sort(), 'walk visits every node once');
  }
  assert.equal(new Ring(names(2), 8).preferenceList('x', 3).length, 2, 'never more than the cluster has');
});

test('ring does not depend on the order nodes are listed in', () => {
  const rng = new Rng(1);
  const a = new Ring(names(10), 8);
  const b = new Ring(rng.shuffle(names(10)), 8);
  for (const k of keys(200)) assert.deepEqual(a.walk(k), b.walk(k));
});

test('property: more virtual nodes give a more even key split', () => {
  const spread = (vnodes: number) => {
    const ring = new Ring(names(10), vnodes);
    const load = new Map<string, number>();
    for (const k of keys(20_000)) {
      const owner = ring.preferenceList(k, 1)[0];
      load.set(owner, (load.get(owner) ?? 0) + 1);
    }
    return Math.max(...load.values()) / (20_000 / 10);
  };
  const one = spread(1);
  const many = spread(128);
  assert.ok(many < 1.35, `max/avg with 128 vnodes: ${many}`);
  assert.ok(many < one, `128 vnodes (${many}) beats 1 vnode (${one})`);
});

test('property: adding a node moves about 1/n of keys, and only onto the new node', () => {
  for (const n of [4, 9, 19]) {
    const before = new Ring(names(n), 64);
    const after = new Ring(names(n + 1), 64);
    let moved = 0;
    const all = keys(10_000);
    for (const k of all) {
      const a = before.preferenceList(k, 1)[0];
      const b = after.preferenceList(k, 1)[0];
      if (a !== b) {
        moved++;
        assert.equal(b, `n${n}`, 'a key only ever moves to the newcomer');
      }
    }
    const ideal = all.length / (n + 1);
    assert.ok(moved > ideal * 0.6 && moved < ideal * 1.5, `n=${n}: moved ${moved}, ideal ${ideal}`);
  }
});
