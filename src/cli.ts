/**
 * hatch CLI — the original spec's command surface, dispatching to the tools.
 *
 *   bun run hatch init <chain>            # probe (chains currently wired: op-sepolia,
 *                                         # op-mainnet, base, blast-mainnet, blast-sepolia)
 *   bun run hatch status                  # liveness + live withdrawal status (direct portal reads)
 *   bun run hatch scan <addr> [--blocks N|--days N]
 *   bun run hatch l2 <addr>               # L2 native/token balances + P1 unproven queue
 *   bun run hatch plan <chain> [--announce <date>] [--wd]
 *   bun run hatch initiate|prove|resolve|finalize|rebuild <args…>
 *   bun run hatch force-include --to <addr> --amount <eth> [--signer ledger|keystore]
 *   bun run hatch list
 *
 * Defaults: unsigned output (nothing sent). `--send` uses the throwaway testnet key;
 * `--signer ledger|keystore` emits exact cast commands instead of sending.
 * Exit codes: 0 ok · 2 usage · 3 gated (time not ripe, nothing sent).
 */
import { readFileSync } from "node:fs";

const TOOLS: Record<string, { file: string; note?: string; passVerb?: boolean }> = {
  init: { file: "src/probe.ts" },
  status: { file: "src/withdraw.ts", passVerb: true },
  "next-action": { file: "src/withdraw.ts", passVerb: true },
  scan: { file: "src/scan.ts" },
  l2: { file: "src/l2-reader.ts" },
  plan: { file: "src/plan.ts" },
  initiate: { file: "src/withdraw.ts", passVerb: true },
  prove: { file: "src/prove-super.ts", note: "super-roots prover (game type 9); oracle-era chains use the withdraw.ts prove path" },
  resolve: { file: "src/withdraw.ts", passVerb: true },
  finalize: { file: "src/withdraw.ts", passVerb: true },
  rebuild: { file: "src/withdraw.ts", passVerb: true },
  "force-include": { file: "src/force-include.ts" },
};

function list(): void {
  if (!readExists("withdrawals.json")) {
    console.log(JSON.stringify({ withdrawals: [], note: "no state file — nothing in flight" }, null, 2));
    return;
  }
  const states = JSON.parse(readFileSync("withdrawals.json", "utf8"));
  console.log(JSON.stringify({
    withdrawals: Object.values(states).map((s: Record<string, unknown>) => ({
      id: s.id,
      stage: s.stage,
      withdrawalHash: (s.withdrawal as { withdrawalHash?: string })?.withdrawalHash,
      l2Tx: s.l2Tx,
      proofTx: s.proofTx,
      finalizeTx: s.finalizeTx,
    })),
    tip: "bun run hatch next-action — what to do next, machine-readable",
  }, null, 2));
}

function readExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") {
    list();
    return;
  }
  if (!cmd || !TOOLS[cmd]) {
    console.error(`usage: bun src/cli.ts <${Object.keys(TOOLS).join("|")}|list> [args…]\n` +
      "defaults to unsigned output; --send = throwaway testnet key; --signer ledger|keystore = emit cast commands");
    process.exit(2);
  }
  const tool = TOOLS[cmd];
  // withdraw.ts-style tools take the verb as argv[2]; arg-first tools (scan/plan/…) don't
  const args = [tool.file, ...(tool.passVerb ? [cmd, ...rest] : rest)];
  const proc = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  process.exit(proc.exitCode ?? 0);
}

await main();
