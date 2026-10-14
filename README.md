# hatch

An agent skill + CLI that walks a user's own agent out of an OP Stack chain that is
winding down. No UI, no hosted backend.

A withdrawal needs three things: **inclusion** (tx ordered on L2), **execution** (someone
computes L2 state), **proof** (an L1-verifiable root/game covering the block). Forced
inclusion only fixes the first. On a chain that is shutting down, the real deadline is not
the UI cutoff — it is the day the proposer stops posting roots. `hatch` detects how a
chain's exit actually works, tells the user how long their window really is, gets the
withdrawal initiated and proven while proposals are still landing, and handles finalize —
including after the official UI is gone.

Built on the argument in [Escape Hatches for Rollups](https://0xdhruv.me/posts/escape-hatch/):
protocol-level exit exists; user-level tooling doesn't.

## Status

Pre-code: research and planning. See [docs/research-blast.md](docs/research-blast.md) for
the phase 0 findings so far (Blast fork point identified: `version() 1.10.0` →
`op-contracts/v1.1.0` source snapshot, oracle-era withdrawal path, custom yield bridge).

## Plan

See the plan in the project thread. Short version:

1. Probe OP Sepolia, then read-only against Blast mainnet (+ Blast Sepolia if its proposer
   is alive — same oracle-era stack, would give us a same-stack end-to-end testnet).
2. Liveness monitor + `status`.
3. P0/P1 end to end on OP Sepolia (v7/DGF path) — shared by OP Mainnet and Base.
4. L1 scanner + planner.
5. SKILL.md, README research section, demo.
6. Stretch: P2 forced-initiation calldata (with the Blast `depositTransaction` blacklist
   caveat), chain registry.

Dead chains (no proposer, no data) are out of scope for code; they live in the research
section as analysis.

## Research

The `docs/` directory carries per-chain probe output (`probe-<chain>.md`) and the research
section will cover: the three-layer withdrawal model (inclusion/execution/proof), dead-chain
analysis, and per-stack notes. Never trust an address you didn't probe.
