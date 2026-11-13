import type { NodeId } from '../engine/types.ts';
import { hash32 } from './hash.ts';

export interface Token {
  token: number;
  node: NodeId;
}

/**
 * Consistent-hash ring with virtual nodes. Each physical node owns `vnodes`
 * tokens; a key belongs to the first token at or after its hash, clockwise.
 * Immutable: build a new ring when membership changes.
 */
export class Ring {
  readonly nodes: readonly NodeId[];
  readonly tokens: readonly Token[];

  constructor(nodes: readonly NodeId[], vnodes: number) {
    this.nodes = [...new Set(nodes)].sort();
    const tokens: Token[] = [];
    for (const node of this.nodes) {
      for (let i = 0; i < Math.max(1, Math.round(vnodes)); i++) tokens.push({ token: hash32(`${node}#${i}`), node });
    }
    this.tokens = tokens.sort((a, b) => a.token - b.token || (a.node < b.node ? -1 : 1));
  }

  /**
   * Distinct physical nodes met walking clockwise from the key's position.
   * The first N are the key's owners; the rest are fallbacks, in order.
   */
  walk(key: string, limit = Infinity): NodeId[] {
    const out: NodeId[] = [];
    const count = this.tokens.length;
    const max = Math.min(limit, this.nodes.length);
    const start = this.indexFor(hash32(key));
    for (let i = 0; i < count && out.length < max; i++) {
      const node = this.tokens[(start + i) % count].node;
      if (!out.includes(node)) out.push(node);
    }
    return out;
  }

  /** The N distinct nodes responsible for the key. */
  preferenceList(key: string, n: number): NodeId[] {
    return this.walk(key, n);
  }

  /** Index of the first token >= h, wrapping to 0. */
  private indexFor(h: number): number {
    let lo = 0;
    let hi = this.tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tokens[mid].token < h) lo = mid + 1;
      else hi = mid;
    }
    return lo === this.tokens.length ? 0 : lo;
  }
}
