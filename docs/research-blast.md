# Blast exit research (pre-probe findings)

Status: **literature research, unverified on-chain.** Every claim below gets confirmed by
`hatch init` against a live L1 RPC before we trust it. Sources: L2Beat
([l2beat.com/layer2s/projects/blast](https://l2beat.com/layer2s/projects/blast),
[Disco](https://disco.l2beat.com/ui/p/blast)), Blast contract docs
([metalayerlabs.mintlify.app/building/contracts](https://metalayerlabs.mintlify.app/building/contracts)),
and the [BLASTchain/blast spec repo](https://github.com/BLASTchain/blast/blob/master/specs/withdrawals.md).

## Fork point: version() 1.10.0 → tag `op-contracts/v1.1.0`

Blast mainnet `OptimismPortal.version()` and `SystemConfig.version()` both report `"1.10.0"`.
In the optimism monorepo that string appears in the source snapshot of tag
[`op-contracts/v1.1.0`](https://github.com/ethereum-optimism/optimism/tree/op-contracts/v1.1.0/packages/contracts-bedrock).
Gotchas confirmed against that tag:

- The release *notes* for v1.1.0 only shipped `ProtocolVersions`; thePortal/SystemConfig
  `1.10.0` strings live in the tagged source, not the release. Read the tag's source tree,
  not the release page.
- **Oracle era, no dispute games.** `OptimismPortal` stores an `L2OutputOracle` directly.
  Prove: `proveWithdrawalTransaction(tx, l2OutputIndex, outputRootProof, withdrawalProof)`.
  Finalize: `finalizeWithdrawalTransaction(tx)`.
- **Selector trap (highest-value research finding so far):** `proveWithdrawalTransaction`
  keeps the *same four-ABI-type signature* in the fault-proof `OptimismPortal2` — but
  argument 2 silently changes meaning from "L2 output index into the oracle" to "dispute
  game index into the DGF". Any version detection that branches on selectors alone will
  build a broken proof. `hatch` branches on `version()` strings and on which proof-source
  contract the portal actually links to.
- Legacy "security halves": finalization needs both (1) proved-at time +
  `FINALIZATION_PERIOD_SECONDS` elapsed and (2) the underlying output proposal timestamp +
  same period elapsed, root still matching. Effective earliest finalize ≈ output
  *submission* time + finalization period — the two clocks overlap, they don't stack.
- `finalizeWithdrawalTransaction` has no msg.sender restriction → **anyone can finalize for
  anyone** (confirm in tagged source during probe).
- Fault proofs arrive at `op-contracts/v1.4.0` (`OptimismPortal2 3.10.0`, oracle removed).
  OP Mainnet / Base / OP Sepolia are on the v7/DGF world — a different code path, shared by
  all three demo chains.

## Deployed addresses (Ethereum mainnet)

From Blast's docs, to be re-derived by the probe (docs are a convenience, never a source of truth):

| Contract | Address |
|---|---|
| OptimismPortal | `0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb` |
| L2OutputOracle (proxy) | `0x826D1B0D4111Ad9146Eb8941D7Ca2B6a44215c76` |
| L1CrossDomainMessenger | `0x5D4472f31Bd9385709ec61305AFc749F0fA8e9d0` |
| L1StandardBridge | `0x697402166Fbf2F22E970df8a6486Ef171dbfc524` |
| L1BlastBridge (custom) | `0x3a05E5d33d7Ab3864D53aaEc93c8301C1Fa49115` |
| L1ERC721Bridge | `0xa45A0c7C47DB8C6e99b2d7C4939F7f7Cf69C8975` |
| ETHYieldManager (custom) | `0x98078db053902644191f93988341E31289E1C8FE` |
| USDYieldManager (custom) | `0xa230285d5683C74935aD14c446e137c8c8828438` |

L2 side: standard predeploy addresses for messenger (`0x...0007`), standard bridge
(`0x...0010`), `L2ToL1MessagePasser` (`0x...0016`); Blast adds `L2BlastBridge` at
`0x4300000000000000000000000000000000000005` and native-yield `WETH` at `0x4300...0004`.

## How Blast differs from vanilla OP Stack (v1.1.0 era)

1. **Custom bridge pair.** `L1BlastBridge` / `L2BlastBridge` sit alongside (and for ETH/WETH
   supersede) the standard bridges, wired to `ETHYieldManager` / `USDYieldManager`. Bridged
   ETH is invested in yield providers (Lido, Maker DSR); yield flows back to L2. The scanner
   must listen to *both* bridges' initiation events, and the planner must warn that
   WETH-exit semantics differ from ETH-exit.
2. **Liquidity risk the standard stack doesn't have.** L2Beat flags: if the L1 bridge
   doesn't hold enough liquidity, withdrawals can sit in a queue or lose value if yield went
   negative. A finalized `finalizeWithdrawalTransaction` can still be the *end of the
   tunnel*, with the payout shaped by the yield managers. Probe what ETHYieldManager does on
   the withdrawal path before promising users "finalized = funds".
3. **Permissioned proposer, no challenger incentive structure.** Whitelisted proposer only.
   L2Beat's verdict is blunt: proposer failure ⇒ withdrawals frozen. This is exactly the
   class A risk hatch exists for.
4. **`FINALIZATION_PERIOD_SECONDS` = 7 days** (upgraded from 12 via a new oracle
   implementation). Verify on-chain, don't bake in.
5. **Instantly upgradable + pausable.** A 3/5 multisig (`0x4f72ee94B8ba3Be7F886565d3583A7F636c58B05`)
   can upgrade every core contract with no timelock and pause withdrawals via the portal.
   L2Beat: "no exit window". Hatch's liveness monitor should also watch for the withdrawals-
   paused flag, not just proposer silence.
6. **`depositTransaction()` blacklist.** Blast patched the portal to blacklist specific
   addresses (e.g. Munchables exploiter) from forced-initiation deposits. P2 forced-
   initiation calldata is therefore *not* universally viable on Blast — the planner must
   check the blacklist logic in the deployed portal bytecode before emitting P2 calldata.

## Classification (planner expectation, pending probe)

**Class A** — proof source `L2OutputOracle`, anyone can prove once a whitelisted proposer
posts a covering root. Compounded risks: permissioned proposer (single point of silence),
instant upgrades, withdrawal pause, bridge liquidity. Real deadline for a user = the last
L1-timestamp at which a root covering their withdrawal's L2 block is still landing, because
once **proven**, finalization only needs timestamps — no further proposer cooperation.
That asymmetry (prove early, finalize anytime) is the whole pitch of the liveness monitor.

## Open questions for the live probe

1. Portal + oracle `version()` on-chain (expect `1.10.0`); `l2Oracle` address inside the portal.
2. `FINALIZATION_PERIOD_SECONDS`, `PROPOSER`, `CHALLENGER`, latest output index/timestamp.
3. Does the deployed portal contain the blacklist modification? Which addresses/function guards?
4. What does `ETHYieldManager` do on withdrawal finalize — is ETH payout immediate from the
   bridge or routed through a yield-unwind?
5. Are Blast mainnet roots still being posted *now*, and how fresh is the latest one?
6. Is **Blast Sepolia** (portal `0x2757E4430e694F27b73EC9C02257cab3a498C8C5`, oracle
   `0x311fF72DfE214ADF97618DD2E731637E8F41bD8c`) still proposing? If yes, it becomes a
   same-stack end-to-end testnet for the oracle code path.
7. The announced shutdown/UI deadline (reported as Oct 26, 2026) — find the primary source
   and record it next to the proposer-liveness deadline in every plan output.
