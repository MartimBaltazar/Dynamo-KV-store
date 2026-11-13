import type { NodeId } from '../engine/types.ts';
import { fingerprint, reconcile, type Version } from './vclock.ts';

interface Hint {
  versions: Version[];
  expires: number;
}

/**
 * Writes held on behalf of replicas that were unreachable. Kept apart from
 * the node's own data, and handed back when the intended owner returns.
 */
export class HintStore {
  private readonly byTarget = new Map<NodeId, Map<string, Hint>>();

  /** Number of hinted keys held, across all targets. */
  get depth(): number {
    let n = 0;
    for (const hints of this.byTarget.values()) n += hints.size;
    return n;
  }

  add(target: NodeId, key: string, version: Version, expires: number): void {
    let hints = this.byTarget.get(target);
    if (!hints) this.byTarget.set(target, (hints = new Map()));
    const existing = hints.get(key);
    hints.set(key, { versions: reconcile([...(existing?.versions ?? []), version]), expires });
  }

  targets(): NodeId[] {
    return [...this.byTarget.keys()];
  }

  entries(target: NodeId): [string, Version[]][] {
    return [...(this.byTarget.get(target) ?? [])].map(([key, h]) => [key, h.versions]);
  }

  /** Everything held for this key, whoever it is meant for. Lets a stand-in serve reads. */
  versionsFor(key: string): Version[] {
    const out: Version[] = [];
    for (const hints of this.byTarget.values()) out.push(...(hints.get(key)?.versions ?? []));
    return out;
  }

  /** Forgets delivered hints, unless the hint changed since it was sent. */
  clear(target: NodeId, delivered: readonly [string, Version[]][]): void {
    const hints = this.byTarget.get(target);
    if (!hints) return;
    for (const [key, versions] of delivered) {
      const held = hints.get(key);
      if (held && fingerprint(held.versions) === fingerprint(versions)) hints.delete(key);
    }
    if (hints.size === 0) this.byTarget.delete(target);
  }

  /** Drops hints past their TTL. Returns how many were dropped. */
  expire(now: number): number {
    let dropped = 0;
    for (const [target, hints] of this.byTarget) {
      for (const [key, h] of hints) {
        if (h.expires <= now) {
          hints.delete(key);
          dropped++;
        }
      }
      if (hints.size === 0) this.byTarget.delete(target);
    }
    return dropped;
  }
}
