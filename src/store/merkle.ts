import { hash32, mix32 } from '../ring/hash.ts';

/** Tree depth: 2^5 = 32 leaf buckets over the key hash space. */
export const MERKLE_DEPTH = 5;

/** `levels[0]` is `[root]`; `levels[depth]` holds the leaf bucket hashes. */
export interface MerkleTree {
  depth: number;
  levels: number[][];
}

export function bucketOf(key: string, depth = MERKLE_DEPTH): number {
  return depth === 0 ? 0 : hash32(key) >>> (32 - depth);
}

/**
 * Builds a hash tree over (key, content fingerprint) pairs. A leaf combines
 * its entries commutatively, so iteration order does not matter; an empty
 * subtree hashes to 0.
 */
export function buildTree(entries: Iterable<readonly [string, string]>, depth = MERKLE_DEPTH): MerkleTree {
  const leaves = new Array<number>(1 << depth).fill(0);
  for (const [key, content] of entries) {
    const b = bucketOf(key, depth);
    leaves[b] = (leaves[b] + hash32(`${key}\u0000${content}`)) >>> 0;
  }
  const levels: number[][] = new Array(depth + 1);
  levels[depth] = leaves;
  for (let l = depth - 1; l >= 0; l--) {
    const below = levels[l + 1];
    levels[l] = Array.from({ length: 1 << l }, (_, i) => {
      const left = below[2 * i];
      const right = below[2 * i + 1];
      return left === 0 && right === 0 ? 0 : mix32(left, right);
    });
  }
  return { depth, levels };
}

export interface TreeDiff {
  /** Leaf buckets whose contents differ. */
  leaves: number[];
  /** Tree nodes compared to find them; the saving over comparing every leaf. */
  compared: number;
}

/** Top-down comparison that only descends into subtrees whose hashes differ. */
export function diffTrees(a: MerkleTree, b: MerkleTree): TreeDiff {
  let frontier = [0];
  let compared = 0;
  for (let level = 0; level <= a.depth; level++) {
    compared += frontier.length;
    const differing = frontier.filter((i) => a.levels[level][i] !== b.levels[level][i]);
    if (level === a.depth) return { leaves: differing, compared };
    frontier = differing.flatMap((i) => [2 * i, 2 * i + 1]);
    if (frontier.length === 0) break;
  }
  return { leaves: [], compared };
}
