import type { Rng } from './rng.ts';
import type { NodeId } from './types.ts';

export interface NetworkConfig {
  /** Mean one-way latency in ms. */
  latencyMean: number;
  /** Latency is uniform in [mean - jitter, mean + jitter]. */
  latencyJitter: number;
  /** Probability a message is lost, 0..1. */
  loss: number;
  /** Probability a message is delivered twice, 0..1. */
  duplication: number;
  /** Probability a message is held back long enough to arrive out of order, 0..1. */
  reorder: number;
}

export const defaultNetwork: NetworkConfig = {
  latencyMean: 40,
  latencyJitter: 15,
  loss: 0,
  duplication: 0,
  reorder: 0,
};

export interface DeliveryPlan {
  /** One entry per copy that will arrive; empty when dropped. */
  delays: number[];
  dropped?: 'loss' | 'partition';
}

/**
 * The simulated network. Every fault lives here; nodes never know whether
 * they are being lied to.
 */
export class SimNetwork {
  readonly config: NetworkConfig;
  /** Nodes in different groups cannot talk. Nodes in no group form one implicit group. */
  partitions: NodeId[][] = [];
  /** Latency multiplier for links touching a slow node. */
  readonly slow = new Map<NodeId, number>();

  constructor(config: Partial<NetworkConfig> = {}) {
    this.config = { ...defaultNetwork, ...config };
  }

  canReach(a: NodeId, b: NodeId): boolean {
    if (this.partitions.length === 0) return true;
    return this.groupOf(a) === this.groupOf(b);
  }

  plan(from: NodeId, to: NodeId, rng: Rng): DeliveryPlan {
    if (!this.canReach(from, to)) return { delays: [], dropped: 'partition' };
    if (rng.chance(this.config.loss)) return { delays: [], dropped: 'loss' };
    const delays = [this.delay(from, to, rng)];
    if (rng.chance(this.config.duplication)) delays.push(this.delay(from, to, rng));
    return { delays };
  }

  private delay(from: NodeId, to: NodeId, rng: Rng): number {
    const { latencyMean, latencyJitter, reorder } = this.config;
    let ms = latencyMean + (rng.next() * 2 - 1) * latencyJitter;
    if (rng.chance(reorder)) ms += rng.next() * 3 * latencyMean;
    ms *= Math.max(this.slow.get(from) ?? 1, this.slow.get(to) ?? 1);
    return Math.max(1, Math.round(ms));
  }

  private groupOf(id: NodeId): number {
    return this.partitions.findIndex((g) => g.includes(id));
  }
}
