import type { NodeId } from '../engine/types.ts';
import type { SwimConfig, SwimMsg } from '../swim/node.ts';
import type { VClock, Version } from './vclock.ts';

/** Toggles are 0 or 1 so every setting can be changed by a numeric config input. */
export interface StoreConfig {
  /** Replicas per key. */
  n: number;
  /** Replies needed before a read succeeds. */
  r: number;
  /** Acks needed before a write succeeds. */
  w: number;
  /** Tokens per physical node on the ring. */
  vnodes: number;
  /** 1: stand-ins replace owners believed dead. 0: only the N owners count. */
  sloppy: number;
  /** How long a coordinator waits for its quorum. */
  requestTimeout: number;
  /** 1: stand-ins hand hinted writes back when the owner returns. */
  hintedHandoff: number;
  hintInterval: number;
  hintTtl: number;
  /** 1: after a read, push the merged result to replicas that were behind. */
  readRepair: number;
  /** Period of Merkle anti-entropy rounds; 0 turns it off. */
  antiEntropyInterval: number;
  /** ms of work per replica read or write. Each node does one at a time, so load causes queueing. 0: instant. */
  serviceTime: number;

  // --- improvements over classic request handling; 0 is off ---

  /**
   * 1: reads go to just R replicas, and another is asked only if those are
   * slower than usual; clients hedge reads to a second coordinator the same way.
   */
  hedge: number;
  /** 1: prefer the replicas and coordinators that have answered fastest lately. */
  smartRouting: number;
  /** Avoid reading from a node carrying more than this multiple of the average load, e.g. 1.25. */
  loadCap: number;
  /** 1: a key read more than hotThreshold times a second gets temporary extra read replicas. */
  hotKeys: number;
  hotThreshold: number;
  /** Most extra replicas a hot key may get; it gets as many as its traffic needs, on the next nodes round the ring. */
  hotExtra: number;
}

export const defaultStoreConfig: StoreConfig = {
  n: 3,
  r: 2,
  w: 2,
  vnodes: 16,
  sloppy: 1,
  requestTimeout: 500,
  hintedHandoff: 1,
  hintInterval: 1000,
  hintTtl: 60_000,
  readRepair: 1,
  antiEntropyInterval: 5000,
  serviceTime: 0,
  hedge: 0,
  smartRouting: 0,
  loadCap: 0,
  hotKeys: 0,
  hotThreshold: 20,
  hotExtra: 16,
};

/** The request-handling improvements switched on together. */
export const improvedRouting = { hedge: 1, smartRouting: 1, loadCap: 1.25, hotKeys: 1 } as const;

export interface WorkloadConfig {
  /** Requests per second issued by each client; 0 stops the workload. */
  rate: number;
  /** Fraction of requests that are reads, 0..1. */
  readRatio: number;
  /** Size of the keyspace. */
  keys: number;
  /** Zipf exponent for key popularity; 0 is uniform. */
  zipf: number;
  /** Fraction of requests aimed at the single key `k0`: a key going viral. */
  hotShare: number;
}

export const defaultWorkload: WorkloadConfig = {
  rate: 2,
  readRatio: 0.5,
  keys: 24,
  zipf: 0,
  hotShare: 0,
};

export type ClusterConfig = SwimConfig & StoreConfig & WorkloadConfig;

export type StoreMsg =
  // client <-> coordinator
  | { type: 'get'; id: string; key: string }
  | { type: 'put'; id: string; key: string; value: string; context: VClock }
  | { type: 'get-res'; id: string; ok: boolean; versions: Version[] }
  | { type: 'put-res'; id: string; ok: boolean; clock: VClock }
  // coordinator <-> replica
  | { type: 'store'; rid: number; key: string; version: Version; hintFor?: NodeId }
  | { type: 'store-ack'; rid: number; load: number }
  | { type: 'fetch'; rid: number; key: string }
  | { type: 'fetch-res'; rid: number; versions: Version[]; load: number; /** Extra read replicas this key has right now; 0 when not hot. */ hot: number }
  // hot keys: an owner lends a copy to an extra read replica
  | { type: 'hot-add'; key: string; versions: Version[]; extras: number }
  | { type: 'repair'; key: string; versions: Version[] }
  // hinted handoff
  | { type: 'handoff'; hid: number; entries: [string, Version[]][] }
  | { type: 'handoff-ack'; hid: number }
  // Merkle anti-entropy
  | { type: 'ae-check'; level: number; nodes: [number, number][] }
  | { type: 'ae-sync'; buckets: number[]; entries: [string, Version[]][]; reply: boolean };

export type Msg = SwimMsg | StoreMsg;

/** Payload of a `request` input sent to a client node. */
export interface ClientRequest {
  op: 'get' | 'put';
  key: string;
  value?: string;
  /** Write without the context from earlier reads, as a client that never read would. */
  blind?: boolean;
  /** Coordinator to use; a random healthy-looking node when omitted. */
  via?: NodeId;
}

const swimTypes = new Set(['ping', 'ack', 'ping-req', 'join', 'join-ack']);

export function isSwimMsg(msg: Msg): msg is SwimMsg {
  return swimTypes.has(msg.type);
}
