import { rpcEndpoint } from "./rpc.ts";
/**
 * hatch force-inclusion (P2) — initiate a withdrawal FROM L1 when the L2 can't be
 * used (UI gone, sequencer censoring withdrawals, or the user can't sign on L2).
 *
 * Usage: bun src/force-include.ts --to <recipient> --amount <eth> [--l2-data 0x…] [--send]
 *
 * Mechanism: a deposit transaction on the portal whose L2 execution calls the
 * L2ToL1MessagePasser's initiateWithdrawal. The sequencer must still DERIVE the
 * deposit (it lands within the sequencing window even under censorship); after that
 * the withdrawal proceeds exactly like an L2-initiated one: prove → resolve → finalize.
 *
 * Default is dry-run: emits the unsigned tx request + an equivalent cast command.
 * --send uses the .env TEST_KEY (testnet only — never run this with a mainnet key).
 *
 * Caveats checked from the probe, not assumed: chains with a custom bridge (Blast) may
 * hold ETH in a yield manager and may blacklist depositTransaction for some contracts —
 * if the probe flagged custom-bridge deltas, say so in the plan before using this.
 */
import { concat, decodeEventLog, encodeFunctionData, formatEther, padHex, parseAbiItem, parseEther, toHex } from "viem";
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getL2TransactionHash, type Hash } from "viem/op-stack";
import { optimismSepolia, sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { castSend, signerMode } from "./signer.ts";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

// Addresses from chains/op-sepolia.probe.json (probe-derived, never pasted)
const PROBE = JSON.parse(readFileSync("chains/op-sepolia.probe.json", "utf8"));
const PORTAL = PROBE.portal;
const L2_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016"; // fixed per OP Stack spec (predeploys)

const L1_RPC = rpcEndpoint("L1_RPC_URL", "ALCHEMY_KEY_SECONDARY", "eth-sepolia.g.alchemy.com");
const L2_RPC = rpcEndpoint("L2_RPC_URL", "ALCHEMY_KEY_PRIMARY", "opt-sepolia.g.alchemy.com");

const PORTAL_ABI = [{
  name: "depositTransaction", type: "function", stateMutability: "payable",
  inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }, { name: "_gasLimit", type: "uint64" }, { name: "_isCreation", type: "bool" }, { name: "_data", type: "bytes" }],
}] as const;

// v2 deposit event (0xb3813568…) — see SKILL.md troubleshooting
const TD_V2 = {
  type: "event", name: "TransactionDeposited",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "version", indexed: true },
    { type: "bytes", name: "opaqueData" },
  ],
} as const;

// Current-era L2ToL1MessagePasser: 3-arg initiateWithdrawal — msg.value IS the withdrawal
// value (the 4-arg (target,gasLimit,value,data) ABI is the old version and selector-mismatches
// into a silent revert). Verify against the deployed contract when adapting to a new chain.
const MSG_PASSER_ABI = [{
  name: "initiateWithdrawal", type: "function", stateMutability: "payable",
  inputs: [{ name: "_target", type: "address" }, { name: "_gasLimit", type: "uint256" }, { name: "_data", type: "bytes" }],
}] as const;

