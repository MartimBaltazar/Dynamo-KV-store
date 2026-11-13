import type { NodeId } from '../engine/types.ts';

export type Status = 'alive' | 'suspect' | 'dead';

/** A claim about one member, as gossiped between nodes. */
export interface Update {
  id: NodeId;
  status: Status;
  /** Incarnation number: only the member itself ever increases it. */
  inc: number;
  /** For a suspicion: the node that failed to reach the member itself. */
  by?: NodeId;
}

export interface Member {
  status: Status;
  inc: number;
  /** Virtual time this node last changed its mind about the member. */
  since: number;
}

const rank: Record<Status, number> = { alive: 0, suspect: 1, dead: 2 };

/**
 * SWIM precedence. A higher incarnation always wins, because only the member
 * itself can produce one (that is how it refutes suspicion or rejoins after
 * being declared dead). At equal incarnation the worse news wins.
 */
export function supersedes(update: Update, current: Member | undefined): boolean {
  if (!current) return true;
  if (update.inc !== current.inc) return update.inc > current.inc;
  return rank[update.status] > rank[current.status];
}

/** One node's local view of the cluster. */
export class MemberTable {
  private readonly members = new Map<NodeId, Member>();

  get size(): number {
    return this.members.size;
  }

  get(id: NodeId): Member | undefined {
    return this.members.get(id);
  }

  has(id: NodeId): boolean {
    return this.members.has(id);
  }

  /** Applies the update if it supersedes what is known. Returns whether anything changed. */
  apply(update: Update, now: number): boolean {
    if (!supersedes(update, this.members.get(update.id))) return false;
    this.members.set(update.id, { status: update.status, inc: update.inc, since: now });
    return true;
  }

  ids(): NodeId[] {
    return [...this.members.keys()];
  }

  /** Ids whose status is one of `statuses`, in insertion order. */
  withStatus(...statuses: Status[]): NodeId[] {
    const out: NodeId[] = [];
    for (const [id, m] of this.members) if (statuses.includes(m.status)) out.push(id);
    return out;
  }

  /** The whole table as updates, for a full state sync. */
  snapshot(): Update[] {
    return [...this.members].map(([id, m]) => ({ id, status: m.status, inc: m.inc }));
  }
}
