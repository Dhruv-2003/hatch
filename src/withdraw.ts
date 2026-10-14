/**
 * hatch withdrawal flow (P0/P1) — initiate, prove, finalize, status.
 *
 * Usage: bun src/withdraw.ts <initiate|status|prove|finalize> [--amount <eth>]
 *
 * Stage commands are idempotent and resumable: state lives in withdrawals.json
 * (gitignored) so the flow can be picked up days later — which is the point.
 *
 * This build targets OP Sepolia (portal 5.8.0, DGF, game type 9). The Blast
 * oracle-era path is a separate flow wired to probe output.
 */
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { optimismSepolia, sepolia } from "viem/chains";
import { publicActionsL1, publicActionsL2, walletActionsL1, walletActionsL2 } from "viem/op-stack";
import { getWithdrawals } from "viem/op-stack";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

// RPC endpoints: explicit L1_RPC_URL / L2_RPC_URL win (lets you point the flow at
// an anvil fork for time-warped verification); otherwise the Alchemy defaults.
const envRpc = (fallback: string, name: string): string => {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  return line ? line.slice(name.length + 1).trim() : fallback;
};
const L1_RPC = envRpc(`https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`, "L1_RPC_URL");
const L2_RPC = envRpc(`https://opt-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_PRIMARY")}`, "L2_RPC_URL");

// Probe output for op-sepolia — the only addresses allowed in here (skill rule:
// addresses come from the probe, never from a chat message or web page).
const PORTAL = "0x16Fc5058F25648194471939df75CF27A2fdC48BC";
const DGF = "0x05F9613aDB30026FFd634f38e5C4dFd30a197Fa1";
const L2_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

const opSepoliaHatch = defineChain({
  ...optimismSepolia,
  rpcUrls: { default: { http: [L2_RPC] } },
  contracts: {
    ...optimismSepolia.contracts,
    portal: { [sepolia.id]: { address: PORTAL } },
    disputeGameFactory: { [sepolia.id]: { address: DGF } },
    l2ToL1MessagePasser: { address: L2_MESSAGE_PASSER },
  },
});

const account = privateKeyToAccount(`0x${env("TEST_KEY").replace(/^0x/, "")}` as `0x${string}`);

const publicClientL1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) })
  .extend(publicActionsL1());
const publicClientL2 = createPublicClient({ chain: opSepoliaHatch, transport: http(L2_RPC) })
  .extend(publicActionsL2());
const walletClientL1 = createWalletClient({ chain: sepolia, transport: http(L1_RPC), account })
  .extend(walletActionsL1());
const walletClientL2 = createWalletClient({ chain: opSepoliaHatch, transport: http(L2_RPC), account })
  .extend(walletActionsL2());

type State = {
  id: string;
  stage: "initiated" | "provable" | "proven" | "finalizable" | "done";
  l2Tx?: `0x${string}`;
  l2BlockNumber?: bigint;
  withdrawal?: Record<string, string>;
  proofTx?: `0x${string}`;
  provedAt?: number;
  finalizeTx?: `0x${string}`;
  notes: string[];
};

const STATE_FILE = "withdrawals.json";

