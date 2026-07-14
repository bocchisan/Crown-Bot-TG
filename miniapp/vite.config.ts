// Bakes the chain profile into the static bundle: the mini app has no
// server to ask, and the asset canister serves exactly what was built.
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

function chainConfig() {
  const profile = process.env.CROWN_PROFILE ?? "testnet";
  const toml = readFileSync(new URL(`../config/${profile}.toml`, import.meta.url), "utf8");
  const value = (key: string): string =>
    toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
  return {
    chainId: value("id"),
    rpc: value("rpc"),
    factory: value("factory_stream"),
    usdc: value("usdc"),
    splitter: value("splitter"),
    treasury: value("treasury"),
    subscription: value("subscription"),
    crownIndex: value("crown_index"),
  };
}

export default defineConfig({
  define: { __CHAIN_CONFIG__: JSON.stringify(chainConfig()) },
  build: { target: "es2022" },
});
