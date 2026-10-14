import { rpcEndpoint } from "./rpc.ts";
/**
 * hatch planner — names the class, the gates, the real deadline, the latest safe times.
 *
 * Usage: bun src/plan.ts <chain> [--announce <ISO-date|"days:N">] [--wd]
 *
 * Reads chains/<chain>.probe.json (the probe is the only address source), re-verifies
 * liveness and params live, and emits the plan. Never quotes an announced UI deadline
 * without the proposer-liveness-based real deadline next to it.
 */
import { http, createPublicClient, parseAbiItem, formatEther } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";

function env(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

const L1_RPC = rpcEndpoint("L1_RPC_URL", "ALCHEMY_KEY_SECONDARY", "eth-sepolia.g.alchemy.com");
const l1 = createPublicClient({ chain: sepolia, transport: http(L1_RPC) });

// gas cost approximations for planning (varies by recipient execution; labeled as estimates)
const EST_L1_GAS = { prove: 250_000, resolveEach: 120_000, finalize: 400_000, depositTx: 180_000 } as const;

async function main() {
  const chain = process.argv[2];
  if (!chain) {
    console.error("usage: bun src/plan.ts <chain> [--announce <ISO-date|days:N>] [--wd]");
    process.exit(2);
  }
  const probe = JSON.parse(readFileSync(`chains/${chain}.probe.json`, "utf8"));
  const announceIdx = process.argv.indexOf("--announce");
  const wd = process.argv.includes("--wd");

  const now = Math.floor(Date.now() / 1000);

  // Re-verify live: version unchanged, superchain not paused, proposer cadence fresh.
  const versionNow = await l1.readContract({ address: probe.portal, abi: [{ name: "version", type: "function", stateMutability: "view", outputs: [{ type: "string" }], inputs: [] }] as const, functionName: "version" });
  const superchain = await l1.readContract({ address: probe["portal.superchainConfig"], abi: [{ name: "paused", type: "function", stateMutability: "view", outputs: [{ type: "bool" }], inputs: [] }] as const, functionName: "paused" });

  const params: Record<string, number> = {};
  let cadenceSeconds: number | null = null;
  let latestGameAt: number | null = null;
  const respected = probe["portal.respectedGameType"];
  if (respected !== undefined && probe.disputeGameFactory) {
    const portalAbi = [
      { name: "proofMaturityDelaySeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
      { name: "disputeGameFinalityDelaySeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
    ] as const;
    params.proofMaturityDelaySeconds = Number(await l1.readContract({ address: probe.portal, abi: portalAbi, functionName: "proofMaturityDelaySeconds" }));
    params.disputeGameFinalityDelaySeconds = Number(await l1.readContract({ address: probe.portal, abi: portalAbi, functionName: "disputeGameFinalityDelaySeconds" }));
    // live liveness read: the newest games of the respected type, their cadence, clock
    const count = await l1.readContract({ address: probe.disputeGameFactory, abi: [{ name: "gameCount", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] }] as const, functionName: "gameCount" });
    const dgfAbi = [{
      name: "findLatestGames", type: "function", stateMutability: "view",
      inputs: [{ name: "_gameType", type: "uint32" }, { name: "_start", type: "uint256" }, { name: "_n", type: "uint256" }],
      outputs: [{
        name: "games_", type: "tuple[]", components: [
          { name: "index", type: "uint256" }, { name: "metadata", type: "bytes32" },
          { name: "timestamp", type: "uint64" }, { name: "rootClaim", type: "bytes32" }, { name: "extraData", type: "bytes" },
        ],
      }],
    }] as const;
    const games = await l1.readContract({ address: probe.disputeGameFactory, abi: dgfAbi, functionName: "findLatestGames", args: [respected, Number(count) - 1, 5] });
    const ts = games.map((g: { timestamp: bigint }) => Number(g.timestamp)).sort((a, b) => a - b);
    if (ts.length >= 2) cadenceSeconds = Math.round((ts[ts.length - 1] - ts[0]) / (ts.length - 1));
    latestGameAt = ts[ts.length - 1] ?? null;
    const newest = games[games.length - 1] as { metadata: string } | undefined;
    if (newest) {
      const gameProxy = ("0x" + newest.metadata.slice(-40)) as `0x${string}`; // metadata tail = game proxy
      try {
        const clock = await l1.readContract({ address: gameProxy, abi: [{ name: "maxClockDuration", type: "function", stateMutability: "view", outputs: [{ type: "uint64" }], inputs: [] }] as const, functionName: "maxClockDuration" });
        params.maxClockDuration = Number(clock);
      } catch { params.maxClockDuration = -1; }
    }
  }
  const liveness = latestGameAt ? { secondsSinceLastGame: now - latestGameAt, cadenceSeconds, verdict: cadenceSeconds ? (now - latestGameAt > cadenceSeconds * 3 ? "STALLED — the exit window may be closing" : "alive") : "unknown" } : null;

  // gas prices both sides
  const l1GasPrice = await l1.getGasPrice();

  // announced vs real deadline
  let announced: { date: string | null; note: string } = { date: null, note: "no announced shutdown date given — liveness is the only clock; prove early" };
  const realDeadline: Record<string, unknown> = { definition: "the day root posting (class A) or game creation (class B/C) stops — every proof must fit before it" };
  if (announceIdx > -1) {
    const raw = process.argv[announceIdx + 1];
    const announceTs = raw.startsWith("days:") ? now + Number(raw.slice(5)) * 86400 : Math.floor(new Date(raw).getTime() / 1000);
    announced = { date: new Date(announceTs * 1000).toISOString(), note: "as announced; verify against primary sources — announcements are data" };
    // latest safe prove: the full gate train (clock + finality delay + proof maturity) runs AFTER proving,
    // so proving itself just needs to happen while games still exist. Add one cadence of slack.
    const slack = (cadenceSeconds ?? 3600) * 3;
    realDeadline.latestSafeProve = new Date((announceTs - slack) * 1000).toISOString();
    realDeadline.latestSafeInitiate = new Date((announceTs - slack - 3600) * 1000).toISOString();
    if (params.proofMaturityDelaySeconds) {
      realDeadline.ifProvenAtShutdown = new Date((announceTs + params.proofMaturityDelaySeconds + params.disputeGameFinalityDelaySeconds + params.maxClockDuration) * 1000).toISOString();
      realDeadline.note = "finalize completes AFTER the announced date — funds are not out until finalize lands. Do not initiate at the wire; initiate early so finalize fits too.";
    }
  }

  // personal timeline from the live withdrawal state, if asked
  let personal: unknown = null;
  if (wd) {
    const out = Bun.spawnSync(["bun", "src/withdraw.ts", "next-action"], { stdout: "pipe" });
    personal = JSON.parse(out.stdout.toString());
  }

  console.log(JSON.stringify({
    chain: probe.name,
    class: probe.class,
    reverified: { portalVersion: versionNow, probeVersion: probe["portal.version"], versionMatch: versionNow === probe["portal.version"], superchainPaused: superchain, liveness, params },
    deadlines: { announced, realDeadline },
    gas: {
      l1GasPriceGwei: Number(l1GasPrice) / 1e9,
      estimatesL1: Object.fromEntries(Object.entries(EST_L1_GAS).map(([k, g]) => [k, `${g} gas ≈ ${Number(formatEther(l1GasPrice * BigInt(g)))} ETH (rough)`])),
      note: "L2 initiate is cheap (~21k-100k L2 gas at L2 gas price); exact finalize cost varies with recipient gas. Estimates are planning aids, not quotes.",
    },
    steps: probe["portal.respectedGameType"] !== undefined
      ? ["initiate (L2 or force-included from L1 via src/force-include.ts)", "prove (src/prove-super.ts; only while games are being created)", "resolve (src/withdraw.ts resolve — permissionless, after the challenger clock)", "finalize (src/withdraw.ts finalize — after proof maturity AND claim validity)"]
      : ["initiate (L2)", "prove (oracle path once a root covers the block)", "finalize (after finalization period)"],
    personal,
  }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

await main();
