# Dynamo-KV-store

A Dynamo-style distributed key-value store in TypeScript, with a deterministic simulator and a browser UI to
watch it and break it. Two measured improvements over classic Dynamo: failure detection, and latency and
hot keys.

**Paper:** [`paper/main.tex`](paper/main.tex), an extended abstract (ACM `acmart` format; upload `paper/` to
Overleaf to build it).

## What is in it

Classic Dynamo: consistent-hash ring with virtual nodes, tunable N/R/W quorums (sloppy or strict), vector
clocks with siblings, hinted handoff, read repair, Merkle anti-entropy, SWIM membership.

Improvements, each compared classic vs improved on identical seeds and faults:

- **Failure detection:** agreement-based suspicion and phi-accrual ping timeouts.
- **Latency and hot keys:** hedged reads, latency-aware routing, a load cap, extra replicas for hot keys.

## Run it

Requires Node 22.18 or newer.

```sh
npm install        # only for the browser UI (Vite)
npm run dev        # open the simulator
npm test           # plain Node, no dependencies
npm run typecheck
npm run experiment             # failure detection, 20 seeds
npm run experiment -- latency  # latency and load, 10 seeds (about 5 minutes)
# add --write to save the report under experiments/
```

## Simulator

- **Watch:** nodes on the outer circle, coloured by what the cluster believes (green alive, amber doubted,
  red called dead; dashed means actually down). Keys on the inner circle.
- **Modes:** Classic Dynamo or Improved.
- **Break things:** kill, restart, slow down or isolate nodes; set packet loss.
- **Tune:** N, R, W; repair switches under Settings.
- **Inspect:** tap a key to see its owners and what each holds.
- **Seven metrics:** success rate, slowest 1% latency, stale reads, keys whose copies disagree, busiest node
  vs average, time to notice a failure, healthy nodes called dead.

## Design

The engine is pure and deterministic: virtual clock, `(time, seq)` event queue, seeded RNG. Protocol code
has no sockets, wall clock or `Math.random`. Faults (latency, loss, partitions, slow nodes) live in the
network, never in nodes. Every outside action is a timestamped input, so seed plus script reproduces a run
byte for byte.

| Path | Contents |
| --- | --- |
| `src/engine/` | Clock, event queue, RNG, simulated network |
| `src/swim/` | Member table, gossip, SWIM node, phi-accrual |
| `src/ring/` | Hash, ring, preference lists |
| `src/store/` | Vector clocks, coordinator, hints, Merkle trees, store node, clients |
| `src/ui/` | TypeScript + SVG, rendered from the event stream |
| `tests/` | Unit and scenario tests (80) |

Notes:

- Ring membership is explicit. SWIM only decides which replicas to route around; it never changes ownership.
- Any node can coordinate. Vector clocks use coordinator ids as actors.
- Merkle anti-entropy compares, per pair of nodes, a 32-leaf tree over the keys both own.
- Known classic limitation, kept in the baseline: blind writes through the same coordinator do not become
  siblings; the later write wins.

## Results

Failure detection (20 nodes, 20 seeds; [`experiments/failure-detection.md`](experiments/failure-detection.md)):

| Test | Classic | Improved |
| --- | --- | --- |
| False death verdicts, 20% loss | 77.7 | 0.3 |
| One node 10x slower: times declared dead | 8.8 | 0 |
| Detect a real death, clean network | 7.05 s | 7.50 s |
| Same, 300 ms mean latency | 5.38 s | 7.72 s |

Latency and hot keys (10 nodes, 10 seeds; [`experiments/latency-and-load.md`](experiments/latency-and-load.md)):

| Test | Classic | Improved |
| --- | --- | --- |
| One node 10x slower: p99 | 1338 ms | 210 ms |
| One key takes half the traffic: busiest vs average | 2.25x | 1.16x |
| Normal load: messages sent | 134.6k | 102.2k |
| Normal load: p50 / p99 | 165 / 200 ms | 170 / 208 ms |

Costs, as measured:

- Phi-accrual slows detection under high latency (about 2 s at 300 ms). Nearly all false-verdict reduction
  comes from agreement-based suspicion.
- Self-doubt was built and gave no benefit, so it is off by default.
- Improved routing is 5 to 8 ms slower when nothing is wrong.
- Hedging alone barely helps and worsens hot keys; latency-aware choice and hot-key replicas do the work.
- Thresholds were tuned on these same tests.
