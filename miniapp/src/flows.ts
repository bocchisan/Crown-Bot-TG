// The three money flows and the link flow (docs/bot-spec.md §3, §6) as pure
// functions over a wallet interface, a connection and the canister actors.
// No DOM, no Telegram here: the page wires them to buttons, the headless
// verifier drives the very same code with file keypairs.

import type { Connection } from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Principal } from "@dfinity/principal";
import {
  ata,
  cancelAuthorization,
  cancelIx,
  cancelMessage,
  createEscrowIx,
  decodeEscrow,
  ed25519VerifyIx,
  escrowFilters,
  findEscrows,
  releaseIx,
  releaseMessage,
  subscriptionAlive,
  utf8,
  type ChainAddresses,
  type ChannelPolicy,
  type EscrowAccount,
  type StreamBirth,
  type SubscriptionActor,
} from "@crown/core";

/** What the page gets from a connected wallet — and the verifier from a file. */
export interface WalletSigner {
  publicKey: Uint8Array;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Signs every transaction; returns the wire bytes, order preserved. */
  signTransactions(transactions: Transaction[]): Promise<Uint8Array[]>;
}

export interface FlowContext {
  connection: Connection;
  chainId: string;
  /** "crown:stream:<chainId>" — the shape's message domain. */
  domain: string;
  addresses: ChainAddresses;
  subscription: SubscriptionActor;
  subscriptionCanisterId: string;
}

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

async function sendSigned(context: FlowContext, wire: Uint8Array): Promise<string> {
  const signature = await context.connection.sendRawTransaction(wire);
  const latest = await context.connection.getLatestBlockhash();
  await context.connection.confirmTransaction({ signature, ...latest });
  return signature;
}

async function prepared(context: FlowContext, payer: Uint8Array): Promise<Transaction> {
  const transaction = new Transaction();
  transaction.feePayer = new PublicKey(payer);
  const { blockhash } = await context.connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  return transaction;
}

/** The full declared birth of an escrow our client created: nonce = t0. */
function birthOf(escrow: EscrowAccount): {
  donor: Uint8Array;
  recipients: Uint8Array[];
  shares: number[];
  chunk: bigint;
  nChunks: number;
  t0: bigint;
  period: bigint;
  nonce: bigint;
} {
  return {
    donor: escrow.donor,
    recipients: escrow.recipients,
    shares: escrow.shares,
    chunk: escrow.chunk,
    nChunks: escrow.nChunks,
    t0: escrow.t0,
    period: escrow.period,
    nonce: BigInt.asUintN(64, escrow.t0),
  };
}

// ---- link ---------------------------------------------------------------

export interface LinkResult {
  wallet: string;
  signature: string;
  nonce: string;
}

/** Signs the bot's challenge; the result rides back via sendData (§3). */
export async function linkFlow(challengeText: string, wallet: WalletSigner): Promise<LinkResult> {
  const nonceLine = challengeText.split("\n").find((line) => line.startsWith("nonce: "));
  if (!nonceLine) throw new Error("malformed challenge: no nonce");
  const signature = await wallet.signMessage(utf8(challengeText));
  return {
    wallet: new PublicKey(wallet.publicKey).toBase58(),
    signature: Buffer.from(signature).toString("base64"),
    nonce: nonceLine.slice("nonce: ".length),
  };
}

// ---- subscribe ----------------------------------------------------------

export interface ChannelParams {
  resolver: Uint8Array;
  policy: ChannelPolicy;
}

/**
 * One escrow of `months` periods, chunk 0 due at once. nonce = t0
 * (bot-spec §6); an address collision moves t0 by one second.
 */
export async function subscribeFlow(
  channel: ChannelParams,
  months: number,
  wallet: WalletSigner,
  context: FlowContext,
): Promise<{ escrow: PublicKey; signature: string }> {
  if (months < 1) throw new Error("at least one period");
  let t0 = nowSeconds();
  for (let attempt = 0; ; attempt++) {
    const birth: StreamBirth = {
      donor: wallet.publicKey,
      recipients: [channel.policy.owner],
      shares: [10_000],
      chunk: channel.policy.price,
      nChunks: months,
      t0,
      period: channel.policy.period,
      resolver: channel.resolver,
      nonce: t0,
    };
    const { instruction, escrow } = createEscrowIx(birth, context.addresses);
    const existing = await context.connection.getAccountInfo(escrow);
    if (existing !== null) {
      if (attempt >= 3) throw new Error("escrow address keeps colliding");
      t0 += 1n;
      continue;
    }
    const transaction = (await prepared(context, wallet.publicKey)).add(instruction);
    const [wire] = await wallet.signTransactions([transaction]);
    if (!wire) throw new Error("wallet returned no transaction");
    const signature = await sendSigned(context, wire);
    return { escrow, signature };
  }
}

