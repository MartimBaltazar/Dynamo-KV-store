import type { NodeId, SimEvent } from '../engine/types.ts';
import type { Status, Update } from './membership.ts';

export interface FailureRecord {
  node: NodeId;
  /** When the node actually went down. */
  t: number;
  /** Delays, in ms after `t`, until the first observer suspected / declared it dead. */
  firstSuspect?: number;
  firstDead?: number;
  /** Delay until every live node had it as dead. */
  allDead?: number;
}

/**
 * Derives SWIM health metrics purely from the event log, by comparing what
 * each node believes with what is actually true.
 */
export class SwimMetrics {
  readonly up = new Set<NodeId>();
  readonly all: NodeId[] = [];
  readonly failures: FailureRecord[] = [];
  sent = 0;
  lost = 0;
  /** Suspicions and death verdicts about a node that was in fact running. */
  falseSuspects = 0;
  falseDeads = 0;
  /** Time of the last kill / restart / partition / heal / add. */
  lastDisturbance = 0;
  /** When every live node's view first matched reality after that; null while they differ. */
  convergedAt: number | null = null;

  private readonly views = new Map<NodeId, Map<NodeId, Update>>();

  /** What `observer` currently believes about `subject`. */
  belief(observer: NodeId, subject: NodeId): Update | undefined {
    return this.views.get(observer)?.get(subject);
  }

  onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'send':
        this.sent++;
        return;
      case 'drop':
        this.sent += e.reason === 'down' ? 0 : 1;
        this.lost++;
        return;
      case 'up':
        if (!this.all.includes(e.node)) this.all.push(e.node);
        this.up.add(e.node);
        this.views.set(e.node, new Map());
        this.disturb(e.t);
        return;
      case 'down':
        this.up.delete(e.node);
        this.failures.push({ node: e.node, t: e.t });
        this.disturb(e.t);
        return;
      case 'input':
        if (e.input.type === 'partition' || e.input.type === 'heal') this.disturb(e.t);
        return;
      case 'state':
        if (e.kind === 'member') this.onMember(e.t, e.node, e.data as Update);
        return;
    }
  }

  private onMember(t: number, observer: NodeId, u: Update): void {
    this.views.get(observer)?.set(u.id, u);
    if (u.id !== observer && u.status !== 'alive') {
      if (this.up.has(u.id)) {
        if (u.status === 'suspect') this.falseSuspects++;
        else this.falseDeads++;
      } else {
        const f = this.openFailure(u.id);
        if (f) {
          if (u.status === 'suspect') f.firstSuspect ??= t - f.t;
          else {
            f.firstDead ??= t - f.t;
            if (f.allDead === undefined && this.everyoneHas(u.id, 'dead')) f.allDead = t - f.t;
          }
        }
      }
    }
    if (!this.isConverged()) this.convergedAt = null;
    else this.convergedAt ??= t;
  }

  /** True when every live node sees every live node as alive and no dead node as alive. */
  isConverged(): boolean {
    for (const o of this.up) {
      const view = this.views.get(o)!;
      for (const s of this.all) {
        if (s === o) continue;
        const status = view.get(s)?.status;
        if (this.up.has(s) ? status !== 'alive' : status !== undefined && status !== 'dead') return false;
      }
    }
    return true;
  }

  private disturb(t: number): void {
    this.lastDisturbance = t;
    this.convergedAt = this.isConverged() ? t : null;
  }

  private openFailure(id: NodeId): FailureRecord | undefined {
    for (let i = this.failures.length - 1; i >= 0; i--) if (this.failures[i].node === id) return this.failures[i];
    return undefined;
  }

  private everyoneHas(subject: NodeId, status: Status): boolean {
    for (const o of this.up) if (this.views.get(o)!.get(subject)?.status !== status) return false;
    return true;
  }
}
