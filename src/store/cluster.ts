import type { NetworkConfig } from '../engine/network.ts';
import { Simulator, type SimOptions } from '../engine/simulator.ts';
import type { NodeId } from '../engine/types.ts';
import { defaultSwimConfig } from '../swim/node.ts';
import { ClientNode } from './client.ts';
import { defaultStoreConfig, defaultWorkload, type ClusterConfig, type Msg } from './messages.ts';
import { StoreNode } from './node.ts';

export interface StoreClusterOptions {
  seed: number;
  /** Number of store nodes, named n0..n(size-1). */
  size: number;
  /** Number of client nodes, named c0..; default 2. */
  clients?: number;
  config?: Partial<ClusterConfig>;
  network?: Partial<NetworkConfig>;
  logLimit?: number;
}

export type StoreSim = Simulator<Msg, ClusterConfig>;

export const defaultClusterConfig: ClusterConfig = { ...defaultSwimConfig, ...defaultStoreConfig, ...defaultWorkload };

export const isClient = (id: NodeId) => id.startsWith('c');

export function storeClusterOptions(o: StoreClusterOptions): SimOptions<Msg, ClusterConfig> {
  const stores: NodeId[] = Array.from({ length: o.size }, (_, i) => `n${i}`);
  const clients: NodeId[] = Array.from({ length: o.clients ?? 2 }, (_, i) => `c${i}`);
  const seeds = stores.slice(0, 1);
  return {
    seed: o.seed,
    nodes: [...stores, ...clients],
    config: { ...defaultClusterConfig, ...o.config },
    network: o.network,
    logLimit: o.logLimit,
    createNode: (id, cfg, prev) =>
      isClient(id) ? new ClientNode(id, cfg, stores) : new StoreNode(id, cfg, seeds, stores, prev as StoreNode | undefined),
  };
}

export function createStoreCluster(o: StoreClusterOptions): StoreSim {
  return new Simulator(storeClusterOptions(o));
}
