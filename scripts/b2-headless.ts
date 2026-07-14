// B2 headless verification: drives the mini app's OWN flow code
// (miniapp/src/flows.ts) with file keypairs against devnet and a live
// subscription canister. Covers everything of the B2 checklist except the
// browser-wallet UI and the Telegram sendData path.
//
// Env: SUBSCRIPTION_CANISTER (required), IC_HOST, RPC_URL, DONOR_KEYPAIR,
//      OWNER_KEYPAIR, PERIOD, PRICE, MONTHS.
// Run: npx tsx scripts/b2-headless.ts   (scripts/b2-devnet.sh orchestrates)

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { HttpAgent } from "@dfinity/agent";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  channelId as deriveChannelId,
  fetchEscrow,
  hex,
  subscriptionActor,
  type ChainAddresses,
} from "../core/src/index.ts";
import {
  cancelFlow,
  collectFlow,
  findDueChunks,
  subscribeFlow,
  type FlowContext,
  type WalletSigner,
} from "../miniapp/src/flows.ts";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`env ${name} is required`);
  return value;
}

/** A WalletSigner over a standard solana keypair file — the verifier's wallet. */
function fileWallet(path: string): WalletSigner & { keypair: Keypair } {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const keypair = Keypair.fromSecretKey(bytes);
  const secret = bytes.slice(0, 32);
  return {
    keypair,
    publicKey: keypair.publicKey.toBytes(),
    signMessage: (message) => Promise.resolve(ed25519.sign(message, secret)),
    signTransactions: (transactions) =>
      Promise.resolve(
        transactions.map((transaction) => {
          transaction.sign(keypair);
          return new Uint8Array(transaction.serialize());
        }),
      ),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main(): Promise<void> {
  const rpc = env("RPC_URL", "https://api.devnet.solana.com");
  const icHost = env("IC_HOST", "http://127.0.0.1:4943");
  const subscriptionCanisterId = env("SUBSCRIPTION_CANISTER");
  const donor = fileWallet(env("DONOR_KEYPAIR", `${env("HOME")}/.cache/crown-e2e/donor.json`));
  const owner = fileWallet(env("OWNER_KEYPAIR", `${env("HOME")}/.cache/crown-e2e/streamer.json`));
  const period = BigInt(env("PERIOD", "45"));
  const price = BigInt(env("PRICE", "40000"));
  const months = Number(env("MONTHS", "3"));

  // Preflight: both wallets pay their own gas (the platform's model); a
  // zero-SOL wallet fails later with an opaque simulation error.
  const probe = new Connection(rpc, "confirmed");
  for (const [name, signer] of [
    ["donor", donor],
    ["owner", owner],
  ] as const) {
    const lamports = await probe.getBalance(new PublicKey(signer.publicKey));
    assert(lamports > 5_000_000, `${name} wallet needs SOL for gas (${lamports} lamports)`);
  }

  const agent = await HttpAgent.create({ host: icHost, shouldFetchRootKey: true });
  const context: FlowContext = {
    connection: new Connection(rpc, "confirmed"),
    chainId: "solana-devnet",
    domain: "crown:stream:solana-devnet",
    addresses: {
      factory: new PublicKey("2pezd2u8LFMFULRzV2ygdRmH6BNxxU4AoeD8RSGgCdxv"),
      usdc: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
      splitter: new PublicKey("3R4dk7uuLt5rnuD95roDhQkt2ZKV9xMAFjfx1Eb96nxP"),
      treasury: new PublicKey("3it64t7KXNip1C1BRYNh8ygeKyujWnaQrPSj3hV9TWbE"),
    } satisfies ChainAddresses,
    subscription: subscriptionActor(agent, subscriptionCanisterId),
    subscriptionCanisterId,
  };

  // The channel, exactly as the bot would set it up (bot-spec §2).
  const id = deriveChannelId(-1009999n, owner.publicKey, BigInt(Date.now()));
  const resolver = await context.subscription.get_resolver(context.chainId, id);
  if ("Err" in resolver) throw new Error(`get_resolver: ${resolver.Err}`);
  // Full values: a failed run must stay recoverable (cancel needs the
  // channel id — it is the canister's derivation path).
  console.log(`channel ${hex(id)}`);
  console.log(`resolver ${hex(resolver.Ok)}`);
  const channel = {
    resolver: resolver.Ok,
    policy: { owner: owner.publicKey, price, period, threshold: 0n },
  };

  console.log("== subscribe: one escrow, chunk 0 due at once (nonce = t0)");
  const { escrow } = await subscribeFlow(channel, months, donor, context);
  console.log(`escrow ${escrow.toBase58()}`);

  console.log("== collect #1: exactly chunk 0 is due");
  const first = await collectFlow(id, channel, owner, context);
  assert(first.released.length === 1, `expected 1 due chunk, got ${first.released.length}`);
  assert(first.released[0]?.index === 0, "the due chunk is index 0");
  let state = await fetchEscrow(context.connection, escrow);
  assert(state !== null && state.released === 1 && !state.settled, "released=1 after collect #1");

  console.log(`== wait one period (${period}s) for chunk 1`);
  await sleep(Number(period) * 1000 + 5000);

  console.log("== collect #2: exactly chunk 1 is due");
  const second = await collectFlow(id, channel, owner, context);
  assert(second.released.length === 1, `expected 1 due chunk, got ${second.released.length}`);
  assert(second.released[0]?.index === 1, "the due chunk is index 1");
  state = await fetchEscrow(context.connection, escrow);
  assert(state !== null && state.released === 2 && !state.settled, "released=2 after collect #2");

  console.log("== cancel: the donor's word alone, the remainder returns");
  await cancelFlow(id, escrow, donor, context);
  state = await fetchEscrow(context.connection, escrow);
  assert(state !== null && state.settled, "terminal after cancel");

  const remaining = await findDueChunks(channel, context);
  assert(
    remaining.every((chunk) => !chunk.escrow.equals(escrow)),
    "a settled escrow yields no due chunks",
  );

  console.log("b2 headless OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
