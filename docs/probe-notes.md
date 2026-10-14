# Probe notes: demo chains (live, 2026-10-14)

Raw outputs in `chains/*.probe.json`. All values read on-chain; starting portal addresses
from the superchain registry / chain docs, then verified by reading.

## OP Sepolia (11155420) — the end-to-end testbed, class B/C

- Portal `0x16Fc5058F25648194471939df75CF27A2fdC48BC`, `version() = 5.8.0`
- No oracle; `disputeGameFactory() = 0x05F9613aDB30026FFd634f38e5C4dFd30a197Fa1`
- `respectedGameType = 9`, impl `0x19AF533Cc2A2A55786DCB8672aA5717e64213208` — game type 9
  is a **SuperFaultDisputeGame** (super roots, the interop-era proof system)
- `proofMaturityDelaySeconds = 604800` (7 days)
- `superchainConfig.paused = false`; L2 alive (block 0s stale)
- Liveness: latest respected-type game minutes old → healthy (super games post ~every 15 min)

### The super-roots proving saga (2026-10-14, solved live)

Proving a fresh withdrawal on today's OP Sepolia fails with viem's stock flow:

1. `waitToProve` accepts a game whose `l2BlockNumber` is **a timestamp, not a block
   number** (super games changed the field's meaning); the numeric `>=` coverage check
   passes by accident, and the proof gets built against an L2 block from hours before the
   withdrawal existed → on-chain revert `MerkleTrie: ran out of proof elements`.
2. `buildProveWithdrawal` returns `l2OutputIndex: undefined` for these games.

What actually works (`src/prove-super.ts`, proven on-chain, prove tx `0x941dac4e…`):

- The **super root preimage rides in the game's `extraData`**:
  `0x01 ‖ uint64 checkpointTs ‖ uint256 chainId ‖ bytes32 perChainOutputRoot` (repeating
  per chain, sorted by chain id), and `keccak256(extraData) == game.rootClaim()`.
- `rootClaimByChainId(chainId)` returns that chain's **Output V0 root**, whose digest is
  `keccak256(abi.encode(bytes32(0), stateRoot, messagePasserStorageRoot, latestBlockhash))`
  — note the portal's `OutputRootProof` struct field order is `(version, stateRoot,
  messagePasserStorageRoot, latestBlockhash)`; block hash is **last**.
- The covered L2 block is the block at the **checkpoint timestamp from extraData** (±0
  blocks — timestamps are exact), not the game creation time, and not the timestamp in
  `l2BlockNumber()`.
- Coverage test: covered block number ≥ withdrawal's L2 block, then `eth_getProof` for
  `keccak256(withdrawalHash ‖ 0x0)` on the message passer **at the covered block**, with
  viem's branch-node fix (`maybeAddProofNode`).
- Simulate before sending; the failing path reverts with
  `MerkleTrie: ran out of proof elements`, the correct one passes.

Lesson for the skill: **every withdrawal step must re-derive the proof system from
on-chain data** — a chain can change proof systems (Bedrock → fault proofs → super roots)
while a user is mid-exit, and library code lags. That's the strongest argument for the
agent-in-the-loop design: hatch's fix shipped in minutes; a static tool would still be
reverting.

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
