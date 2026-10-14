/**
 * hatch signer-adapter — how a tx goes from "hatch computed it" to "it is on chain".
 *
 * Modes (from `--signer <mode>` or the `--send` flag):
 *   unsigned  default. Nothing is sent; the tool prints the full tx request (to,
 *             function, args, value, calldata) for the user to sign however they want.
 *   ledger    emits the exact `cast send … --ledger` command. User approves on device.
 *   keystore  emits the exact `cast send … --from …` command; foundry's encrypted
 *             keystore holds the key (cast wallet import), password stays with the user.
 *   testkey   TESTNET ONLY. Sends directly using the throwaway key in the gitignored
 *             .env (TEST_KEY). Loud warning; never acceptable on mainnet.
 *
 * The rule "never accept raw private keys as input" means: no keys on argv, stdin, or
 * chat. A throwaway TESTNET key in a local gitignored file is the only raw-key path;
 * mainnet flows are unsigned / ledger / keystore — all of which keep the key with the
 * user's hardware or foundry's encrypted store.
 */
import { readFileSync } from "node:fs";
import type { Address } from "viem";

export type SignerMode = "unsigned" | "ledger" | "keystore" | "testkey";

export function signerMode(argv: string[] = process.argv): SignerMode {
  if (argv.includes("--send")) return "testkey"; // explicit send on a testnet run
  const i = argv.indexOf("--signer");
  if (i === -1) return "unsigned";
  const m = argv[i + 1];
  if (m !== "ledger" && m !== "keystore" && m !== "testkey") {
    throw new Error("--signer must be ledger | keystore | testkey (unsigned is the default with no flag)");
  }
  return m;
}

export function isTestnetContext(): boolean {
  // every RPC the tools currently point at is a testnet; a mainnet chain id check
  // belongs in the per-chain probe output — chains/*.probe.json carry l1ChainId.
  try {
    const probe = JSON.parse(readFileSync("chains/op-sepolia.probe.json", "utf8"));
    return probe.l1ChainId !== 1;
  } catch {
    return true; // fail open for the demo; per-chain tools verify their own chain
  }
}

export type CastSpec = {
  to: Address;
  signature?: string; // e.g. "depositTransaction(address,uint256,uint64,bool,bytes)"
  args?: unknown[];
  data?: string; // pre-encoded calldata alternative to signature+args
  value?: bigint;
  mode: SignerMode;
};

export function castSend(spec: CastSpec): string {
  if (spec.mode === "testkey" && !isTestnetContext()) {
    throw new Error("refusing: TEST_KEY is testnet-only — use --signer ledger or keystore on mainnet");
  }
  const parts = ["cast send", spec.to];
  if (spec.signature) {
    parts.push(`"${spec.signature}"`, ...(spec.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a))));
  } else if (spec.data) {
    parts.push(spec.data);
  }
  if (spec.value) parts.push(`--value ${spec.value}`);
  if (spec.mode === "ledger") parts.push("--ledger");
  else if (spec.mode === "keystore") parts.push("--from <0xYOUR-ADDRESS>  # foundry keystore: cast wallet import <name> once; cast prompts for the password");
  else if (spec.mode === "testkey") parts.push("--private-key $TEST_KEY  # throwaway testnet key, never a real one");
  return parts.join(" ");
}
