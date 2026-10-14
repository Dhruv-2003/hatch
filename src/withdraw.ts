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

const L1_RPC = `https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`;
const L2_RPC = `https://opt-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_PRIMARY")}`;

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
    if (state.withdrawal && state.stage !== "done") {
      try {
        const status = await publicClientL1.getWithdrawalStatus({
          receipt: await publicClientL2.getTransactionReceipt({ hash: state.l2Tx as `0x${string}` }),
          targetChain: opSepoliaHatch,
        });
        out.withdrawalStatus = status; // 'pending' | 'ready-to-prove' | 'ready-to-finalize' | 'finalized'
      } catch (e) {
        out.withdrawalStatus = `unknown: ${String(e).slice(0, 120)}`;
      }
    }
    const l1Block = await publicClientL1.getBlock({ blockTag: "latest" });
    out.l1Now = { number: l1Block.number, timestamp: l1Block.timestamp };
    console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
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

  if (cmd === "finalize") {
    const state = getState();
    if (state.stage !== "proven" && state.stage !== "finalizable") throw new Error(`stage is ${state.stage}; prove first`);
    const receipt = await publicClientL2.getTransactionReceipt({ hash: state.l2Tx as `0x${string}` });
    const [withdrawal] = getWithdrawals(receipt);
    console.log("waiting for proof maturity (7 days on op-sepolia; on blast mainnet this is 1 day)…");
    await publicClientL1.waitToFinalize({ receipt, targetChain: opSepoliaHatch, timeout: 700_000_000 });
    const hash = await walletClientL1.finalizeWithdrawal({ withdrawal, chain: sepolia });
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

  console.error("usage: bun src/withdraw.ts <initiate|status|prove|finalize> [--amount <eth>]");
  process.exit(2);
}

await main();
