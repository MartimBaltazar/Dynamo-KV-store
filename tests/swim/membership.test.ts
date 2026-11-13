import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemberTable, supersedes, type Member, type Status, type Update } from '../../src/swim/membership.ts';

const m = (status: Status, inc: number): Member => ({ status, inc, since: 0 });
const u = (status: Status, inc: number): Update => ({ id: 'x', status, inc });

test('anything supersedes an unknown member', () => {
  assert.ok(supersedes(u('dead', 0), undefined));
});

test('a higher incarnation always wins, a lower one never does', () => {
  const statuses: Status[] = ['alive', 'suspect', 'dead'];
  for (const a of statuses)
    for (const b of statuses) {
      assert.ok(supersedes(u(a, 2), m(b, 1)), `${a}@2 over ${b}@1`);
      assert.ok(!supersedes(u(a, 1), m(b, 2)), `${a}@1 not over ${b}@2`);
    }
});

test('at equal incarnation the worse news wins: dead > suspect > alive', () => {
  assert.ok(supersedes(u('suspect', 1), m('alive', 1)));
  assert.ok(supersedes(u('dead', 1), m('suspect', 1)));
  assert.ok(supersedes(u('dead', 1), m('alive', 1)));
  assert.ok(!supersedes(u('alive', 1), m('suspect', 1)));
  assert.ok(!supersedes(u('alive', 1), m('dead', 1)));
  assert.ok(!supersedes(u('suspect', 1), m('dead', 1)));
  assert.ok(!supersedes(u('alive', 1), m('alive', 1)), 'identical news is not news');
});

test('applying updates in any order converges to the same table', () => {
  const updates: Update[] = [u('alive', 0), u('suspect', 0), u('alive', 1), u('suspect', 1), u('dead', 1), u('alive', 2)];
  const permutations = (xs: Update[]): Update[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  for (const order of permutations(updates)) {
    const t = new MemberTable();
    for (const x of order) t.apply(x, 0);
    assert.deepEqual(t.snapshot(), [u('alive', 2)]);
  }
});

test('table reports changes and filters by status', () => {
  const t = new MemberTable();
  assert.equal(t.apply({ id: 'a', status: 'alive', inc: 0 }, 5), true);
  assert.equal(t.apply({ id: 'a', status: 'alive', inc: 0 }, 9), false);
  assert.equal(t.get('a')!.since, 5);
  t.apply({ id: 'b', status: 'suspect', inc: 0 }, 6);
  t.apply({ id: 'c', status: 'dead', inc: 3 }, 7);
  assert.deepEqual(t.withStatus('alive', 'suspect'), ['a', 'b']);
  assert.deepEqual(t.withStatus('dead'), ['c']);
  assert.equal(t.size, 3);
});
