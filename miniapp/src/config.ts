// The chain context of the page: baked from config/<profile>.toml at build
// time (vite define). Canister principals and hosts may be overridden by
// the page parameters only while the baked value is empty — i.e. during
// devnet development; a production build carries everything.

import { Connection, PublicKey } from "@solana/web3.js";
import { HttpAgent } from "@dfinity/agent";

import { subscriptionActor, type ChainAddresses } from "@crown/core";
import type { FlowContext } from "./flows.ts";

declare const __CHAIN_CONFIG__: {
  chainId: string;
  rpc: string;
  factory: string;
  usdc: string;
  splitter: string;
  treasury: string;
  subscription: string;
  crownIndex: string;
};

export interface PageParams {
  action: string;
  payload: Record<string, string>;
}

/** #<action>=<base64url(JSON)> — the bot builds these links. */
export function parseFragment(hash: string): PageParams | null {
  const match = /^#([a-z]+)=(.+)$/.exec(hash);
  if (!match || !match[1] || !match[2]) return null;
  // base64url → base64: swap the alphabet AND restore the padding atob demands.
  const b64 = match[2].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  );
  return { action: match[1], payload: JSON.parse(json) as Record<string, string> };
}

function overridable(baked: string, override: string | undefined, name: string): string {
  if (baked) return baked;
  if (override) return override;
  throw new Error(`${name} is neither baked nor provided`);
}

export async function buildContext(payload: Record<string, string>): Promise<FlowContext> {
  const config = __CHAIN_CONFIG__;
  const addresses: ChainAddresses = {
    factory: new PublicKey(config.factory),
    usdc: new PublicKey(config.usdc),
    splitter: new PublicKey(config.splitter),
    treasury: new PublicKey(config.treasury),
  };
  const subscriptionCanisterId = overridable(config.subscription, payload.subscription, "subscription canister");
  const host = overridable("", payload.icHost, "") || "https://icp-api.io";
  const agent = await HttpAgent.create({
    host,
    shouldFetchRootKey: host.includes("127.0.0.1") || host.includes("localhost"),
  });
  return {
    connection: new Connection(payload.rpc ?? config.rpc, "confirmed"),
    chainId: config.chainId,
    domain: `crown:stream:${config.chainId}`,
    addresses,
    subscription: subscriptionActor(agent, subscriptionCanisterId),
    subscriptionCanisterId,
  };
}

export function solanaChainOf(chainId: string): string {
  return chainId.replace("solana-", "solana:");
}

export function chainConfig(): typeof __CHAIN_CONFIG__ {
  return __CHAIN_CONFIG__;
}
