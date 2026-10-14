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
import { http, createPublicClient, createWalletClient, encodeFunctionData, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optimismSepolia, sepolia } from "viem/chains";
import { readFileSync } from "node:fs";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

// Addresses from chains/op-sepolia.probe.json (probe-derived, never pasted)
const PROBE = JSON.parse(readFileSync("chains/op-sepolia.probe.json", "utf8"));
const PORTAL = PROBE.portal;
const L2_MESSAGE_PASSER = "0x4200000000000000000000000000000000000016"; // fixed per OP Stack spec (predeploys)

const L1_RPC = `https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`;
const L2_RPC = `https://opt-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_PRIMARY")}`;

const PORTAL_ABI = [{
  name: "depositTransaction", type: "function", stateMutability: "payable",
  inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }, { name: "_gasLimit", type: "uint64" }, { name: "_isCreation", type: "bool" }, { name: "_data", type: "bytes" }],
}] as const;

// Current-era L2ToL1MessagePasser: 3-arg initiateWithdrawal — msg.value IS the withdrawal
// value (the 4-arg (target,gasLimit,value,data) ABI is the old version and selector-mismatches
// into a silent revert). Verify against the deployed contract when adapting to a new chain.
const MSG_PASSER_ABI = [{
  name: "initiateWithdrawal", type: "function", stateMutability: "payable",
  inputs: [{ name: "_target", type: "address" }, { name: "_gasLimit", type: "uint256" }, { name: "_data", type: "bytes" }],
}] as const;

async function main() {
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
    console.log(JSON.stringify({
      ...request,
      dryRun: true,
      cast: `cast send ${PORTAL} "depositTransaction(address,uint256,uint64,bool,bytes)" ${L2_MESSAGE_PASSER} ${valueWei} 200000 false ${l2Calldata} --value ${valueWei}`,
      note: "dry-run default — nothing was sent. Sign with your own wallet or rerun with --send (testnet throwaway key only).",
    }, null, 2));
    return;
  }

  const wallet = createWalletClient({ chain: sepolia, transport: http(L1_RPC), account: privateKeyToAccount(`0x${env("TEST_KEY").replace(/^0x/, "")}` as `0x${string}`) });
  const hash = await wallet.writeContract({
    address: PORTAL, abi: PORTAL_ABI, functionName: "depositTransaction",
    args: [L2_MESSAGE_PASSER, valueWei, l2GasLimit, false, l2Calldata], value: valueWei,
  });
  console.log(JSON.stringify({ ...request, sent: true, txHash: hash, note: "wait for derivation, then find the L2 MessagePassed log; after that it is a normal withdrawal" }, null, 2));
}

const EST_DEPOSIT_GAS = 180_000;

await main();
