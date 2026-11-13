import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventQueue } from '../../src/engine/eventQueue.ts';
import { Rng } from '../../src/engine/rng.ts';

test('pops in time order', () => {
  const q = new EventQueue<string>();
  q.push(30, 'c');
  q.push(10, 'a');
  q.push(20, 'b');
  assert.equal(q.peekTime(), 10);
  assert.deepEqual([q.pop()!.item, q.pop()!.item, q.pop()!.item], ['a', 'b', 'c']);
  assert.equal(q.pop(), undefined);
  assert.equal(q.peekTime(), Infinity);
});

test('simultaneous events pop in insertion order', () => {
  const q = new EventQueue<number>();
  for (let i = 0; i < 100; i++) q.push(5, i);
  for (let i = 0; i < 100; i++) assert.equal(q.pop()!.item, i);
});

test('random workload comes out sorted by (time, seq)', () => {
  const rng = new Rng(3);
  const q = new EventQueue<number>();
  for (let i = 0; i < 2000; i++) q.push(rng.int(50), i);
  let prev = q.pop()!;
  while (q.size) {
    const cur = q.pop()!;
    assert.ok(cur.time > prev.time || (cur.time === prev.time && cur.seq > prev.seq));
    prev = cur;
  }
});
