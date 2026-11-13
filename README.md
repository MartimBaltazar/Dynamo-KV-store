# Dynamo-KV-store

A learning project: a Dynamo-style distributed key-value store and a browser simulator in which every
mechanism can be watched in real time and every parameter tuned.

**Status: classic Dynamo is complete.** The simulator runs a full Dynamo-style store: SWIM membership, a
consistent-hash ring with virtual nodes, tunable R/W quorums (sloppy or strict), vector clocks with siblings,
hinted handoff, read repair and Merkle anti-entropy. Next: two measured improvements over this baseline
(smarter failure detection; latency and hot-key handling).

## Run it

Requires Node 22.18 or newer.

```sh
npm install        # only needed for the browser UI (Vite)
npm run dev        # open the simulator
npm test           # runs on plain Node, no dependencies needed
npm run typecheck
```

## What you can do in the simulator

- Watch gossip, client requests, replica reads and writes, read repair, hint handoff and anti-entropy fly
  between nodes, each in its own color.
- Click nodes or clients to select them, then kill, restart, slow down or isolate them behind a partition.
- Click a key on the inner ring to see its owners and exactly what each one holds, siblings and vector
  clocks included. Issue a get, a put, or two concurrent puts.
- Select two nodes to see their Merkle trees compared level by level.
- Tune everything live: N, R, W, sloppy quorum, hinted handoff, read repair, anti-entropy interval, virtual
  nodes, the workload (rate, read ratio, keyspace, zipf skew), all SWIM timings and all network faults.
- Read the metrics: availability, latency percentiles, stale reads, sibling reads, divergent keys, hints,
  repairs, failure-detection time, convergence time, false positives.

Experiments worth trying:

| Try this | You should see |
| --- | --- |
| R=1, W=1, then isolate half the nodes with one client | Stale reads climb |
| Same partition with R=2, W=2 and sloppy quorum off | Errors on the minority side, zero stale reads |
| Kill a node with sloppy quorum on | Hint counts appear beside stand-ins; restart the node and they drain |
| Read repair, hinted handoff and anti-entropy all off, kill and restart a node | Keys stay orange forever |
| Turn anti-entropy back on | Orange keys heal with no reads at all |
| "Concurrent puts" on a key | The key turns purple (siblings); a normal put resolves it |
| Loss at 40% | Live nodes get suspected and refute with a higher incarnation |

## Architecture

The engine is pure and deterministic. Protocol code has no sockets, no wall clock and no `Math.random`.

| Path | What it is |
| --- | --- |
| `src/engine/` | Virtual clock, `(time, seq)` event queue, seeded RNG, simulated network, event log |
| `src/swim/` | Member table, piggyback dissemination, the SWIM node, metrics derived from the log |
| `src/ring/` | 32-bit hash, consistent-hash ring with virtual nodes, preference lists |
| `src/store/` | Vector clocks, replica storage, coordinator, hints, Merkle trees, store node, clients, metrics |
| `src/ui/` | Plain TypeScript + SVG. Renders from the event stream; the engine has no DOM dependency |
| `tests/` | Unit and scenario tests mirroring `src/` |

- **Nodes** implement `onStart`, `onMessage` and `onTimer` and only touch the world through a context
  (`now`, `send`, `setTimer`, `rng`, `emit`).
- **Faults live in the network**, never in nodes: latency, loss, duplication, reordering, partitions, slow
  nodes.
- **Clients are simulated nodes too.** They reach the cluster over the same faulty network, remember the
  context of what they last read, and generate the workload from the seeded RNG.
- **Every outside action is a timestamped input** (kill, restart, partition, config change, manual request). Seed plus input
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

## Store specifics

- **Ring membership is explicit.** SWIM declaring a node dead never changes key ownership; it only makes
  coordinators route around that node.
- **Any node can coordinate.** It sends to the key's N owners and answers the client after R replies or W
  acks. With sloppy quorum on, owners believed dead are replaced by the next healthy nodes on the ring.
- **Stand-ins keep hinted writes apart from their own data**, serve reads from them, and hand them back when
  the owner is alive again. Hints expire after a TTL.
- **Vector clocks are per key, with coordinator ids as actors.** Concurrent versions are kept as siblings and
  returned together; a write carrying the merged context replaces them.
- **Read repair** pushes the merged result to owners that answered a read with something older.
- **Merkle anti-entropy** compares, per pair of nodes, a 32-leaf hash tree over the keys both own. The two
  sides trade hashes level by level, descend only where they differ, and ship only the differing ranges.
- **A stale read** is a successful read that does not reflect a write acknowledged before the read began.

Known classic limitation, kept deliberately as part of the baseline: two clients that write the same key
through the same coordinator without reading in between do not become siblings; the later write silently
wins. Through different coordinators they do become siblings.

## Roadmap

Done: sim core, SWIM, hash ring, coordinator and quorums, vector clocks and siblings, hinted handoff, read
repair, Merkle anti-entropy.

Next, each measured against the classic baseline on identical seeds and faults:

1. Experiment runner: many seeds, classic vs improved, mean and spread.
2. Failure detection: phi-accrual scoring, self-doubt when a node is the slow one, suspicion that shortens
   as independent confirmations arrive.
3. Latency and hot keys: hedged requests, latency-aware replica choice, bounded-load placement, temporary
   extra replicas for hot keys.
4. Scenario presets, export and import of seed + config + fault script, time-travel scrubber.

Not done yet from the original plan: explicit ring join and leave at runtime (the ring is fixed at start).
