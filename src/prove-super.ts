/**
 * Super-roots-aware withdrawal prover (OP Sepolia's current proof system).
 *
 * Why this exists: viem's waitToProve/buildProveWithdrawal mishandle super-root games —
 * `game.l2BlockNumber` now carries a *timestamp*, viem compares it against L2 block
 * numbers numerically, "covers" tests pass by accident, and the resulting proof is built
 * against an L2 block from hours before the withdrawal existed ("MerkleTrie: ran out of
 * proof elements"). This prover instead:
 *
 *   1. finds the newest type-9 (super) game and its per-chain root claim,
 *   2. finds the exact L2 block whose output digest matches that claim (search around
 *      the game's creation timestamp),
 *   3. verifies the block actually covers the withdrawal's L2 block,
 *   4. builds the storage proof from that block, simulates, then sends.
 *
 * Usage: bun src/prove-super.ts
 */
import { createPublicClient, createWalletClient, defineChain, http, keccak256, encodeAbiParameters, toRlp, fromRlp, toHex } from "viem";
import { optimismSepolia, sepolia } from "viem/chains";
import { publicActionsL1, publicActionsL2, walletActionsL1, getWithdrawals, getWithdrawalHashStorageSlot } from "viem/op-stack";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import type { Address, Hash } from "viem";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

const L1_RPC = `https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`;
const L2_RPC = `https://opt-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_PRIMARY")}`;
const PORTAL = "0x16Fc5058F25648194471939df75CF27A2fdC48BC";
const DGF = "0x05F9613aDB30026FFd634f38e5C4dFd30a197Fa1";
const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";
const OP_SEPOLIA_CHAIN_ID = 11155420;

const account = privateKeyToAccount(`0x${env("TEST_KEY").replace(/^0x/, "")}` as `0x${string}`);
const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) }).extend(publicActionsL1());
const l2 = createPublicClient({ chain: optimismSepolia, transport: http(L2_RPC) }).extend(publicActionsL2());
const walletL1 = createWalletClient({ chain: sepolia, transport: http(L1_RPC), account }).extend(walletActionsL1());

// ---- minimal ABIs (current on-chain shapes; viem's are stale here) ----
const DGF_ABI = [
  { name: "gameCount", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  {
    name: "findLatestGames",
    type: "function",
    stateMutability: "view",
    outputs: [{ type: "tuple[]", components: [{ type: "uint256" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes" }] }],
    inputs: [{ type: "uint32" }, { type: "uint256" }, { type: "uint256" }],
  },
] as const;

const GAME_ABI = [
  { name: "rootClaimByChainId", type: "function", stateMutability: "view", outputs: [{ type: "bytes32" }], inputs: [{ type: "uint256" }] },
] as const;

const PORTAL_SIM_ABI = [
  {
    name: "proveWithdrawalTransaction",
    type: "function",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      {
        type: "tuple",
        components: [
          { type: "uint256" }, { type: "address" }, { type: "address" },
          { type: "uint256" }, { type: "uint256" }, { type: "bytes" },
        ],
      },
      { type: "uint256" }, // dispute game index
      // OutputRootProof struct order: version, stateRoot, messagePasserStorageRoot, latestBlockhash
      {
        type: "tuple",
        components: [
          { name: "version", type: "bytes32" },
          { name: "stateRoot", type: "bytes32" },
          { name: "messagePasserStorageRoot", type: "bytes32" },
          { name: "latestBlockhash", type: "bytes32" },
        ],
      },
      { type: "bytes[]" }, // withdrawal proof
    ],
  },
] as const;

// ---- helpers ----

type Block = Awaited<ReturnType<typeof l2.getBlock>>;

async function blockAtOrBefore(ts: number): Promise<Block> {
  let lo = 1n;
  let hi = await l2.getBlockNumber();
  if ((await l2.getBlock({ blockNumber: lo })).timestamp > ts) throw new Error("chain genesis after target ts");
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await l2.getBlock({ blockNumber: mid })).timestamp <= ts) lo = mid;
    else hi = mid - 1n;
  }
  return l2.getBlock({ blockNumber: lo });
}

/** Output V0 digest: keccak(version, stateRoot, messagePasserStorageRoot, latestBlockhash) */
function digestV0(block: Block, messagePasserStorageRoot: Hash): Hash {
  const version = ("0x" + "0".repeat(64)) as Hash;
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [version, block.stateRoot, messagePasserStorageRoot, block.hash],
    ),
  );
}

async function messagePasserStorageRoot(blockNumber: bigint): Promise<Hash> {
  const proof = await l2.getProof({ address: MESSAGE_PASSER, storageKeys: [], blockNumber });
  return proof.storageHash;
}

/** Port of viem's maybeAddProofNode: branch nodes may embed the target leaf inside themselves. */
function maybeAddProofNode(key: string, proof: `0x${string}`[]): `0x${string}`[] {
  const lastProofRlp = proof[proof.length - 1];
  const lastProof = fromRlp(lastProofRlp);
  if (lastProof.length !== 17) return proof;
  const modifiedProof = [...proof];
  for (const item of lastProof) {
    if (!Array.isArray(item)) continue;
    const suffix = toHex(item as Uint8Array).slice(3);
    if (typeof suffix !== "string" || !key.endsWith(suffix)) continue;
    modifiedProof.push(toRlp(item as Uint8Array));
  }
  return modifiedProof;
}

