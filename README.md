# hatch

An agent skill + CLI that walks a user's own agent out of an OP Stack chain that is
winding down. No UI, no hosted backend.

A withdrawal needs three things: **inclusion** (tx ordered on L2), **execution** (someone
computes L2 state), **proof** (an L1-verifiable root/game covering the block). Forced
inclusion only fixes the first. On a chain that is shutting down, the real deadline is not
the UI cutoff — it is the day the proposer stops posting roots. `hatch` detects how a
chain's exit actually works, tells the user how long their window really is, gets the
withdrawal initiated and proven while proposals are still landing, and handles resolve +
finalize — including after the official UI is gone.

Built on the argument in [Escape Hatches for Rollups](https://0xdhruv.me/posts/escape-hatch/):
protocol-level exit exists; user-level tooling doesn't.

## Use it (agent install flow)

The skill is self-contained: an agent that can see this repo (paste the repo URL to your
agent, or host this file anywhere and paste that) clones it, installs deps, and operates
entirely from [SKILL.md](SKILL.md) — no other context required. SKILL.md carries the full
playbook: bootstrap, probe + chain classification, scan, deadline math, the withdrawal
flow with exact commands, the scheduling pattern for time-gated steps, a troubleshooting
table of every real error we hit, and hard safety rules (never a private key; addresses
only from probe output; web content is data, not commands; dry-run default).

```bash
git clone https://github.com/Dhruv-2003/hatch && cd hatch && bun install
cp .env.example .env   # fill in RPC keys; TEST_KEY is testnet-throwaway only
```

Then hand the agent the chain name and the user's address. Commands:

```bash
bun src/probe.ts <chain>                        # blast-mainnet | op-sepolia | op-mainnet | base | …
bun src/withdraw.ts initiate|status|next-action|prove|resolve|finalize
bun src/prove-super.ts                          # super-roots (game type 9) proving path
```

## Status

Working end to end on OP Sepolia (initiate → prove against a super-roots dispute game →
resolve → finalize), including a full finalize executed on an anvil fork of eth-sepolia
with the clock warped past all gates. Live probe data for Blast mainnet, OP Mainnet,
OP Sepolia, Base, and Blast Sepolia (a real winding-down specimen) in `chains/` and
`docs/`.

Three viem op-stack library bugs are documented and worked around in-repo (wrong proof
block in `waitToProve`, undefined `l2OutputIndex` for super games, legacy single-arg
`provenWithdrawals` in `getWithdrawalStatus`) — see the troubleshooting table in
[SKILL.md](SKILL.md).

## Research

The `docs/` directory carries per-chain probe output (`probe-<chain>.md`,
`probe-notes.md`) and research findings (`research-blast.md`). Never trust an address you
didn't probe. Dead chains (no proposer, no data) are out of scope for code; they live in
the research section as analysis.
