/**
 * hatch phase-0 probe: read-only architecture discovery for an OP Stack chain.
 *
 * Usage: bun src/probe.ts <blast-mainnet|blast-sepolia|op-sepolia|op-mainnet|base>
 * Reads RPC endpoints from .env (never committed). Writes chains/<name>.probe.json
 * and prints a human summary. Every fact is read from the chain; nothing is hardcoded
 * except the starting portal address (the registry/docs are a hint, never a source of truth).
 */
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import { readFileSync, writeFileSync } from "node:fs";

function envKey(name: string): string {
  const line = readFileSync(".env", "utf8")
    .split("\n")
    .find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} in .env`);
  return line.slice(name.length + 1).trim();
}

const ALCHEMY = {
  ethMainnet: (k: string) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
  ethSepolia: (k: string) => `https://eth-sepolia.g.alchemy.com/v2/${k}`,
  blastMainnet: (k: string) => `https://blast-mainnet.g.alchemy.com/v2/${k}`,
};

const K1 = envKey("ALCHEMY_KEY_PRIMARY");
const K2 = envKey("ALCHEMY_KEY_SECONDARY");

type Target = {
  name: string;
  l1Rpc: string;
  l2Rpc?: string;
  portal: Address;
  l1ChainId: number;
};

const TARGETS: Record<string, Target> = {
  "blast-mainnet": {
    name: "blast-mainnet",
    l1Rpc: ALCHEMY.ethMainnet(K1),
    l2Rpc: ALCHEMY.blastMainnet(K1),
    portal: "0x0Ec68c5B10F21EFFb74f2A5C61DFe6b08C0Db6Cb",
    l1ChainId: 1,
  },
  "blast-sepolia": {
    name: "blast-sepolia",
    l1Rpc: ALCHEMY.ethSepolia(K2),
    l2Rpc: `https://blast-sepolia.g.alchemy.com/v2/${K2}`,
    portal: "0x2757E4430e694F27b73EC9C02257cab3a498C8C5",
    l1ChainId: 11155111,
  },
  "op-sepolia": {
    name: "op-sepolia",
    l1Rpc: ALCHEMY.ethSepolia(K2),
    l2Rpc: `https://opt-sepolia.g.alchemy.com/v2/${K1}`,
    portal: "0x16Fc5058F25648194471939df75CF27A2fdC48BC",
    l1ChainId: 11155111,
  },
  "op-mainnet": {
    name: "op-mainnet",
    l1Rpc: ALCHEMY.ethMainnet(K1),
    portal: "0xbEb5Fc579115071764c7423A4f12eDde41f106Ed",
    l1ChainId: 1,
  },
  base: {
    name: "base",
    l1Rpc: ALCHEMY.ethMainnet(K1),
    portal: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e",
    l1ChainId: 1,
  },
};

