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
};

export interface WorkloadConfig {
  /** Requests per second issued by each client; 0 stops the workload. */
  rate: number;
  /** Fraction of requests that are reads, 0..1. */
  readRatio: number;
  /** Size of the keyspace. */
  keys: number;
  /** Zipf exponent for key popularity; 0 is uniform. */
  zipf: number;
}

export const defaultWorkload: WorkloadConfig = {
  rate: 2,
  readRatio: 0.5,
  keys: 24,
  zipf: 0,
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
  | { type: 'store-ack'; rid: number }
  | { type: 'fetch'; rid: number; key: string }
  | { type: 'fetch-res'; rid: number; versions: Version[] }
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
