// The donor's cancel authorization — a mirror of the subscription canister's
// message (crown-games/subscription, game-spec §8). The donor signs this text
// with the wallet; the canister verifies it against the donor field of the
// declared birth.
//
// Text, not bytes, because wallets refuse to sign anything else: Phantom runs
// `isValidUTF8` over the payload and rejects the rest with "You cannot sign
// solana transactions using sign message" — a binary layout would make
// cancel impossible with the largest Solana wallet, and cancel is the donor's
// only right here. Text also lets the donor read what they are cancelling:
// the escrow address is the same base58 an explorer shows.

import { PublicKey } from "@solana/web3.js";

import { utf8 } from "./bytes.ts";

export const CANCEL_DOMAIN = "crown:subscription:v1";
export const ACTION_CANCEL = "cancel";

/**
 * crown:subscription:v1
 * action: cancel
 * chain: solana-devnet
 * canister: vg3po-ix777-77774-qaafa-cai
 * escrow: CS1mmfBkPLimY6WLGczafmQBiQNUKTUmQrCfDBKUJEyz
 */
export function cancelAuthorization(
  chain: string,
  canisterId: string,
  escrow: Uint8Array,
): Uint8Array {
  return utf8(
    `${CANCEL_DOMAIN}\n` +
      `action: ${ACTION_CANCEL}\n` +
      `chain: ${chain}\n` +
      `canister: ${canisterId}\n` +
      // base58 of the address, the same form the canister renders and an
      // explorer shows. PublicKey also refuses anything that is not 32 bytes.
      `escrow: ${new PublicKey(escrow).toBase58()}\n`,
  );
}
