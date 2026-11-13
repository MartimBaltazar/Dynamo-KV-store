import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HintStore } from '../../src/store/hints.ts';

const v = (value: string, n: number) => ({ value, clock: { a: n } });

test('hints are grouped by target and reconciled per key', () => {
  const h = new HintStore();
  h.add('n1', 'k', v('one', 1), 100);
  h.add('n1', 'k', v('two', 2), 100);
  h.add('n1', 'j', v('x', 1), 100);
  h.add('n2', 'k', v('two', 2), 100);
  assert.equal(h.depth, 3);
  assert.deepEqual(h.targets(), ['n1', 'n2']);
  assert.deepEqual(new Map(h.entries('n1')).get('k'), [v('two', 2)], 'newer write replaced the older hint');
  assert.equal(h.versionsFor('k').length, 2);
});

test('clear removes delivered hints but keeps ones that changed meanwhile', () => {
  const h = new HintStore();
  h.add('n1', 'k', v('one', 1), 100);
  h.add('n1', 'j', v('x', 1), 100);
  const sent = h.entries('n1');
  h.add('n1', 'j', v('y', 2), 100);
  h.clear('n1', sent);
  assert.equal(h.depth, 1);
  assert.deepEqual(h.entries('n1'), [['j', [v('y', 2)]]]);
});

test('hints expire at their TTL', () => {
  const h = new HintStore();
  h.add('n1', 'k', v('one', 1), 100);
  h.add('n2', 'k', v('one', 1), 300);
  assert.equal(h.expire(99), 0);
  assert.equal(h.expire(100), 1);
  assert.deepEqual(h.targets(), ['n2']);
});
