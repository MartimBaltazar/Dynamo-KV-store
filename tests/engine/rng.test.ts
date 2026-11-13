import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rng } from '../../src/engine/rng.ts';

test('same seed gives the same sequence', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});

test('different seeds diverge', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  const same = Array.from({ length: 20 }, () => a.next() === b.next()).filter(Boolean).length;
  assert.ok(same < 20);
});

test('next stays in [0, 1) and int stays in range', () => {
  const r = new Rng(7);
  for (let i = 0; i < 10_000; i++) {
    const x = r.next();
    assert.ok(x >= 0 && x < 1);
    const n = r.int(10);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 10);
  }
});

test('int is roughly uniform', () => {
  const r = new Rng(99);
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 100_000; i++) counts[r.int(10)]++;
  for (const c of counts) assert.ok(c > 9_300 && c < 10_700, `bucket count ${c}`);
});

test('shuffle is a permutation and sample returns distinct items', () => {
  const r = new Rng(5);
  const items = Array.from({ length: 50 }, (_, i) => i);
  const shuffled = r.shuffle([...items]);
  assert.deepEqual([...shuffled].sort((x, y) => x - y), items);
  const s = r.sample(items, 7);
  assert.equal(s.length, 7);
  assert.equal(new Set(s).size, 7);
  assert.equal(r.sample(items, 99).length, 50);
});
