/**
 * hatch l2-reader — the L2 side of discovery. The L1 scanner only sees what crossed
 * the bridge; anything the user did natively on L2 (direct receives, DEX swaps,
 * native ETH from faucets) lives here. Optional: runs only if the L2 RPC is alive.
 *
 * Usage: bun src/l2-reader.ts <l2-address> [--blocks 10000] [--tokens 0x…,0x…]
 *        (token list defaults to the l2Token addresses found by src/scan.ts's checkpoint)
 *
 * Reports: native ETH balance, balances for each known token, and every withdrawal the
 * user already initiated on L2 (MessagePassed logs) with its live proof status on the
 * portal — that list is the P1 recovery queue: initiated-but-unproven is the most
 * time-critical state on a winding-down chain.
 */
import { http, createPublicClient, parseAbiItem, decodeEventLog, formatEther, formatUnits, type Hash } from "viem";
import { optimismSepolia, sepolia } from "viem/chains";
import { readFileSync, existsSync } from "node:fs";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

const L1_RPC = `https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`;
const L2_RPC = `https://opt-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_PRIMARY")}`;
const PORTAL = "0x16Fc5058F25648194471939df75CF27A2fdC48BC"; // from chains/op-sepolia.probe.json
const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";

const l2 = createPublicClient({ chain: optimismSepolia, transport: http(L2_RPC) });
const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

const MP_EVENT = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");

async function main() {
  const address = process.argv[2]?.toLowerCase() as `0x${string}`;
  if (!address?.startsWith("0x")) {
    console.error("usage: bun src/l2-reader.ts <l2-address> [--blocks 10000] [--tokens 0x…,0x…]");
    process.exit(2);
  }
  const blocksIdx = process.argv.indexOf("--blocks");
  const blocks = blocksIdx > -1 ? Number(process.argv[blocksIdx + 1]) : 10000;
  const tokensArg = process.argv.indexOf("--tokens") > -1 ? process.argv[process.argv.indexOf("--tokens") + 1] : undefined;

  const head = await l2.getBlockNumber();
  const native = await l2.getBalance({ address });

  // withdrawals the user already initiated on L2 (P1 queue) — chunked at the 10-block cap
  const withdrawals: { withdrawalHash: string; value: string; nonce: string; l2Block: number; proven: boolean }[] = [];
  const from = head - BigInt(blocks);
  for (let lo = from; lo <= head; lo += 10n) {
    const hi = lo + 9n > head ? head : lo + 9n;
    const logs = await l2.getLogs({ address: MESSAGE_PASSER, event: MP_EVENT, args: { sender: address }, fromBlock: lo, toBlock: hi }).catch(() => []);
    for (const l of logs) {
      const wh = l.args.withdrawalHash as Hash;
      const proof = await l1.readContract({
        address: PORTAL,
        abi: [{ name: "provenWithdrawals", type: "function", stateMutability: "view", outputs: [{ name: "gameProxy", type: "address" }, { name: "timestamp", type: "uint128" }], inputs: [{ type: "bytes32" }, { type: "address" }] }] as const,
        functionName: "provenWithdrawals",
        args: [wh, address],
      });
      withdrawals.push({ withdrawalHash: wh, value: formatEther(l.args.value as bigint), nonce: (l.args.nonce as bigint).toString(), l2Block: l.blockNumber, proven: proof[0] !== "0x0000000000000000000000000000000000000000" });
    }
  }

  // token balances: explicit --tokens, else ERC20s discovered by the scanner checkpoint
  let tokens: `0x${string}`[] = [];
  if (tokensArg) tokens = tokensArg.split(",").map((t) => t.trim() as `0x${string}`);
  else {
    const ckpt = `.scan-${address.slice(0, 10)}.json`;
    if (existsSync(ckpt)) {
      const scan = JSON.parse(readFileSync(ckpt, "utf8"));
      tokens = [...new Set((scan.logs ?? []).filter((l: { event?: string }) => l?.event === "ERC20DepositInitiated").map((l: { args: { l2Token?: string } }) => l.args.l2Token as `0x${string}`))];
    }
  }
  const balances = await Promise.all(tokens.map(async (t) => {
    const bal = await l2.readContract({ address: t, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [{ type: "address" }] }, { name: "decimals", type: "function", stateMutability: "view", outputs: [{ type: "uint8" }], inputs: [] }] as const, functionName: "balanceOf", args: [address] }).catch(() => 0n);
    const dec = await l2.readContract({ address: t, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [{ type: "address" }] }, { name: "decimals", type: "function", stateMutability: "view", outputs: [{ type: "uint8" }], inputs: [] }] as const, functionName: "decimals" }).catch(() => 18);
    return { token: t, balance: formatUnits(bal, dec) };
  }));

  console.log(JSON.stringify({
    address,
    l2: { chainId: optimismSepolia.id, headBlock: Number(head), scannedBlocks: blocks },
    native: { eth: formatEther(native), wei: native.toString() },
    tokens: balances.length ? balances : "none found (scan a window containing ERC20 deposits, or pass --tokens)",
    withdrawalsInitiated: {
      note: "P1 queue: initiated on L2, needs prove → resolve → finalize. Unproven ones are the time-critical ones.",
      count: withdrawals.length,
      unproven: withdrawals.filter((w) => !w.proven),
      all: withdrawals,
    },
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

await main();