// Portal reads done directly — viem's getWithdrawalStatus still calls the legacy
// single-arg provenWithdrawals(bytes32), which reverts on proof-submitter-era portals
// (v3+ uses provenWithdrawals(bytes32, address)). Never trust the library's status path.
const PORTAL_STATUS_ABI = [
  {
    name: "provenWithdrawals",
    type: "function",
    stateMutability: "view",
    outputs: [
      { name: "gameProxy", type: "address" },
      { name: "timestamp", type: "uint128" },
    ],
    inputs: [{ type: "bytes32" }, { type: "address" }],
  },
  { name: "proofMaturityDelaySeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "disputeGameFinalityDelaySeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
] as const;

const GAME_STATUS_ABI = [
  { name: "status", type: "function", stateMutability: "view", outputs: [{ type: "uint8" }], inputs: [] }, // 0 in-progress, 1 challenger-wins, 2 defender-wins
  { name: "createdAt", type: "function", stateMutability: "view", outputs: [{ type: "uint64" }], inputs: [] },
  { name: "resolvedAt", type: "function", stateMutability: "view", outputs: [{ type: "uint64" }], inputs: [] },
  { name: "maxClockDuration", type: "function", stateMutability: "view", outputs: [{ type: "uint64" }], inputs: [] },
] as const;

async function withdrawalStatusOnChain(withdrawalHash: Hash) {
  const proof = await publicClientL1.readContract({ address: PORTAL, abi: PORTAL_STATUS_ABI, functionName: "provenWithdrawals", args: [withdrawalHash, account.address] });
  const maturity = await publicClientL1.readContract({ address: PORTAL, abi: PORTAL_STATUS_ABI, functionName: "proofMaturityDelaySeconds" });
  const finalityDelay = await publicClientL1.readContract({ address: PORTAL, abi: PORTAL_STATUS_ABI, functionName: "disputeGameFinalityDelaySeconds" });
  const gameProxy = proof[0];
  const provedAt = Number(proof[1]);
  const proven = gameProxy !== "0x0000000000000000000000000000000000000000" && provedAt > 0;
  // Compare against the L1 chain's own clock (block timestamp), not the host clock —
  // the contract enforces block timestamps, and this also makes anvil time-warp tests honest.
  const l1Latest = await publicClientL1.getBlock({ blockTag: "latest" });
  const l1NowMs = Number(l1Latest.timestamp) * 1000;

  // Two gates must pass before finalize; both checked from chain state:
  //  1. proof maturity: provedAt + proofMaturityDelaySeconds
  //  2. game claim validity: game resolved (DEFENDER_WINS) + resolvedAt + disputeGameFinalityDelaySeconds.
  //     An unchallenged game only becomes resolvable after its challenger clock (maxClockDuration)
  //     expires; resolveClaim/resolve are permissionless — anyone can send them, hatch includes them.
  let game: Record<string, unknown> | null = null;
  let finalizableAt: number | null = null;
  if (proven) {
    const proofMaturesAtMs = (provedAt + Number(maturity)) * 1000;
    let claimValidAtMs = 0;
    try {
      const g = await Promise.all([
        publicClientL1.readContract({ address: gameProxy, abi: GAME_STATUS_ABI, functionName: "status" }),
        publicClientL1.readContract({ address: gameProxy, abi: GAME_STATUS_ABI, functionName: "createdAt" }),
        publicClientL1.readContract({ address: gameProxy, abi: GAME_STATUS_ABI, functionName: "resolvedAt" }),
        publicClientL1.readContract({ address: gameProxy, abi: GAME_STATUS_ABI, functionName: "maxClockDuration" }),
      ]);
      const [status, createdAt, resolvedAt, maxClock] = g;
      const gameStatus = Number(status);
      const resolvedAtNum = Number(resolvedAt);
      const resolveEarliestMs = resolvedAtNum > 0
        ? (resolvedAtNum + Number(finalityDelay)) * 1000
        : (Number(createdAt) + Number(maxClock) + Number(finalityDelay)) * 1000; // assumes resolve sent at first opportunity
      game = { status: gameStatus, createdAt: Number(createdAt), resolvedAt: resolvedAtNum, maxClockDuration: Number(maxClock), resolvableNow: gameStatus === 0 && Number(l1Latest.timestamp) >= Number(createdAt) + Number(maxClock), claimValidAt: resolveEarliestMs };
      claimValidAtMs = resolveEarliestMs;
    } catch {
      // oracle-era games (class A) have no resolution step — the root IS the claim
      claimValidAtMs = 0;
      game = { status: "n/a (oracle-era game)" };
    }
    finalizableAt = Math.max(proofMaturesAtMs, claimValidAtMs);
  }
  const matured = finalizableAt !== null && l1NowMs >= finalizableAt;
  return { proven, provedAt, finalizableAt, matured, game, proofSubmitter: account.address, note: "finalize must be sent by the same address that proved (or use finalizeWithdrawalTransactionExternalProof)" };
}

function loadStates(): Record<string, State> {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function save(states: Record<string, State>) {
  const out = JSON.stringify(states, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(STATE_FILE, out + "\n");
}

function getState(): State {
  const states = loadStates();
  const ids = Object.keys(states);
  if (ids.length === 0) throw new Error("no withdrawal state — run initiate first");
  return states[ids[ids.length - 1]];
}

function wdHash(s: State): Hash {
  const h = s.withdrawalHash ?? (s.withdrawal as { withdrawalHash?: Hash } | undefined)?.withdrawalHash;
  if (!h) throw new Error("no withdrawal hash in state — was the withdrawal initiated and proven?");
  return h as Hash;
}

async function main() {
  const cmd = process.argv[2];
  const amount = process.argv.includes("--amount") ? process.argv[process.argv.indexOf("--amount") + 1] : "0.005";

  if (cmd === "initiate") {
    const states = loadStates();
    const id = `wd-${Date.now()}`;
    const state: State = { id, stage: "initiated", notes: [] };
    const hash = await walletClientL2.initiateWithdrawal({
      account,
      request: { to: account.address, value: BigInt(Math.round(parseFloat(amount) * 1e18)), gas: 30_000 },
      chain: opSepoliaHatch,
    });
    state.l2Tx = hash;
    console.log(`initiate tx: ${hash}`);
    const receipt = await publicClientL2.waitForTransactionReceipt({ hash });
    state.l2BlockNumber = receipt.blockNumber;
    const [withdrawal] = getWithdrawals(receipt);
    state.withdrawal = Object.fromEntries(Object.entries(withdrawal).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)]));
    state.notes.push(`initiated ${amount} ETH on op-sepolia at L2 block ${receipt.blockNumber}`);
    states[id] = state;
    save(states);
    console.log(JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }

  if (cmd === "status") {
    const state = getState();
    const out: Record<string, unknown> = { ...state };
    if (state.withdrawal || state.withdrawalHash) {
      out.onChain = await withdrawalStatusOnChain(wdHash(state));
    }
    const l1Block = await publicClientL1.getBlock({ blockTag: "latest" });
    out.l1Now = { number: l1Block.number, timestamp: l1Block.timestamp };
    console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return;
  }

  if (cmd === "next-action") {
    // Machine-readable "what should happen next" for agent schedulers / cron.
    // Always re-reads chain state, so it is safe to run on every wake.
    const state = getState();
    if (state.stage === "done") {
      console.log(JSON.stringify({ id: state.id, stage: "done", nextAction: null, nextActionAt: null }, null, 2));
      return;
    }
    const onchain = await withdrawalStatusOnChain(wdHash(state));
    let nextAction: string | null;
    let nextActionAt: number | null;
    if (!onchain.proven) {
      nextAction = "prove";
      nextActionAt = 0; // as soon as a covering root/game exists — check liveness first
    } else if (onchain.game && typeof onchain.game.status === "number" && onchain.game.status === 0 && onchain.game.resolvableNow) {
      nextAction = "resolve-game"; // permissionless; someone must send it or finalize can never pass
      nextActionAt = 0;
    } else if (!onchain.matured) {
      nextAction = "finalize";
      nextActionAt = onchain.finalizableAt;
    } else {
      nextAction = "finalize";
      nextActionAt = 0; // matured — finalize now
    }
    console.log(JSON.stringify({ id: state.id, stage: state.stage, nextAction, nextActionAt, matured: onchain.matured, finalizableAt: onchain.finalizableAt, proofSubmitter: onchain.proofSubmitter }, null, 2));
    return;
  }

  if (cmd === "prove") {
    const state = getState();
    if (!state.l2Tx || !state.l2BlockNumber) throw new Error("not initiated");
    if (state.stage === "proven" || state.stage === "finalizable" || state.stage === "done") {
      console.log(`already ${state.stage} — nothing to do`);
      return;
    }
    const receipt = await publicClientL2.getTransactionReceipt({ hash: state.l2Tx as `0x${string}` });
    const [withdrawal] = getWithdrawals(receipt);
    // Blocks until a dispute game covering the withdrawal's L2 block lands on L1.
    console.log("waiting for a covering dispute game (this is the prove-early window)…");
    const proved = await publicClientL1.waitToProve({
      receipt,
      timeout: 3_600_000,
      targetChain: opSepoliaHatch,
    });
    // waitToProve returns { game, output }; buildProveWithdrawal wants them flat.
    const args = await publicClientL2.buildProveWithdrawal({
      account,
      game: proved.game,
      output: proved.output,
      withdrawal,
    });
    const hash = await walletClientL1.proveWithdrawal({ ...args, chain: sepolia } as never);
    console.log(`prove tx: ${hash}`);
    const proofReceipt = await publicClientL1.waitForTransactionReceipt({ hash });
    const states = loadStates();
    state.proofTx = hash;
    state.provedAt = Math.floor(Date.now() / 1000);
    state.stage = "proven";
    state.notes.push(`proved against game output index ${output.outputIndex}; maturity = proofMaturityDelaySeconds (604800s) from proof timestamp`);
    states[state.id] = state;
    save(states);
    console.log(`prove included in L1 block ${proofReceipt.blockNumber}; finalizable at ~${new Date((state.provedAt + 604800) * 1000).toISOString()}`);
    return;
  }

  if (cmd === "resolve") {
    // Resolve the withdrawal's dispute game (permissionless once the challenger clock
    // expires). Skipping this step means finalize can NEVER pass the claim-validity gate.
    const state = getState();
    const onchain = await withdrawalStatusOnChain(wdHash(state));
    const g = onchain.game as { status?: number | string; resolvableNow?: boolean; createdAt?: number; maxClockDuration?: number } | null;
    if (!g || typeof g.status !== "number") throw new Error("no dispute game attached to this withdrawal (oracle-era chain — no resolution step exists)");
    if (g.status === 2) { console.log(JSON.stringify({ status: "already-resolved", detail: "DEFENDER_WINS — nothing to do" }, null, 2)); return; }
    if (g.status === 1) throw new Error("game resolved CHALLENGER_WINS — root was invalid; re-prove against a newer game");
    if (!g.resolvableNow) throw new Error(`challenger clock not expired yet; resolvable at ${new Date(((g.createdAt ?? 0) + (g.maxClockDuration ?? 0)) * 1000).toISOString()}`);
    const gameProxy = (await publicClientL1.readContract({ address: PORTAL, abi: PORTAL_STATUS_ABI, functionName: "provenWithdrawals", args: [wdHash(state), account.address] }))[0];
    const h1 = await walletClientL1.writeContract({ address: gameProxy, abi: [{ name: "resolveClaim", type: "function", stateMutability: "nonpayable", outputs: [], inputs: [{ type: "uint256" }, { type: "uint256" }] }] as const, functionName: "resolveClaim", args: [0n, 0n], chain: sepolia });
    await publicClientL1.waitForTransactionReceipt({ hash: h1 });
    const h2 = await walletClientL1.writeContract({ address: gameProxy, abi: [{ name: "resolve", type: "function", stateMutability: "nonpayable", outputs: [{ type: "uint8" }], inputs: [] }] as const, functionName: "resolve", args: [], chain: sepolia });
    await publicClientL1.waitForTransactionReceipt({ hash: h2 });
    const states = loadStates();
    state.notes.push(`resolved dispute game ${gameProxy}: ${h1}, ${h2}`);
    states[state.id] = state;
    save(states);
    console.log(JSON.stringify({ resolved: true, gameProxy, txs: [h1, h2], finalizableAt: onchain.finalizableAt }, null, 2));
    return;
  }

  if (cmd === "finalize") {
    const state = getState();
    if (state.stage !== "proven" && state.stage !== "finalizable" && state.stage !== "done") throw new Error(`stage is ${state.stage}; prove first`);
    if (state.stage === "done") {
      console.log(JSON.stringify({ id: state.id, stage: "done", finalizeTx: state.finalizeTx }, null, 2));
      return;
    }
    // Maturity check done with direct reads — see PORTAL_STATUS_ABI note.
    const onchain = await withdrawalStatusOnChain(wdHash(state));
    if (!onchain.proven) throw new Error("withdrawal not proven yet — run prove first");
    if (!onchain.matured) {
      const eta = new Date(onchain.finalizableAt!).toISOString();
      console.log(JSON.stringify({ error: "proof not matured", finalizableAt: eta, secondsRemaining: Math.round((onchain.finalizableAt! - Date.now()) / 1000) }, null, 2));
      process.exit(3);
    }
    const receipt = await publicClientL2.getTransactionReceipt({ hash: state.l2Tx as `0x${string}` });
    const [withdrawal] = getWithdrawals(receipt);
    const hash = await walletClientL1.finalizeWithdrawal({ withdrawal, chain: sepolia, targetChain: opSepoliaHatch });
    console.log(`finalize tx: ${hash}`);
    await publicClientL1.waitForTransactionReceipt({ hash });
    const states = loadStates();
    state.finalizeTx = hash;
    state.stage = "done";
    state.notes.push(`finalized on L1: ${hash}`);
    states[state.id] = state;
    save(states);
    console.log("withdrawal complete — funds on L1");
    return;
  }

  console.error("usage: bun src/withdraw.ts <initiate|status|next-action|prove|resolve|finalize> [--amount <eth>]");
  process.exit(2);
}

await main();
