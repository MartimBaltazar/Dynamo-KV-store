import { buildTree, type MerkleTree } from './merkle.ts';
import { fingerprint, reconcile, type Version } from './vclock.ts';

/** A node's local storage: for every key, its current sibling set. */
export class Replica {
  private readonly data = new Map<string, Version[]>();

  get size(): number {
    return this.data.size;
  }

  get(key: string): Version[] {
    return this.data.get(key) ?? [];
  }

  keys(): string[] {
    return [...this.data.keys()];
  }

  /** Merges versions into the key's sibling set. Returns whether anything changed. */
  apply(key: string, versions: readonly Version[]): boolean {
    const current = this.get(key);
    const next = reconcile([...current, ...versions]);
    if (fingerprint(next) === fingerprint(current)) return false;
    this.data.set(key, next);
    return true;
  }

  entries(include: (key: string) => boolean): [string, Version[]][] {
    return [...this.data].filter(([key]) => include(key));
  }

  /** Merkle tree over the keys selected by `include`. */
  tree(include: (key: string) => boolean): MerkleTree {
    return buildTree(this.entries(include).map(([key, versions]) => [key, fingerprint(versions)] as const));
  }
}
