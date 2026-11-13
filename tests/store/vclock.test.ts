import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rng } from '../../src/engine/rng.ts';
import { clockKey, compare, contextOf, descends, increment, merge, reconcile, type VClock, type Version } from '../../src/store/vclock.ts';

function randomClock(rng: Rng): VClock {
  const c: Record<string, number> = {};
  for (const n of ['a', 'b', 'c', 'd']) if (rng.chance(0.7)) c[n] = 1 + rng.int(3);
  return c;
}

test('basic ordering', () => {
  assert.equal(compare({}, {}), 'equal');
  assert.equal(compare({ a: 1 }, { a: 1, b: 0 }), 'equal', 'missing entries are zero');
  assert.equal(compare({ a: 2 }, { a: 1 }), 'after');
  assert.equal(compare({ a: 1 }, { a: 1, b: 1 }), 'before');
  assert.equal(compare({ a: 1 }, { b: 1 }), 'concurrent');
});

test('property: partial order laws hold on random clocks', () => {
  const rng = new Rng(11);
  const flip = { equal: 'equal', before: 'after', after: 'before', concurrent: 'concurrent' } as const;
  for (let i = 0; i < 3000; i++) {
    const [a, b, c] = [randomClock(rng), randomClock(rng), randomClock(rng)];
    assert.equal(compare(a, a), 'equal');
    assert.equal(compare(b, a), flip[compare(a, b)], 'antisymmetry');
    if (descends(a, b) && descends(b, c)) assert.ok(descends(a, c), 'transitivity');
    const m = merge(a, b);
    assert.ok(descends(m, a) && descends(m, b), 'merge is an upper bound');
    if (descends(c, a) && descends(c, b)) assert.ok(descends(c, m), 'merge is the least upper bound');
    assert.equal(clockKey(merge(a, b)), clockKey(merge(b, a)), 'merge commutes');
    assert.equal(compare(increment(a, 'a'), a), 'after');
  }
});

test('reconcile keeps only versions nobody descends', () => {
  const v = (value: string, clock: VClock): Version => ({ value, clock });
  const old = v('old', { a: 1 });
  const newer = v('newer', { a: 2 });
  const other = v('other', { a: 1, b: 1 });
  assert.deepEqual(reconcile([old, newer]), [newer]);
  assert.deepEqual(reconcile([newer, other]).map((x) => x.value).sort(), ['newer', 'other'], 'concurrent versions are siblings');
  assert.deepEqual(reconcile([newer, old, newer, other, old]).length, 2, 'duplicates collapse');
  const resolved = v('resolved', increment(contextOf([newer, other]), 'a'));
  assert.deepEqual(reconcile([newer, other, resolved]), [resolved], 'a write with the merged context supersedes all siblings');
});

test('property: reconcile is order-independent and idempotent', () => {
  const rng = new Rng(12);
  for (let i = 0; i < 500; i++) {
    const versions = Array.from({ length: 1 + rng.int(6) }, () => {
      const clock = randomClock(rng);
      return { value: clockKey(clock), clock };
    });
    const a = reconcile(versions);
    const b = reconcile(rng.shuffle([...versions]));
    assert.deepEqual(a, b);
    assert.deepEqual(reconcile(a), a);
    for (const x of a) for (const y of a) if (x !== y) assert.equal(compare(x.clock, y.clock), 'concurrent');
  }
});
