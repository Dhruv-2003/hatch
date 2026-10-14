/**
 * hatch l1-scanner — what a user bridged in, what already came out.
 *
 * Usage: bun src/scan.ts <l1-address> [--days 2 | --blocks 10000] [--from <block>]
 *
 * Topic-only eth_getLogs over the whole chain (no address filter — bridge/messenger
 * addresses are chain-specific and we refuse to hardcode unprobed ones), chunked at
 * 10 blocks (free-tier RPC cap) with adaptive retry, checkpointed for resume.
 *
 * Everything reported is a LOWER BOUND: logs we happened to find. Never presented
 * as the user's true L2 balance.
 */
import { http, createPublicClient, parseAbiItem, decodeEventLog, formatEther, getEventSelector, type Hash } from "viem";
import { opaqueDataToDepositData } from "viem/op-stack";
import { sepolia } from "viem/chains";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

const L1_RPC = `https://eth-sepolia.g.alchemy.com/v2/${env("ALCHEMY_KEY_SECONDARY")}`;
const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

const EVENTS = [
  parseAbiItem("event WithdrawalFinalized(bytes32 indexed withdrawalHash, bool success)"),
  parseAbiItem("event ETHDepositInitiated(address indexed from, address indexed to, uint256 amount, bytes data)"),
  parseAbiItem("event ERC20DepositInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes data)"),
  parseAbiItem("event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)"),
] as const;

// Both TransactionDeposited shapes exist in the wild: the classic tuple event (v1 portals)
// and the opaqueData event (v2+, packed mint|value|gas|isCreation|data).
const TD_CLASSIC = parseAbiItem("event TransactionDeposited(address indexed from, address indexed to, (uint256,uint256,uint256,bool,bytes) tx)");
const TD_V2 = {
  type: "event", name: "TransactionDeposited",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "version", indexed: true },
    { type: "bytes", name: "opaqueData" },
  ],
} as const;

// topic0 -> which decoder
const BY_TOPIC = new Map<string, (typeof EVENTS)[number] | typeof TD_CLASSIC | typeof TD_V2>();
for (const e of EVENTS) BY_TOPIC.set(getEventSelector(e), e);
BY_TOPIC.set(getEventSelector(TD_CLASSIC), TD_CLASSIC);
BY_TOPIC.set("0xb3813568d9991fc951961fcb4c784893574240a28925604d09fc577c55bb7c32" as Hash, TD_V2); // keccak(TransactionDeposited(address,address,uint256,bytes))