// ---- collect ------------------------------------------------------------

export interface DueChunk {
  escrow: PublicKey;
  index: number;
}

/** Every due, unreleased chunk of every live escrow of the channel. */
export async function findDueChunks(
  channel: ChannelParams,
  context: FlowContext,
): Promise<DueChunk[]> {
  const now = nowSeconds();
  const found = await findEscrows(
    context.connection,
    context.addresses.factory,
    escrowFilters({ resolver: channel.resolver }),
  );
  const due: DueChunk[] = [];
  for (const { address, escrow } of found) {
    if (escrow.settled) continue;
    for (let index = escrow.released; index < escrow.nChunks; index++) {
      if (escrow.t0 + BigInt(index) * escrow.period > now) break;
      due.push({ escrow: address, index });
    }
  }
  return due;
}

/**
 * The owner's one button (§6): a canister signature per due chunk, one
 * transaction per release, one wallet approval for the whole batch. Order
 * inside one escrow is strict — transactions are sent sequentially.
 */
export async function collectFlow(
  channelId: Uint8Array,
  channel: ChannelParams,
  wallet: WalletSigner,
  context: FlowContext,
): Promise<{ released: DueChunk[]; signatures: string[] }> {
  const due = await findDueChunks(channel, context);
  const transactions: Transaction[] = [];
  for (const chunk of due) {
    const account = await context.connection.getAccountInfo(chunk.escrow);
    if (!account) continue;
    const escrow = decodeEscrow(new Uint8Array(account.data));
    const signed = await context.subscription.request_release({
      chain: context.chainId,
      subscriptionId: channelId,
      ...birthOf(escrow),
      index: chunk.index,
    });
    if ("Err" in signed) throw new Error(`request_release: ${signed.Err}`);
    const message = releaseMessage(
      context.domain,
      context.addresses.factory,
      chunk.escrow,
      chunk.index,
    );
    // Recipient ATAs may not exist yet (a first-ever payout); idempotent
    // creation rides in front — the ed25519 entry must stay DIRECTLY before
    // release, that is the form's law.
    const transaction = await prepared(context, wallet.publicKey);
    const payer = new PublicKey(wallet.publicKey);
    escrow.recipients.forEach((recipient, position) => {
      if (escrow.shares[position] === 0) return;
      const owner = new PublicKey(recipient);
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          ata(owner, context.addresses.usdc),
          owner,
          context.addresses.usdc,
        ),
      );
    });
    transaction
      .add(ed25519VerifyIx(escrow.resolver, signed.Ok.signature, message))
      .add(releaseIx(chunk.escrow, escrow, chunk.index, context.addresses));
    transactions.push(transaction);
  }
  const wires = await wallet.signTransactions(transactions);
  const signatures: string[] = [];
  for (const wire of wires) {
    signatures.push(await sendSigned(context, wire));
  }
  return { released: due, signatures };
}

// ---- cancel -------------------------------------------------------------

/**
 * The donor's exit (§6): everything is recovered from one account read
 * (nonce = t0), the wallet signs the §8 authorization, the canister signs
 * the shape's cancel, one transaction executes it.
 */
export async function cancelFlow(
  channelId: Uint8Array,
  escrowAddress: PublicKey,
  wallet: WalletSigner,
  context: FlowContext,
): Promise<{ signature: string }> {
  const account = await context.connection.getAccountInfo(escrowAddress);
  if (!account) throw new Error("escrow account not found");
  const escrow = decodeEscrow(new Uint8Array(account.data));

  const authorization = cancelAuthorization(
    context.chainId,
    Principal.fromText(context.subscriptionCanisterId).toUint8Array(),
    escrowAddress.toBytes(),
  );
  const walletSignature = await wallet.signMessage(authorization);

  const signed = await context.subscription.request_cancel({
    chain: context.chainId,
    subscriptionId: channelId,
    ...birthOf(escrow),
    signature: walletSignature,
  });
  if ("Err" in signed) throw new Error(`request_cancel: ${signed.Err}`);

  const message = cancelMessage(context.domain, context.addresses.factory, escrowAddress);
  const transaction = (await prepared(context, wallet.publicKey))
    .add(ed25519VerifyIx(escrow.resolver, signed.Ok.signature, message))
    .add(cancelIx(escrowAddress, escrow, context.addresses));
  const [wire] = await wallet.signTransactions([transaction]);
  if (!wire) throw new Error("wallet returned no transaction");
  return { signature: await sendSigned(context, wire) };
}

/** Re-exported for the page: is this escrow a live subscription (§4)? */
export { subscriptionAlive };
