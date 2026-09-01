/**
 * Channel selection. The orchestrator only knows about `Notifier`, so adding
 * or swapping a channel never touches the feed, KV or cron logic.
 */

import type { Release } from "./feed";
import type { SendOptions } from "./notify";
import { sendTelegramNotification } from "./telegram";
import { sendWhatsAppNotification } from "./whatsapp";

export type ChannelName = "telegram" | "callmebot";

export const DEFAULT_CHANNEL: ChannelName = "telegram";

export interface Notifier {
  readonly channel: ChannelName;
  send(release: Release, options?: SendOptions): Promise<void>;
}

/** Credentials needed by the channels, as they arrive from the environment. */
export interface NotifierConfig {
  NOTIFIER?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_API_KEY?: string;
}

/** Raised when the selected channel is unknown or missing credentials. */
export class NotifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifierConfigError";
  }
}

export function resolveChannel(value: string | undefined): ChannelName {
  const name = (value ?? "").trim().toLowerCase();
  if (name === "") {
    return DEFAULT_CHANNEL;
  }
  if (name === "telegram" || name === "callmebot") {
    return name;
  }
  throw new NotifierConfigError(
    `Unknown NOTIFIER "${value}". Supported channels: telegram, callmebot`,
  );
}

/**
 * Builds the notifier for the configured channel.
 *
 * @throws {NotifierConfigError} when credentials are missing, so the run aborts
 * before any KV write happens.
 */
export function createNotifier(config: NotifierConfig): Notifier {
  const channel = resolveChannel(config.NOTIFIER);

  if (channel === "telegram") {
    const token = config.TELEGRAM_BOT_TOKEN ?? "";
    const chatId = config.TELEGRAM_CHAT_ID ?? "";
    if (token === "" || chatId === "") {
      throw new NotifierConfigError(
        "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured via `wrangler secret put`",
      );
    }
    return {
      channel,
      send: (release, options) =>
        sendTelegramNotification(token, chatId, release, options ?? {}),
    };
  }

  const phone = config.CALLMEBOT_PHONE ?? "";
  const apiKey = config.CALLMEBOT_API_KEY ?? "";
  if (phone === "" || apiKey === "") {
    throw new NotifierConfigError(
      "CALLMEBOT_PHONE and CALLMEBOT_API_KEY must be configured via `wrangler secret put`",
    );
  }
  return {
    channel,
    send: (release, options) =>
      sendWhatsAppNotification(phone, apiKey, release, options ?? {}),
  };
}