async function main() {
  const checkIdx = process.argv.indexOf("--check");
  if (checkIdx > -1) {
    await checkDerivation(process.argv[checkIdx + 1] as Hash);
    return;
  }
  const get = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const to = get("--to");
  const amount = get("--amount");
  if (!to || !amount) {
    console.error("usage: bun src/force-include.ts --to <recipient> --amount <eth> [--l2-data 0x…] [--send]");
    process.exit(2);
  }
  const send = process.argv.includes("--send");
  const l2GasLimit = 200_000; // generous for a plain ETH withdrawal initiation
  const valueWei = parseEther(amount);

  // The L2-side call the deposit will execute: MessagePasser.initiateWithdrawal with
  // msg.value = the deposit's minted value = the amount being withdrawn.
  const l2Calldata = encodeFunctionData({
    abi: MSG_PASSER_ABI,
    functionName: "initiateWithdrawal",
    args: [to as `0x${string}`, BigInt(l2GasLimit), "0x"],
  });

  const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const gasPrice = await l1.getGasPrice();

  const request = {
    kind: "force-included withdrawal initiation",
    what: `deposit ${amount} ETH into the L2 message passer so L2 executes initiateWithdrawal(${amount} ETH → ${to})`,
    from: send ? privateKeyToAccount(`0x${env("TEST_KEY").replace(/^0x/, "")}`).address : "<user signs>",
    chain: "sepolia (L1)",
    contract: PORTAL,
    function: "depositTransaction(to=L2ToL1MessagePasser, value=amount, gasLimit, isCreation=false, data=initiateWithdrawal calldata)",
    value: `${amount} ETH`,
    estimatedL1Gas: `${EST_DEPOSIT_GAS} gas ≈ ${Number(formatEther(gasPrice * BigInt(EST_DEPOSIT_GAS)))} ETH at current gas price`,
    l2Calldata,
    afterLanding: [
      "the sequencer derives the deposit within the sequencing window (~minutes when healthy; the force-inclusion guarantee kicks in if it censors)",
      "once the L2 tx executes, the withdrawal exists exactly like an L2-initiated one",
      "continue: bun src/prove-super.ts  →  bun src/withdraw.ts resolve  →  bun src/withdraw.ts finalize",
    ],
  };

  if (!send) {
    const mode = signerMode();
    console.log(JSON.stringify({
      ...request,
      dryRun: true,
      cast: castSend({ to: PORTAL as `0x${string}`, signature: "depositTransaction(address,uint256,uint64,bool,bytes)", args: [L2_MESSAGE_PASSER, valueWei, l2GasLimit, false, l2Calldata], value: valueWei, mode }),
      note: mode === "unsigned"
        ? "dry-run default — nothing was sent. Sign with your own wallet, or rerun with --signer ledger|keystore (emits a cast command) or --send (throwaway testnet key only)."
        : `signing via ${mode} — run the cast command above; nothing was sent by hatch.`,
    }, null, 2));
    return;
  }

  const wallet = createWalletClient({ chain: sepolia, transport: http(L1_RPC), account: privateKeyToAccount(`0x${env("TEST_KEY").replace(/^0x/, "")}` as `0x${string}`) });
  const hash = await wallet.writeContract({
    address: PORTAL, abi: PORTAL_ABI, functionName: "depositTransaction",
    args: [L2_MESSAGE_PASSER, valueWei, l2GasLimit, false, l2Calldata], value: valueWei,
  });
  // Derive the deterministic L2 tx hash now so the agent can poll its receipt directly
  // and adopt the withdrawal once it succeeds (rebuild → prove → resolve → finalize).
  const r1 = await l1.getTransactionReceipt({ hash });
  const depLog = r1.logs.find((log) => log.address.toLowerCase() === PORTAL.toLowerCase());
  const ev = depLog ? decodeEventLog({ abi: [TD_V2], data: depLog.data, topics: depLog.topics }) : null;
  const l2Hash = ev ? getL2TransactionHash({ log: { ...depLog!, args: { from: ev.args.from, to: ev.args.to, opaqueData: ev.args.opaqueData } } }) : null;
  console.log(JSON.stringify({
    ...request,
    sent: true,
    txHash: hash,
    l2TxHash: l2Hash,
    note: "wait ~1-3 min for derivation, then check the L2 receipt: status must be 'success' with a MessagePassed log (a reverted status means the L2 execution failed — see troubleshooting). Then: bun src/withdraw.ts rebuild <l2TxHash> and continue prove → resolve → finalize.",
  }, null, 2));
}

const EST_DEPOSIT_GAS = 180_000;

// 12h sequencing window on current OP Stack — past it, derivation has stopped entirely
// and no further L1 action can help; the fix is infrastructure (see README research).
const SEQUENCING_WINDOW_SECONDS = 43_200;

