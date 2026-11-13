import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rng } from '../../src/engine/rng.ts';
import { bucketOf, buildTree, diffTrees, MERKLE_DEPTH } from '../../src/store/merkle.ts';

const data = (n: number): [string, string][] => Array.from({ length: n }, (_, i) => [`k${i}`, `v${i}`]);

test('equal content gives equal trees regardless of insertion order', () => {
  const rng = new Rng(1);
  const a = buildTree(data(300));
  const b = buildTree(rng.shuffle(data(300)));
  assert.deepEqual(a.levels, b.levels);
  assert.deepEqual(diffTrees(a, b), { leaves: [], compared: 1 }, 'one root comparison is enough');
});

test('an empty tree hashes to zero everywhere', () => {
  const t = buildTree([]);
  assert.equal(t.levels.length, MERKLE_DEPTH + 1);
  assert.ok(t.levels.every((level) => level.every((h) => h === 0)));
});

test('a single changed key is found by comparing only one path', () => {
  const a = data(300);
  const b = data(300);
  b[137][1] = 'changed';
  const diff = diffTrees(buildTree(a), buildTree(b));
  assert.deepEqual(diff.leaves, [bucketOf('k137')]);
  assert.equal(diff.compared, 1 + 2 * MERKLE_DEPTH, 'root plus two children per level');
});

test('property: diff reports exactly the buckets of differing keys', () => {
  const rng = new Rng(2);
  for (let round = 0; round < 200; round++) {
    const a = new Map(data(120));
    const b = new Map(a);
    const touched = new Set<number>();
    for (let i = 0; i < rng.int(8); i++) {
      const key = `k${rng.int(140)}`;
      const action = rng.int(3);
      if (action === 0) b.delete(key);
      else b.set(key, `mut${round}-${i}`);
      if (a.get(key) !== b.get(key)) touched.add(bucketOf(key));
      else touched.delete(bucketOf(key));
    }
    const expected = new Set<number>();
    for (const key of new Set([...a.keys(), ...b.keys()])) if (a.get(key) !== b.get(key)) expected.add(bucketOf(key));
    assert.deepEqual(diffTrees(buildTree(a), buildTree(b)).leaves, [...expected].sort((x, y) => x - y));
  }
});
