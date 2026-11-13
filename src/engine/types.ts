import type { Rng } from './rng.ts';
import type { NetworkConfig } from './network.ts';

export type NodeId = string;

/** Every protocol message carries a `type` tag; the engine logs it and nothing else. */
export interface Message {
  type: string;
}

/** Everything a node may touch. No wall clock, no sockets, no Math.random. */
export interface Ctx<M extends Message> {
  readonly self: NodeId;
  readonly now: number;
  readonly rng: Rng;
  send(to: NodeId, msg: M): void;
  /** Fires `onTimer(tag)` after `delay` ms, unless the node is killed first. */
  setTimer(delay: number, tag: string): void;
  /** Appends a protocol-level state change to the event log. */
  emit(kind: string, data: unknown): void;
}

export interface SimNode<M extends Message> {
  onStart(ctx: Ctx<M>): void;
  onMessage(from: NodeId, msg: M, ctx: Ctx<M>): void;
  onTimer(tag: string, ctx: Ctx<M>): void;
}

/**
 * Everything the outside world can do to a running simulation. Inputs are
 * recorded with their timestamp, so seed + input script reproduces a run.
 */
export type Input =
  | { type: 'kill'; node: NodeId }
  | { type: 'restart'; node: NodeId }
  | { type: 'addNode'; node: NodeId }
  | { type: 'partition'; groups: NodeId[][] }
  | { type: 'heal' }
  | { type: 'slow'; node: NodeId; factor: number }
  | { type: 'network'; patch: Partial<NetworkConfig> }
  | { type: 'config'; patch: Record<string, number> };

export interface ScriptedInput {
  t: number;
  input: Input;
}

export type DropReason = 'loss' | 'partition' | 'down';

/** Append-only event log entry. Plain JSON, so logs can be compared, saved and replayed. */
export type SimEvent =
  | { t: number; type: 'send'; id: number; from: NodeId; to: NodeId; kind: string; arrive: number }
  | { t: number; type: 'drop'; id: number; from: NodeId; to: NodeId; kind: string; reason: DropReason }
  | { t: number; type: 'deliver'; id: number; from: NodeId; to: NodeId; kind: string }
  | { t: number; type: 'up'; node: NodeId }
  | { t: number; type: 'down'; node: NodeId }
  | { t: number; type: 'state'; node: NodeId; kind: string; data: unknown }
  | { t: number; type: 'input'; input: Input };
