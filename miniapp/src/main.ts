// The page: parse the fragment, connect a wallet, run one flow, report.
// Deliberately spartan — B2 is the mechanics; looks come later.

import { Buffer } from "buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { PublicKey } from "@solana/web3.js";
import { fromHex } from "@crown/core";

import { buildContext, chainConfig, parseFragment, solanaChainOf } from "./config.ts";
import { cancelFlow, collectFlow, linkFlow, subscribeFlow, type WalletSigner } from "./flows.ts";
import { discoverWallets } from "./wallet.ts";

interface TelegramWebApp {
  ready(): void;
  sendData(data: string): void;
  close(): void;
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const app = document.getElementById("app");
if (!app) throw new Error("no #app");

function say(text: string): void {
  const line = document.createElement("div");
  line.textContent = text;
  app?.appendChild(line);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = label;
  element.addEventListener("click", onClick);
  app?.appendChild(element);
  return element;
}

async function withWallet(run: (wallet: WalletSigner & { address: string }) => Promise<void>) {
  const wallets = discoverWallets(solanaChainOf(chainConfig().chainId));
  if (wallets.length === 0) {
    say("Кошелёк не найден: установите Solana-кошелёк со стандартом Wallet Standard.");
    return;
  }
  for (const discovered of wallets) {
    button(`Подключить ${discovered.name}`, () => {
      void (async () => {
        try {
          const wallet = await discovered.connect();
          say(`Кошелёк: ${wallet.address}`);
          await run(wallet);
        } catch (error) {
          say(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    });
  }
}

async function main(): Promise<void> {
  window.Telegram?.WebApp?.ready();
  const params = parseFragment(location.hash);
  if (!params) {
    say("Откройте эту страницу по ссылке из бота.");
    return;
  }
  const payload = params.payload;

  switch (params.action) {
    case "link": {
      const challenge = payload.challenge;
      if (!challenge) throw new Error("no challenge");
      say("Подпишите привязку кошелька:");
      say(challenge);
      await withWallet(async (wallet) => {
        const result = await linkFlow(challenge, wallet);
        const telegram = window.Telegram?.WebApp;
        if (telegram) {
          telegram.sendData(JSON.stringify(result));
          telegram.close();
        } else {
          say(`Результат (вне Telegram): ${JSON.stringify(result)}`);
        }
      });
      break;
    }
    case "subscribe": {
      const context = await buildContext(payload);
      const channel = {
        resolver: fromHex(payload.resolver ?? ""),
        policy: {
          owner: new PublicKey(payload.owner ?? "").toBytes(),
          price: BigInt(payload.price ?? "0"),
          period: BigInt(payload.period ?? "0"),
          threshold: 0n,
        },
      };
      say(`Подписка: ${payload.price} за период ${payload.period} с.`);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.value = "1";
      app?.appendChild(input);
      await withWallet(async (wallet) => {
        const months = Number(input.value);
        const { escrow, signature } = await subscribeFlow(channel, months, wallet, context);
        say(`Эскроу: ${escrow.toBase58()}`);
        say(`Транзакция: ${signature}`);
      });
      break;
    }
    case "collect": {
      const context = await buildContext(payload);
      const channelId = fromHex(payload.channelId ?? "");
      const channel = {
        resolver: fromHex(payload.resolver ?? ""),
        policy: {
          owner: new PublicKey(payload.owner ?? "").toBytes(),
          price: BigInt(payload.price ?? "0"),
          period: BigInt(payload.period ?? "0"),
          threshold: 0n,
        },
      };
      await withWallet(async (wallet) => {
        say("Ищу созревшие куски…");
        const { released, signatures } = await collectFlow(channelId, channel, wallet, context);
        if (released.length === 0) {
          say("Созревших кусков нет.");
          return;
        }
        for (const [i, chunk] of released.entries()) {
          say(`Кусок ${chunk.index} эскроу ${chunk.escrow.toBase58()}: ${signatures[i]}`);
        }
      });
      break;
    }
    case "cancel": {
      const context = await buildContext(payload);
      const channelId = fromHex(payload.channelId ?? "");
      const escrow = new PublicKey(payload.escrow ?? "");
      say(`Отмена подписки ${escrow.toBase58()}: остаток вернётся мгновенно.`);
      await withWallet(async (wallet) => {
        const { signature } = await cancelFlow(channelId, escrow, wallet, context);
        say(`Отменено: ${signature}`);
      });
      break;
    }
    default:
      say(`Неизвестное действие: ${params.action}`);
  }
}

void main().catch((error) => say(`Ошибка: ${error instanceof Error ? error.message : String(error)}`));