// viem's getL2TransactionHash expects a decoded v2-shaped log ({args:{from,to,opaqueData}}).
// Classic-era portals emit the tuple event instead — synthesize the opaqueData packing
// (mint 32B | value 32B | gas 8B | isCreation 1B | data) so both eras hash correctly.
// Same event ABIs as scan.ts; keep the two definitions in sync.
const TD_CLASSIC = parseAbiItem("event TransactionDeposited(address indexed from, address indexed to, (uint256,uint256,uint256,bool,bytes) tx)");

function depositL2Hash(log: { blockHash: Hash; logIndex: number; topics: string[]; data: Hash }): Hash {
  let from: Hash, to: Hash, opaqueData: Hash;
  if (log.topics[0] === "0xb3813568d9991fc951961fcb4c784893574240a28925604d09fc577c55bb7c32") {
    const ev = decodeEventLog({ abi: [TD_V2], data: log.data, topics: log.topics as [Hash] });
    from = ev.args.from as Hash;
    to = ev.args.to as Hash;
    opaqueData = ev.args.opaqueData as Hash;
  } else {
    const ev = decodeEventLog({ abi: [TD_CLASSIC], data: log.data, topics: log.topics as [Hash] });
    const [mint, value, gas, isCreation, data] = ev.args.tx as [bigint, bigint, bigint, boolean, Hash];
    from = ev.args.from as Hash;
    to = ev.args.to as Hash;
    opaqueData = concat([
      padHex(toHex(mint), 32), padHex(toHex(value), 32), padHex(toHex(gas), 8),
      isCreation ? toHex(1, 1) : toHex(0, 1), data,
    ]) as Hash;
  }
  return getL2TransactionHash({ log: { ...log, args: { from, to, opaqueData } } });
}

async function checkDerivation(l1TxHash: Hash) {
  const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });
  const r1 = await l1.getTransactionReceipt({ hash: l1TxHash });
  if (!r1) throw new Error(`no L1 receipt for ${l1TxHash}`);
  const depLog = r1.logs.find((log) => log.address.toLowerCase() === PORTAL.toLowerCase());
  if (!depLog) throw new Error("that L1 tx is not a portal deposit");
  const l1Block = await l1.getBlock({ blockNumber: r1.blockNumber });
  const l2Hash = depositL2Hash(depLog);
  let l2Status: string;
  let next: string[];
  try {
    const r2 = await createPublicClient({ chain: optimismSepolia, transport: http(L2_RPC) }).getTransactionReceipt({ hash: l2Hash });
    if (r2.status === "success" && r2.logs.length > 0) {
      l2Status = "initiated-on-l2";
      next = [`bun src/withdraw.ts rebuild ${l2Hash}`, "then prove → resolve → finalize (SKILL.md Part 5)"];
    } else {
      l2Status = "reverted-on-l2";
      next = ["the deposit was derived but the L2 execution reverted (old 4-arg initiateWithdrawal calldata is the usual cause — see SKILL.md troubleshooting)", "fix the calldata and submit a fresh depositTransaction"];
    }
  } catch {
    const elapsed = Math.floor(Date.now() / 1000) - Number(l1Block.timestamp);
    if (elapsed > SEQUENCING_WINDOW_SECONDS) {
      l2Status = "derivation-stalled";
      next = [
        `L1 deposit landed ${Math.round(elapsed / 3600)}h ago, past the ${SEQUENCING_WINDOW_SECONDS / 3600}h sequencing window, with no L2 execution — derivation on this chain has stopped`,
        "re-submitting depositTransaction will not help; the recovery is infrastructure: run a node to resume derivation (README → research: the P2/P3 frontier), then a covering root/game, then finalize",
      ];
    } else {
      l2Status = "awaiting-derivation";
      next = [`wait ~${Math.ceil((SEQUENCING_WINDOW_SECONDS - elapsed) / 60)} min worst case (sequencing window), then re-run: bun src/force-include.ts --check ${l1TxHash}`];
    }
  }
  console.log(JSON.stringify({ l1TxHash, l2TxHash: l2Hash, status: l2Status, l1BlockNumber: Number(r1.blockNumber), next }, null, 2, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

await main();
