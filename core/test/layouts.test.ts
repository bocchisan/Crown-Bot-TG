// The frozen byte layouts (docs/bot-spec.md §2, §3, §8): channel_id against
// a python hashlib vector, the challenge text, and the cancel authorization
// against the canister's own pinned test vector.
import { test } from "node:test";
import assert from "node:assert/strict";

import { concat, fromHex, hex, lp, utf8 } from "../src/bytes.ts";
import { cancelAuthorization } from "../src/cancel-authorization.ts";
import { buildChallenge } from "../src/challenge.ts";
import { channelId } from "../src/channel-id.ts";

// python3: sha256(b"crown:bot-tg:v1" + struct.pack("<q", -1001234567890)
//                 + bytes([0x22]*32) + struct.pack("<Q", 7))
const CHANNEL_ID_VECTOR = "bc7e3477e40f938be41e4254da20ccaaf978e7e1a8cde7f29ec4b3c7834ccf77";

test("channel_id matches the cross-tool vector", () => {
  const id = channelId(-1001234567890n, new Uint8Array(32).fill(0x22), 7n);
  assert.equal(hex(id), CHANNEL_ID_VECTOR);
});

test("channel_id separates every input", () => {
  const base = hex(channelId(-1n, new Uint8Array(32).fill(0x22), 7n));
  assert.notEqual(hex(channelId(-2n, new Uint8Array(32).fill(0x22), 7n)), base);
  assert.notEqual(hex(channelId(-1n, new Uint8Array(32).fill(0x23), 7n)), base);
  assert.notEqual(hex(channelId(-1n, new Uint8Array(32).fill(0x22), 8n)), base);
});

test("the challenge layout is pinned", () => {
  const text = buildChallenge({
    botUsername: "crown_gate_bot",
    channelId: new Uint8Array(32).fill(0xab),
    telegramId: 123456789n,
    nonce: fromHex("00112233445566778899aabbccddeeff"),
    expires: 1_900_000_000n,
  });
  assert.equal(
    text,
    [
      "crown-bot-tg v1",
      "bot: crown_gate_bot",
      `channel: ${"ab".repeat(32)}`,
      "telegram: 123456789",
      "action: link",
      "nonce: 00112233445566778899aabbccddeeff",
      "expires: 1900000000",
    ].join("\n"),
  );
});

// Mirrors the canister's cancel_authorization_is_pinned test (crown-games/
// subscription, canister/src/auth.rs): the same chain, canister and escrow
// must render the same text here, or no signature this client makes will be
// accepted.
test("the cancel authorization mirrors the canister's text", () => {
  const message = cancelAuthorization(
    "solana-devnet",
    "vg3po-ix777-77774-qaafa-cai",
    new Uint8Array(32).fill(0xcc),
  );
  assert.equal(
    new TextDecoder().decode(message),
    "crown:subscription:v1\n" +
      "action: cancel\n" +
      "chain: solana-devnet\n" +
      "canister: vg3po-ix777-77774-qaafa-cai\n" +
      // base58 of [0xCC; 32], the same constant the canister test pins.
      "escrow: EnTJCS15dqbDTU2XywYSMaScoPv4Py4GzExrtY9DQxoD\n",
  );
});

// The reason it is text at all: Phantom checks isValidUTF8 over the payload
// and refuses everything else with "You cannot sign solana transactions using
// sign message" — a binary payload would make cancel impossible.
test("the cancel authorization is valid UTF-8", () => {
  const message = cancelAuthorization(
    "solana-devnet",
    "vg3po-ix777-77774-qaafa-cai",
    new Uint8Array(32).fill(0xff),
  );
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(message);
  assert.equal(hex(utf8(decoded)), hex(message));
});

test("lp framing is injective", () => {
  const a = concat(lp(utf8("ab")), lp(utf8("c")));
  const b = concat(lp(utf8("a")), lp(utf8("bc")));
  assert.notEqual(hex(a), hex(b));
});
