/**
 * Shared RPC endpoint resolution. Accepts EITHER a full provider URL
 * (`https://opt-mainnet.g.alchemy.com/v2/<key>`, Infura, anything JSON-RPC over
 * https) OR a bare Alchemy key, in the same env var. Full URLs win — that's what
 * users naturally paste. Fallback is the known-good Alchemy pattern for the key.
 */
import { readFileSync } from "node:fs";

export function rpcEndpoint(name: string, fallbackKeyEnv: string, fallbackUrl: string): string {
  let line: string | undefined;
  try {
    line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  } catch { /* no .env — fall through to key env */ }
  const fromEndpoint = line?.slice(name.length + 1).trim();
  if (fromEndpoint?.startsWith("http")) return fromEndpoint;
  const key = fromEndpoint ?? keyFromEnv(fallbackKeyEnv);
  if (key.startsWith("http")) return key; // user pasted a whole URL into the key slot — fine
  return `https://${fallbackUrl}/v2/${key}`;
}

function keyFromEnv(name: string): string {
  const line = readFileSync(".env", "utf8").split("\n").find((l) => l.startsWith(name + "="));
  if (!line) throw new Error(`missing ${name} (or ${name.replace("ALCHEMY_KEY_", "RPC_URL_")}) in .env`);
  return line.slice(name.length + 1).trim();
}
