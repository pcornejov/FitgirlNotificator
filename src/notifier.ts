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
  send(release: Release, isUpdate: boolean, options?: SendOptions): Promise<void>;
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

function parseChannel(name: string): ChannelName {
  if (name === "telegram" || name === "callmebot") {
    return name;
  }
  throw new NotifierConfigError(
    `Unknown NOTIFIER "${name}". Supported channels: telegram, callmebot`,
  );
}

export function resolveChannel(value: string | undefined): ChannelName {
  return resolveChannels(value)[0] as ChannelName;
}

/**
 * Parses `NOTIFIER` into the list of active channels.
 *
 * Accepts one name or a comma-separated list, so a release can be delivered to
 * several places at once. Duplicates collapse and order is preserved.
 */
export function resolveChannels(value: string | undefined): ChannelName[] {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return [DEFAULT_CHANNEL];
  }

  const channels: ChannelName[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") {
      continue;
    }
    const channel = parseChannel(name);
    if (!channels.includes(channel)) {
      channels.push(channel);
    }
  }

  if (channels.length === 0) {
    throw new NotifierConfigError(`NOTIFIER "${value}" names no channel`);
  }

  return channels;
}

/**
 * Builds the notifier for the configured channel.
 *
 * @throws {NotifierConfigError} when credentials are missing, so the run aborts
 * before any KV write happens.
 */
export function createNotifier(config: NotifierConfig): Notifier {
  return buildNotifier(resolveChannel(config.NOTIFIER), config);
}

/**
 * Builds one notifier per configured channel.
 *
 * Every channel's credentials are validated up front: a half-configured fan-out
 * fails the run before any KV write rather than silently dropping a channel.
 */
export function createNotifiers(config: NotifierConfig): Notifier[] {
  return resolveChannels(config.NOTIFIER).map((channel) => buildNotifier(channel, config));
}

function buildNotifier(channel: ChannelName, config: NotifierConfig): Notifier {
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
      send: (release, isUpdate, options) =>
        sendTelegramNotification(token, chatId, release, isUpdate, options ?? {}),
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
    send: (release, isUpdate, options) =>
      sendWhatsAppNotification(phone, apiKey, release, isUpdate, options ?? {}),
  };
}
