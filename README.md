# Dynamo-KV-store

A learning project: a Dynamo-style distributed key-value store and a browser simulator in which every
mechanism can be watched in real time and every parameter tuned.

**Status: v1.** The deterministic simulation core and SWIM gossip membership are done, with a live
visualizer. The storage layers (hash ring, quorums, vector clocks, hinted handoff, Merkle anti-entropy) are
next.

## Run it

Requires Node 22.18 or newer.

```sh
npm install        # only needed for the browser UI (Vite)
npm run dev        # open the simulator
npm test           # runs on plain Node, no dependencies needed
npm run typecheck
```

## What you can do in the simulator

- Watch pings, acks, indirect ping-reqs and joins fly between nodes.
- Click nodes to select them, then kill, restart, slow down or isolate them behind a partition.
- Tune the protocol period, ping timeout, indirect probe count `k`, suspect timeout, piggyback size and
  retransmit multiplier, plus network latency, loss, duplication and reordering. All changes apply live.
- Read the halo around each node: it is a mini-map of the ring, and the segment pointing toward a peer shows
  what that peer believes about this node (alive, suspect, dead, unknown).
- Read failure-detection time, convergence time and false-positive counts in the metrics panel.

Experiments worth trying: raise loss to 40% and watch live nodes get suspected and refute with a higher
incarnation; set `k` to 0 and see how much worse that gets; raise the suspect timeout and compare detection
time; isolate three nodes, wait, then heal.

## Architecture

The engine is pure and deterministic. Protocol code has no sockets, no wall clock and no `Math.random`.

| Path | What it is |
| --- | --- |
| `src/engine/` | Virtual clock, `(time, seq)` event queue, seeded RNG, simulated network, event log |
| `src/swim/` | Member table, piggyback dissemination, the SWIM node, metrics derived from the log |
| `src/ui/` | Plain TypeScript + SVG. Renders from the event stream; the engine has no DOM dependency |
| `tests/` | Unit and scenario tests mirroring `src/` |

- **Nodes** implement `onStart`, `onMessage` and `onTimer` and only touch the world through a context
  (`now`, `send`, `setTimer`, `rng`, `emit`).
- **Faults live in the network**, never in nodes: latency, loss, duplication, reordering, partitions, slow
  nodes.
- **Every outside action is a timestamped input** (kill, restart, partition, config change). Seed plus input
  script reproduces a run byte for byte; `replay()` does exactly that and the tests assert it.

## SWIM specifics

- Each protocol period a node pings one member, chosen round-robin from a shuffled list.
- No ack within the ping timeout: it asks `k` others to probe indirectly. Still nothing by the end of the
  period: the member becomes suspect, and dead after the suspect timeout.
- A node that hears it is suspected or dead refutes by raising its incarnation number. A higher incarnation
  always wins; at equal incarnation the worse news wins.
- Membership updates ride piggyback on probe traffic, each sent about `multiplier x log2(N)` times.
- A restarted node keeps its incarnation (as if stored on disk) and rejoins with the next one.
- Nodes occasionally ping a member they believe dead, so the two sides of a healed partition find each other.

## Roadmap

1. ~~Sim core~~
2. ~~SWIM membership and gossip~~
3. Consistent-hash ring with virtual nodes. Ring membership changes only on explicit join or leave; SWIM
   only decides which replicas to skip.
4. Coordinator with tunable R/W quorums, sloppy vs strict.
5. Vector clocks and siblings.
6. Hinted handoff.
7. Read repair and Merkle anti-entropy.
8. Metrics strip, scenario presets, export and import of seed + config + fault script.
