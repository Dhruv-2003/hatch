# Probe notes: demo chains (live, 2026-10-14)

Raw outputs in `chains/*.probe.json`. All values read on-chain; starting portal addresses
from the superchain registry / chain docs, then verified by reading.

## OP Sepolia (11155420) — the end-to-end testbed, class B/C

- Portal `0x16Fc5058F25648194471939df75CF27A2fdC48BC`, `version() = 5.8.0`
- No oracle; `disputeGameFactory() = 0x05F9613aDB30026FFd634f38e5C4dFd30a197Fa1`
- `respectedGameType = 9`, impl `0x19AF533Cc2A2A55786DCB8672aA5717e64213208` (same impl on
  OP Mainnet — identify this game type's permissioned-ness during planner work)
- `proofMaturityDelaySeconds = 604800` (7 days)
- `superchainConfig.paused = false`; L2 alive (block 0s stale)
- Liveness: latest respected-type game 7 min old → healthy
- SystemConfig `4.0.0`, owner `0xDEe57160aAfCF04c34C887B5962D0a69676d3C8B`

## OP Mainnet (10) — class B/C, same shape as OP Sepolia

- Portal `0xbEb5Fc579115071764c7423A4f12eDde41f106Ed`, `version() = 5.8.0`
- DGF `0xe5965Ab5962eDc7477C8520243A95517CD252fA9`, respected type 9, same impl as Sepolia
- proofMaturity 604800s; not paused; latest game 19 min old → healthy

## Base (8453) — class B/C with a validity-proof twist

- Portal `0x49048044D57e1C92A77f79988d21Fa8fAF74E97e`, `version() = 6.0.1` (ahead of OP)
- DGF `0x43edB88C4B80fDD2AdFF2412A7BebF9dF42cB40e`; `respectedGameType = 621`, impl =
  `0xeF9eCeA15265321753047EBF7D54C858D53cB94f` = Base's **AggregateVerifier** (Base's docs
  also list TEEVerifier, ZkVerifier, RiscZero contracts) — a validity/TEE-proved game class,
  *not* classic optimistic fraud games
- `proofMaturityDelaySeconds = 86400` (1 day — withdrawals mature much faster than OP's 7)
- Not paused; latest game **12 seconds** old → healthy
- Planner note: treat as its own subclass; prove flow may differ (verifier-gated games).
  This is the "modularity" showcase: same hatch, three different verdicts.

## Blast Sepolia (168587773) — the winding-down specimen

- Portal `0x2757E4430e694F27b73EC9C02257cab3a498C8C5`, version 1.10.0, oracle 1.6.0
- `FINALIZATION_PERIOD_SECONDS = 12` (testnet default)
- Last root **179.7h old** (~7.5 days) after an ~51-min cadence; L2 head ~12h stale
- Read: proposer and sequencer both stopped. Class A with a dead proposer = provable only
  for blocks already covered by old roots; nothing new can be proven. Demo uses this to
  show the status screen that says "window closed for new withdrawals; existing proven
  withdrawals can still finalize."

## Probe mechanics learned (feed into the real liveness-monitor)

- Alchemy free tier: `eth_getLogs` limited to 10-block ranges — the L1 scanner must chunk,
  or use archive-free state reads where possible.
- `DisputeGameFactory.findLatestGames` returns `GameSearchResult { index, metadata(GameId
  bytes32), timestamp, rootClaim, extraData }` — game proxy address is the low 20 bytes of
  `metadata`; the search walks the global list backwards and filters by type.
- Older oracle-era contracts answer cleanly to `l2Oracle()`; DGF-era portals revert on it —
  that's a clean branch condition alongside `version()`.
