import { diffTrees, type MerkleTree } from '../store/merkle.ts';

/**
 * Two replicas' Merkle trees laid over each other, one row per level. A cell
 * is red where the hashes differ; anti-entropy only ever descends through red
 * cells, which is why agreeing replicas cost a single root comparison.
 */
export class MerkleView {
  private readonly root: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly grid: HTMLElement;
  private last = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.caption = document.createElement('p');
    this.caption.className = 'hint';
    this.grid = document.createElement('div');
    this.grid.className = 'merkle';
    this.root.append(this.caption, this.grid);
    parent.appendChild(this.root);
  }

  render(pair: { a: string; b: string; treeA: MerkleTree; treeB: MerkleTree } | null): void {
    if (!pair) {
      if (this.last !== '') {
        this.last = '';
        this.grid.replaceChildren();
      }
      this.caption.textContent = 'Select exactly two store nodes to compare the Merkle trees of the key ranges they share.';
      return;
    }
    const { a, b, treeA, treeB } = pair;
    const signature = `${a}|${b}|${treeA.levels.flat().join(',')}|${treeB.levels.flat().join(',')}`;
    if (signature === this.last) return;
    this.last = signature;

    const diff = diffTrees(treeA, treeB);
    const leaves = treeA.levels[treeA.depth].length;
    const total = treeA.levels.reduce((n, level) => n + level.length, 0);
    this.caption.textContent =
      diff.leaves.length === 0
        ? `${a} and ${b} agree: one root comparison settles it (${total} tree nodes untouched).`
        : `${a} and ${b} differ in ${diff.leaves.length} of ${leaves} ranges. A sync compares ${diff.compared} of ${total} tree nodes.`;

    this.grid.replaceChildren(
      ...treeA.levels.map((level, l) => {
        const row = document.createElement('div');
        level.forEach((hash, i) => {
          const cell = document.createElement('i');
          const other = treeB.levels[l][i];
          cell.className = hash !== other ? 'diff' : hash === 0 ? 'empty' : 'same';
          row.appendChild(cell);
        });
        return row;
      }),
    );
  }
}
