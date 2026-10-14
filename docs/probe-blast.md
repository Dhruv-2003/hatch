# Probe: Blast mainnet (live, 2026-10-14)

Ran `bun src/probe.ts blast-mainnet` against Blast's documented portal address; every value
below was read on-chain from Ethereum mainnet. Raw output: `chains/blast-mainnet.probe.json`.

## Verdict

**Class A — L2OutputOracle, permissioned proposer.** Portal `version() == "1.10.0"`,
portal's `l2Oracle()` → `0x826D1B0D4111Ad9146Eb8941D7Ca2B6a44215c76`, `disputeGameFactory()`
reverts (no DGF surface). Matches the `op-contracts/v1.1.0` source snapshot identified in
[research-blast.md](research-blast.md). Oracle `version() == "1.6.0"`.

## The numbers that matter

| Fact | Value | Implication |
|---|---|---|
| `FINALIZATION_PERIOD_SECONDS` | **86,400 (1 day)** | Not 7 or 12 days. L2Beat's "12→7 days" note describes an older oracle implementation; the live proxy reports 1 day. Always read it live. |
| Proposer | `0x082b616Ec99167B2FEdee053F07db6795D4dA821` | Single whitelisted EOA/multisig — the chain's exit clock is this address's heartbeat. |
| Challenger | `0x4f72ee94B8ba3Be7F886565d3583A7F636c58B05` | The 3/5 Blast multisig (also SystemConfig owner). |
| L2 block time | 2s | |
| Latest root | index 23090, covers L2 block 41,563,800, posted at L1 ts 1791939779 | **33 minutes old at probe time — proposer alive.** |
| Posting cadence | avg ~59 min, max ~70 min (5 roots sampled) | "Alive" = a root within ~2h; anything longer is a red flag worth surfacing. |
| Root lag vs head | ~2,148 L2 blocks (~72 min) | A withdrawal initiated now is provable in ≤ ~2 root cycles (~2h). |
| L2 chain | id 81457, head advancing, 0s stale | Chain fully live at probe time. |
| Announced UI deadline | **2026-10-26** (reported; verify primary source) | 12 days of margin. Real escape needs ~2 days (initiate → root covers it → prove → wait 1 day → finalize). |

## What this means for a user (planner preview)

Window arithmetic at probe time: initiate on L2 now → next root covering your block lands
within ~2h → prove on L1 → wait 86,400s → finalize. Total ≈ 27–30h, all doable days before
the announced deadline — but only while the proposer keeps posting. **Once proven, finalize
needs no further proposer activity (pure timestamp check).** The plan output should say:
"The deadline that matters is the last root. Prove before it. Finalize whenever."

## Deltas vs the literature (probe > docs)

1. Finalization period is 1 day, not 7 (L2Beat stale or describing the pre-upgrade impl).
2. `depositTransaction()` blacklist (L2Beat): not yet bytecode-verified on-chain — planner
   must check before emitting P2 forced-initiation calldata.
3. Custom bridge liquidity/yield (`ETHYieldManager`, `WithdrawalQueue` per verified portal
   source on Etherscan): finalize moves the message, but ETH payout shape flows through the
   yield machinery — scan both `L1BlastBridge` and `L1StandardBridge` events.

## Bonus finding: Blast Sepolia is a winding-down chain *right now*

`chains/blast-sepolia.probe.json`: same class A stack, but last root was **179.7h old**
(~7.5 days) and its L2 head was **~12h stale** — proposer and sequencer both stopped. This
is a live specimen of exactly what hatch exists for; use it in the demo as "what a chain
looks like when the window is already closing" (P1/P2 territory, no new initiations).

## Open items

- Verify the Oct 26 announced deadline from a primary Blast source.
- Bytecode check of the portal blacklist before any P2 output.
- Read `ETHYieldManager`/`WithdrawalQueue` flow to describe what "finalized" pays out.
