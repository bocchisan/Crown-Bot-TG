// Wallet Standard discovery and the WalletSigner bridge — the only place
// that talks to browser wallets. No framework: the standard's window events
// are enough for connect, signMessage and signTransaction.

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { Transaction } from "@solana/web3.js";

import type { WalletSigner } from "./flows.ts";

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface SignMessageFeature {
  signMessage(
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ): Promise<{ signature: Uint8Array }[]>;
}
interface SignTransactionFeature {
  signTransaction(
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
  ): Promise<{ signedTransaction: Uint8Array }[]>;
}

const CONNECT = "standard:connect";
const SIGN_MESSAGE = "solana:signMessage";
const SIGN_TRANSACTION = "solana:signTransaction";

export interface DiscoveredWallet {
  name: string;
  icon: string;
  connect(): Promise<WalletSigner & { address: string }>;
}

/** Wallets exposing connect + signMessage + signTransaction for our chain. */
export function discoverWallets(solanaChain: string): DiscoveredWallet[] {
  return getWallets()
    .get()
    .filter(
      (wallet) =>
        CONNECT in wallet.features &&
        SIGN_MESSAGE in wallet.features &&
        SIGN_TRANSACTION in wallet.features &&
        wallet.chains.includes(solanaChain as Wallet["chains"][number]),
    )
    .map((wallet) => ({
      name: wallet.name,
      icon: wallet.icon,
      connect: () => connect(wallet, solanaChain),
    }));
}

async function connect(
  wallet: Wallet,
  solanaChain: string,
): Promise<WalletSigner & { address: string }> {
  const { accounts } = await (wallet.features[CONNECT] as ConnectFeature).connect();
  const account = accounts.find((candidate) =>
    candidate.chains.includes(solanaChain as WalletAccount["chains"][number]),
  );
  if (!account) throw new Error(`${wallet.name}: no account for ${solanaChain}`);

  const signMessageFeature = wallet.features[SIGN_MESSAGE] as SignMessageFeature;
  const signTransactionFeature = wallet.features[SIGN_TRANSACTION] as SignTransactionFeature;

  return {
    address: account.address,
    publicKey: new Uint8Array(account.publicKey),
    async signMessage(message) {
      const [out] = await signMessageFeature.signMessage({ account, message });
      if (!out) throw new Error("wallet returned no signature");
      return out.signature;
    },
    async signTransactions(transactions) {
      if (transactions.length === 0) return [];
      const outputs = await signTransactionFeature.signTransaction(
        ...transactions.map((transaction) => ({
          account,
          chain: solanaChain,
          transaction: new Uint8Array(
            transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
          ),
        })),
      );
      return outputs.map((output) => {
        // Round-trip through web3.js so the wire bytes are canonical.
        const signed = Transaction.from(output.signedTransaction);
        return new Uint8Array(signed.serialize());
      });
    },
  };
}