async function main() {
  const address = process.argv[2]?.toLowerCase() as `0x${string}`;
  if (!address?.startsWith("0x")) {
    console.error("usage: bun src/scan.ts <l1-address> [--days 2] [--from <block>]");
    process.exit(2);
  }
  const daysIdx = process.argv.indexOf("--days");
  const days = daysIdx > -1 ? Number(process.argv[daysIdx + 1]) : 2;
  const blocksIdx = process.argv.indexOf("--blocks");
  const fromArg = process.argv.indexOf("--from");
  const latest = await l1.getBlockNumber();
  // sepolia block time ~12s (post-merge 12s slots full); be generous: 86400/12 ≈ 7200 blocks/day
  const from = fromArg > -1 ? BigInt(process.argv[fromArg + 1])
    : blocksIdx > -1 ? latest - BigInt(process.argv[blocksIdx + 1])
    : latest - BigInt(Math.ceil((days * 86400) / 12));
  const ckpt = `.scan-${address.slice(0, 10)}.json`;
  const state = existsSync(ckpt) ? JSON.parse(readFileSync(ckpt, "utf8")) : { scannedTo: Number(from) - 1, logs: [] };
  if (state.scannedTo >= Number(latest) - 2) {
    console.log(`scan already complete through block ${state.scannedTo} — lower bound from checkpoint: ${state.logs.length} relevant logs`);
    summarize(state.logs, address, Number(from), Number(latest));
    return;
  }

  const CHUNK = 10; // free-tier eth_getLogs cap (probed)
  let lo = BigInt(state.scannedTo + 1);
  const relevant: unknown[] = state.logs;
  while (lo <= latest) {
    const hi = lo + BigInt(CHUNK) - 1n > latest ? latest : lo + BigInt(CHUNK) - 1n;
    // adaptive: on a range/size error, halve the chunk; the RPC cap is authoritative
    let done = false;
    for (let chunk = hi - lo + 1n; chunk >= 1n; chunk = chunk / 2n) {
      const top = lo + chunk - 1n;
      try {
        const res = (await l1.request({ method: "eth_getLogs", params: [{ fromBlock: `0x${lo.toString(16)}`, toBlock: `0x${top.toString(16)}` }] })) as RawLog[];
        for (const raw of res) {
          const ev = BY_TOPIC.get(raw.topics[0] as Hash);
          if (!ev) continue;
          try {
            const decoded = decodeEventLog({ abi: [ev as never], data: raw.data as Hash, topics: raw.topics as [Hash] });
            const args = { ...decoded.args } as Record<string, unknown>;
            let display = args;
            if (raw.topics[0] === "0xb3813568d9991fc951961fcb4c784893574240a28925604d09fc577c55bb7c32") {
              // v2 deposit: decode packed opaqueData into human amounts
              const dd = opaqueDataToDepositData(args.opaqueData as Hash);
              display = { from: args.from, to: args.to, value: dd.value, mint: dd.mint, gasLimit: dd.gas, data: dd.data };
            }
            if (involves(display, address)) {
              relevant.push({ event: decoded.eventName, args: jsonArgs(display), block: raw.blockNumber, tx: raw.transactionHash, emitter: raw.address });
            }
          } catch { /* different event with same topic prefix — skip */ }
        }
        lo = top + 1n;
        done = true;
        break;
      } catch (e) {
        if (chunk <= 1n) throw e; // even 1 block failed — real error, surface it
      }
    }
    if (!done) throw new Error("chunking exhausted");
    writeFileSync(ckpt, JSON.stringify({ scannedTo: Number(lo) - 1, logs: relevant })); // every chunk — file is tiny, and resume is the whole point
  }
  writeFileSync(ckpt, JSON.stringify({ scannedTo: Number(latest), logs: relevant }));
  summarize(relevant, address, Number(from), Number(latest));
}

type RawLog = { topics: string[]; data: string; blockNumber: number; transactionHash: string; address: string };

function involves(args: Record<string, unknown>, address: string): boolean {
  const vals = Object.values(args).flat();
  return vals.some((v) => typeof v === "string" && v.toLowerCase() === address);
}

function jsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
}

function summarize(logs: unknown[], address: string, from: number, to: number) {
  let inWei = 0n, outFinalized = 0n;
  const deposits: unknown[] = [];
  const finalized: unknown[] = [];
  for (const l of logs as { event: string; args: Record<string, unknown>; block: number; tx: string; emitter: string }[]) {
    const wei = (v: unknown): bigint => BigInt((typeof v === "bigint" ? v.toString() : String(v ?? "0")));
    if (l.event === "TransactionDeposited") {
      // classic: value in tx tuple slot 0; v2: value decoded from opaqueData.
      // args may be bigint (fresh scan) or string (resumed from checkpoint) — normalize.
      inWei += l.args.value !== undefined ? wei(l.args.value) : wei((l.args.tx as { 0: unknown })[0]);
      deposits.push(l);
    } else if (l.event === "ETHDepositInitiated") {
      inWei += wei(l.args.amount);
      deposits.push(l);
    } else if (l.event === "ERC20DepositInitiated") {
      deposits.push(l);
    } else if (l.event === "WithdrawalFinalized") {
      outFinalized += 0n; // amount not in the event; finalizations are tracked by hash
      finalized.push(l);
    } else if (l.event === "SentMessage") {
      deposits.push(l);
    }
  }
  console.log(JSON.stringify({
    address,
    window: { fromBlock: from, toBlock: to },
    lowerBound: {
      note: "bridged-in minus nothing — finalization amounts are not in the finalized event; cross-check finalized hashes against the user's records. This is a LOWER BOUND, not the L2 balance.",
      bridgedInEth: Number(formatEther(inWei)),
      depositLogs: deposits.length,
      finalizedWithdrawalHashes: finalized.map((f) => (f as { args: { withdrawalHash?: string } }).args?.withdrawalHash),
    },
    logs: [...deposits, ...finalized],
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

await main();