// ABIs assembled from every version's candidate surface; calls that miss are
// caught and recorded as null. That is the point of the probe: the chain tells
// us which surface it has.
const PORTAL_ABI = [
  { name: "version", type: "function", stateMutability: "view", outputs: [{ type: "string" }], inputs: [] },
  { name: "l2Oracle", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "systemConfig", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "disputeGameFactory", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "respectedGameType", type: "function", stateMutability: "view", outputs: [{ type: "uint32" }], inputs: [] },
  { name: "proofMaturityDelaySeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "finalizationPeriodSeconds", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "superchainConfig", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "paused", type: "function", stateMutability: "view", outputs: [{ type: "bool" }], inputs: [] },
] as const satisfies Abi;

const ORACLE_ABI = [
  { name: "version", type: "function", stateMutability: "view", outputs: [{ type: "string" }], inputs: [] },
  { name: "FINALIZATION_PERIOD_SECONDS", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "proposer", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "challenger", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
  { name: "latestOutputIndex", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "latestBlockNumber", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "startingBlockNumber", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "l2BlockTime", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  {
    name: "getL2Output",
    type: "function",
    stateMutability: "view",
    outputs: [
      { type: "bytes32", name: "outputRoot" },
      { type: "uint128", name: "timestamp" },
      { type: "uint128", name: "l2BlockNumber" },
    ],
    inputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

const DGF_ABI = [
  { name: "gameCount", type: "function", stateMutability: "view", outputs: [{ type: "uint256" }], inputs: [] },
  { name: "gameImpls", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [{ type: "uint32" }] },
  {
    name: "findLatestGames",
    type: "function",
    stateMutability: "view",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { type: "uint256", name: "index" },
          { type: "bytes32", name: "metadata" }, // GameId: packs gameType, timestamp, gameProxy
          { type: "uint64", name: "timestamp" },
          { type: "bytes32", name: "rootClaim" },
          { type: "bytes", name: "extraData" },
        ],
      },
    ],
    inputs: [
      { type: "uint32" },
      { type: "uint256", name: "start" },
      { type: "uint256", name: "n" },
    ],
  },
] as const satisfies Abi;

const SYSTEM_CONFIG_ABI = [
  { name: "version", type: "function", stateMutability: "view", outputs: [{ type: "string" }], inputs: [] },
  { name: "owner", type: "function", stateMutability: "view", outputs: [{ type: "address" }], inputs: [] },
] as const satisfies Abi;

async function tryCall<T>(
  label: string,
  results: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    const v = await fn();
    results[label] = v as unknown;
    return v;
  } catch (e) {
    results[label] = { error: String(e).slice(0, 160) };
    return null;
  }
}

function chain(chainId: number, rpc: string) {
  return defineChain({ id: chainId, name: "probe", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
}

async function probe(target: Target): Promise<Record<string, unknown>> {
  const client: PublicClient = createPublicClient({ chain: chain(target.l1ChainId, target.l1Rpc), transport: http(target.l1Rpc) });
  const out: Record<string, unknown> = {};
  out.name = target.name;
  out.probedAt = new Date().toISOString();
  const portalAddr = getAddress(target.portal.toLowerCase());
  out.portal = portalAddr;

  const l1Block = await client.getBlock({ blockTag: "latest" });
  out.l1BlockAtProbe = { number: l1Block.number, timestamp: l1Block.timestamp };

  const read = <T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;

  await tryCall("portal.version", out, () => read<string>(portalAddr, PORTAL_ABI, "version"));
  const systemConfigAddr = await tryCall("portal.systemConfig", out, () => read<Address>(portalAddr, PORTAL_ABI, "systemConfig"));
  const oracleAddr = await tryCall("portal.l2Oracle", out, () => read<Address>(portalAddr, PORTAL_ABI, "l2Oracle"));
  const dgfAddr = await tryCall("portal.disputeGameFactory", out, () => read<Address>(portalAddr, PORTAL_ABI, "disputeGameFactory"));

  if (typeof oracleAddr === "string" && oracleAddr !== "0x0000000000000000000000000000000000000000") {
    out.class = "A (L2OutputOracle)";
    out.oracle = oracleAddr;
    await tryCall("oracle.version", out, () => read<string>(oracleAddr, ORACLE_ABI, "version"));
    const finPeriod = await tryCall("oracle.FINALIZATION_PERIOD_SECONDS", out, () => read<bigint>(oracleAddr, ORACLE_ABI, "FINALIZATION_PERIOD_SECONDS"));
    await tryCall("oracle.proposer", out, () => read<Address>(oracleAddr, ORACLE_ABI, "proposer"));
    await tryCall("oracle.challenger", out, () => read<Address>(oracleAddr, ORACLE_ABI, "challenger"));
    await tryCall("oracle.l2BlockTime", out, () => read<bigint>(oracleAddr, ORACLE_ABI, "l2BlockTime"));
    await tryCall("oracle.startingBlockNumber", out, () => read<bigint>(oracleAddr, ORACLE_ABI, "startingBlockNumber"));
    const latestIdx = await tryCall("oracle.latestOutputIndex", out, () => read<bigint>(oracleAddr, ORACLE_ABI, "latestOutputIndex"));
    if (typeof latestIdx === "bigint") {
      const latest = await tryCall("oracle.latestOutput", out, () => read<[bigint, bigint, bigint]>(oracleAddr, ORACLE_ABI, "getL2Output", [latestIdx]));
      if (Array.isArray(latest)) {
        const [root, ts, l2Block] = latest as [bigint, bigint, bigint];
        const staleness = Number(l1Block.timestamp) - Number(ts);
        out.liveness = {
          latestRootCoversL2Block: Number(l2Block),
          rootPostedAtL1Timestamp: Number(ts),
          secondsSinceLastRoot: staleness,
          human: staleness < 3600 ? `fresh (${Math.round(staleness / 60)}m ago)` : `${(staleness / 3600).toFixed(1)}h ago`,
        };
        // posting cadence from the last few roots — distinguishes "slow but alive"
        // from "stopped", which changes the deadline story.
        const stamps: number[] = [Number(ts)];
        for (let i = 1; i <= 4; i++) {
          const prev = await tryCall(`oracle.output-${latestIdx - BigInt(i)}`, out, () => read<[bigint, bigint, bigint]>(oracleAddr, ORACLE_ABI, "getL2Output", [latestIdx - BigInt(i)]));
          if (Array.isArray(prev)) stamps.push(Number((prev as [bigint, bigint, bigint])[1]));
        }
        if (stamps.length > 1) {
          const gaps = stamps.slice(1).map((s, i) => stamps[i] - s);
          out.proposerCadence = { sampledRoots: stamps.length, avgGapSeconds: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), maxGapSeconds: Math.max(...gaps) };
        }
        if (typeof finPeriod === "bigint") {
          out.deadlineMath = {
            finalizationSeconds: Number(finPeriod),
            note: "class A: deadline = last root covering the user's block; once PROVEN, finalize needs no further proposer activity (timestamps only)",
          };
        }
      }
    }
  }

  if (typeof dgfAddr === "string" && dgfAddr !== "0x0000000000000000000000000000000000000000") {
    out.class = out.class ? "hybrid?" : "B/C (DisputeGameFactory)";
    out.disputeGameFactory = dgfAddr;
    const gameType = await tryCall("portal.respectedGameType", out, () => read<bigint>(target.portal, PORTAL_ABI, "respectedGameType"));
    await tryCall("portal.proofMaturityDelaySeconds", out, () => read<bigint>(target.portal, PORTAL_ABI, "proofMaturityDelaySeconds"));
    await tryCall("portal.finalizationPeriodSeconds", out, () => read<bigint>(target.portal, PORTAL_ABI, "finalizationPeriodSeconds"));
    const scAddr = await tryCall("portal.superchainConfig", out, () => read<Address>(target.portal, PORTAL_ABI, "superchainConfig"));
    if (typeof scAddr === "string" && scAddr !== "0x0000000000000000000000000000000000000000") {
      const paused = await tryCall("superchainConfig.paused", out, () =>
        client.readContract({ address: scAddr, abi: [{ name: "paused", type: "function", stateMutability: "view", outputs: [{ type: "bool" }], inputs: [] }] as const, functionName: "paused" }),
      );
      out.withdrawalsPaused = paused === true;
    }
    if (typeof gameType === "bigint" || typeof gameType === "number") {
      const gt = BigInt(gameType);
      // respectedGameType 1 = PermissionedDisputeGame (class B), 0 = Permissionless (class C);
      // newer v5+ chains use higher game-type ids — the impl + agent research resolve those.
      out.gameTypeInterpretation = gt === 1n ? "1 => PermissionedDisputeGame (class B)" : gt === 0n ? "0 => PermissionlessDisputeGame (class C)" : `game type ${gt} (non-legacy; resolve permissioned-ness from impl source / agent research)`;
      await tryCall("dgf.gameImpls", out, () => read<Address>(dgfAddr, DGF_ABI, "gameImpls", [gt]));
      const count = await tryCall("dgf.gameCount", out, () => read<bigint>(dgfAddr, DGF_ABI, "gameCount"));
      // findLatestGames searches the global game list backwards from `start`,
      // returning up to `n` games of the wanted type.
      if (typeof count === "bigint" && count > 0n) {
        const results = await tryCall("dgf.findLatestGames", out, () =>
          read<{ index: bigint; metadata: `0x${string}`; timestamp: bigint }[]>(dgfAddr, DGF_ABI, "findLatestGames", [gt, count - 1n, 3n]),
        );
        if (Array.isArray(results) && results.length > 0) {
          const g = results[0]; // search goes backwards, so [0] is the most recent
          const gameProxy = ("0x" + g.metadata.slice(26)) as Address;
          const staleness = Number(l1Block.timestamp) - Number(g.timestamp);
          out.liveness = {
            latestGameIndex: Number(g.index),
            latestGameProxy: gameProxy,
            gameCreatedAtL1Timestamp: Number(g.timestamp),
            secondsSinceLastGame: staleness,
            human: staleness < 3600 ? `fresh (${Math.round(staleness / 60)}m ago)` : `${(staleness / 3600).toFixed(1)}h ago`,
          };
        } else {
          out.liveness = { human: `no games of respected type found scanning back from index ${count} — widen the search before declaring the chain dead`, gameCount: count?.toString() };
        }
      }
    }
  }

  if (typeof systemConfigAddr === "string" && systemConfigAddr !== "0x0000000000000000000000000000000000000000") {
    out.systemConfig = systemConfigAddr;
    await tryCall("systemConfig.version", out, () => read<string>(systemConfigAddr, SYSTEM_CONFIG_ABI, "version"));
    await tryCall("systemConfig.owner", out, () => read<Address>(systemConfigAddr, SYSTEM_CONFIG_ABI, "owner"));
  }

  if (target.l2Rpc) {
    try {
      const l2 = createPublicClient({ chain: chain(0, target.l2Rpc), transport: http(target.l2Rpc) });
      out.l2 = {
        chainId: await l2.getChainId(),
        blockNumber: await l2.getBlockNumber(),
        latestBlockTimestamp: Number((await l2.getBlock({ blockTag: "latest" })).timestamp),
        secondsSinceLatestBlock: Math.floor(Date.now() / 1000) - Number((await l2.getBlock({ blockTag: "latest" })).timestamp),
      };
    } catch (e) {
      out.l2 = { error: String(e).slice(0, 160) };
    }
  }

  return out;
}

const name = process.argv[2];
if (!name || !TARGETS[name]) {
  console.error(`usage: bun src/probe.ts <${Object.keys(TARGETS).join("|")}>`);
  process.exit(2);
}

const bigintJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const result = await probe(TARGETS[name]);
writeFileSync(`chains/${name}.probe.json`, JSON.stringify(result, bigintJson, 2) + "\n");
console.log(JSON.stringify(result, bigintJson, 2));