async function main() {
  const states = JSON.parse(readFileSync("withdrawals.json", "utf8"));
  const id = Object.keys(states).pop()!;
  const state = states[id];
  if (!state.l2Tx) throw new Error("not initiated");

  const receipt = await l2.getTransactionReceipt({ hash: state.l2Tx as Hash });
  const [withdrawal] = getWithdrawals(receipt);
  const includeBlock = await l2.getBlock({ blockNumber: receipt.blockNumber });
  console.log(`withdrawal ${state.withdrawal.withdrawalHash} at L2 block ${receipt.blockNumber} (ts ${includeBlock.timestamp})`);

  // 1. newest super game + its per-chain claim
  const count = await l1.readContract({ address: DGF, abi: DGF_ABI, functionName: "gameCount" });
  const [latestGame] = await l1.readContract({ address: DGF, abi: DGF_ABI, functionName: "findLatestGames", args: [9, count - 1n, 1n] });
  const gameProxy = ("0x" + latestGame[1].slice(26)) as Address;
  const gameIndex = latestGame[0];
  const gameCreatedTs = Number(latestGame[2]);
  const rootClaim = await l1.readContract({ address: gameProxy, abi: GAME_ABI, functionName: "rootClaimByChainId", args: [OP_SEPOLIA_CHAIN_ID] });
  console.log(`game ${gameIndex} created at L1 ts ${gameCreatedTs}; rootClaimByChainId(op) = ${rootClaim}`);

  // The super root payload rides in extraData: 0x01 ‖ uint64 checkpointTs ‖ uint256 chainId ‖ bytes32 outputRoot.
  // The checkpoint timestamp is where the covered L2 block lives — not the game creation time.
  const extra = latestGame[4];
  if (extra.slice(2, 4) !== "01") throw new Error(`unexpected super root version byte ${extra.slice(2, 4)} in extraData`);
  const checkpointTs = Number(BigInt("0x" + extra.slice(4, 20)));
  const packedChainId = BigInt("0x" + extra.slice(20, 84));
  if (packedChainId !== BigInt(OP_SEPOLIA_CHAIN_ID)) throw new Error(`super root chainId ${packedChainId} != target`);
  console.log(`super root checkpoint ts: ${checkpointTs}`);

  // 2. find the covered L2 block: the block at the super root's checkpoint timestamp.
  const anchor = await blockAtOrBefore(checkpointTs);
  const window = 10; // timestamps are exact on OP chains; a few neighbors for safety
  let covered: { block: Block; storageRoot: Hash } | null = null;
  for (let off = 0; off <= window; off++) {
    for (const bn of off === 0 ? [anchor.number] : [anchor.number + BigInt(off), anchor.number - BigInt(off)]) {
      if (bn < 1n) continue;
      const block = await l2.getBlock({ blockNumber: bn }).catch(() => null);
      if (!block) continue;
      if (Math.abs(Number(block.timestamp) - checkpointTs) > 60) continue;
      const storageRoot = await messagePasserStorageRoot(bn);
      if (digestV0(block, storageRoot) === rootClaim) {
        covered = { block, storageRoot };
        console.log(`covered L2 block found: ${bn} (ts ${block.timestamp})`);
        break;
      }
    }
    if (covered) break;
  }
  if (!covered) throw new Error(`no L2 block in ±${window} of checkpoint ts ${checkpointTs} matches the game's root claim — inspect game ${gameIndex}`);

  // 3. coverage check — the withdrawal must be included in the covered block or earlier
  if (covered.block.number < receipt.blockNumber) {
    throw new Error(`newest game still covers block ${covered.block.number} < withdrawal block ${receipt.blockNumber}; wait for the next game (~15 min cadence)`);
  }
  console.log(`coverage OK: covered block ${covered.block.number} >= withdrawal block ${receipt.blockNumber}`);

  // 4. build proof and simulate
  const slot = (await getWithdrawalHashStorageSlot({ withdrawalHash: withdrawal.withdrawalHash })) as Hash;
  const proof = await l2.getProof({ address: MESSAGE_PASSER, storageKeys: [slot], blockNumber: covered.block.number });
  const withdrawalProof = maybeAddProofNode(slot.slice(2), proof.storageProof[0].proof as `0x${string}`[]);
  const outputRootProof = {
    version: ("0x" + "0".repeat(64)) as Hash,
    stateRoot: covered.block.stateRoot,
    messagePasserStorageRoot: covered.storageRoot,
    latestBlockhash: covered.block.hash,
  };
  const simArgs = {
    account,
    address: PORTAL,
    abi: PORTAL_SIM_ABI,
    functionName: "proveWithdrawalTransaction",
    args: [[withdrawal.nonce, withdrawal.sender, withdrawal.target, withdrawal.value, withdrawal.gasLimit, withdrawal.data], gameIndex, outputRootProof, withdrawalProof],
  } as const;
  await l1.simulateContract(simArgs).catch((e) => { throw new Error(`simulation failed: ${String(e).slice(0, 300)}`); });
  console.log("simulation passed");

  // 5. send
  const hash = await walletL1.writeContract({ ...simArgs, chain: sepolia } as never);
  console.log(`prove tx: ${hash}`);
  const proofReceipt = await l1.waitForTransactionReceipt({ hash });
  if (proofReceipt.status !== "success") throw new Error(`prove tx reverted on-chain: ${hash}`);
  state.proofTx = hash;
  state.provedAt = Math.floor(Date.now() / 1000);
  state.stage = "proven";
  state.notes.push(`proved against super game ${gameIndex}, covered L2 block ${covered.block.number}`);
  writeFileSync("withdrawals.json", JSON.stringify(states, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`proven. finalizable after proofMaturityDelaySeconds (604800) — ~${new Date((state.provedAt + 604800) * 1000).toISOString()}`);
}

await main();
