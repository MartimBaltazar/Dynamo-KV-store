import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Disseminator, retransmitLimit } from '../../src/swim/gossip.ts';

test('each item is sent exactly `limit` times, then forgotten', () => {
  const d = new Disseminator<string>();
  d.enqueue('a', 'A');
  const sends: string[] = [];
  for (let i = 0; i < 10; i++) sends.push(...d.take(5, 3));
  assert.deepEqual(sends, ['A', 'A', 'A']);
  assert.equal(d.size, 0);
});

test('at most `max` items per message, least-sent first', () => {
  const d = new Disseminator<string>();
  d.enqueue('a', 'A');
  d.enqueue('b', 'B');
  assert.deepEqual(d.take(2, 9), ['A', 'B']);
  d.enqueue('c', 'C');
  assert.deepEqual(d.take(1, 9), ['C'], 'fresh news jumps the queue');
  assert.equal(d.take(2, 9).length, 2);
  assert.deepEqual(d.take(0, 9), []);
});

test('a newer item for the same key replaces the old one and resets its count', () => {
  const d = new Disseminator<string>();
  d.enqueue('a', 'old');
  d.take(1, 2);
  d.enqueue('a', 'new');
  assert.equal(d.size, 1);
  assert.deepEqual([...d.take(1, 2), ...d.take(1, 2), ...d.take(1, 2)], ['new', 'new']);
});

test('retransmit limit grows with log of cluster size', () => {
  assert.equal(retransmitLimit(3, 1), 3);
  assert.equal(retransmitLimit(3, 7), 9);
  assert.equal(retransmitLimit(3, 1023), 30);
  assert.equal(retransmitLimit(0, 100), 1);
});
