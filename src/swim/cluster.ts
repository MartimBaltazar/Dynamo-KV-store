import type { NetworkConfig } from '../engine/network.ts';
import { Simulator, type SimOptions } from '../engine/simulator.ts';
import type { NodeId } from '../engine/types.ts';
import { defaultSwimConfig, SwimNode, type SwimConfig, type SwimMsg } from './node.ts';

export interface ClusterOptions {
  seed: number;
  size: number;
  swim?: Partial<SwimConfig>;
  network?: Partial<NetworkConfig>;
  logLimit?: number;
}

export type SwimSim = Simulator<SwimMsg, SwimConfig>;

/** Simulator options for a SWIM cluster of n0..n(size-1), all joining through n0. */
export function clusterOptions(o: ClusterOptions): SimOptions<SwimMsg, SwimConfig> {
  const nodes: NodeId[] = Array.from({ length: o.size }, (_, i) => `n${i}`);
  const seeds = nodes.slice(0, 1);
  return {
    seed: o.seed,
    nodes,
    config: { ...defaultSwimConfig, ...o.swim },
    network: o.network,
    logLimit: o.logLimit,
    createNode: (id, cfg, prev) => new SwimNode(id, cfg, seeds, prev as SwimNode | undefined),
  };
}

export function createCluster(o: ClusterOptions): SwimSim {
  return new Simulator(clusterOptions(o));
}
