/**
 * Telegram delivery through the official Bot API.
 *
 * Free, with no waiting list: create a bot with @BotFather, take its token and
 * the chat id of the conversation to notify (see README).
 */

import type { Release } from "./feed";
import { NotificationError, type SendOptions, deliver } from "./notify";

export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const CHANNEL = "telegram";

/** Escapes the three characters that are significant in Telegram's HTML mode. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The message body, in Telegram HTML mode.
 *
 * HTML is used instead of MarkdownV2 because repack titles routinely contain
 * `-`, `.`, `(` and `)`, all of which MarkdownV2 would require escaping.
 */
export function formatMessage(release: Release): string {
  return (
    `🎮 <b>Nuevo Release en FitGirl</b>\n\n` +
    `${escapeHtml(release.title)}\n\n` +
    `🔗 ${escapeHtml(release.link)}`
  );
}

/** Builds the fully encoded sendMessage request URL. */
export function buildRequestUrl(
  botToken: string,
  chatId: string,
  message: string,
): string {
  const query = [
    `chat_id=${encodeURIComponent(chatId)}`,
    `text=${encodeURIComponent(message)}`,
    "parse_mode=HTML",
  ].join("&");

  return `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/sendMessage?${query}`;
}

/**
 * The Bot API signals errors with a 4xx/5xx status, but it also carries an
 * `ok` flag in the body; checking it guards against a proxy that rewrites the
 * status code.
 */
async function verifyBody(response: Response): Promise<string | null> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A 200 with an unreadable body: accept it rather than resend the message.
    return null;
  }

  if (typeof payload === "object" && payload !== null && "ok" in payload) {
    const body = payload as { ok: unknown; description?: unknown };
    if (body.ok === false) {
      const reason =
        typeof body.description === "string" ? body.description : "unknown error";
      return `Telegram rejected the message: ${reason}`;
    }
  }

  return null;
}

/**
 * Sends one Telegram notification, retrying once on a transient error.
 *
 * @throws {NotificationError} when delivery ultimately fails.
 */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  release: Release,
  options: SendOptions = {},
): Promise<void> {
  if (botToken === "" || chatId === "") {
    throw new NotificationError(CHANNEL, "Missing Telegram bot token or chat id", 0);
  }

  await deliver(
    buildRequestUrl(botToken, chatId, formatMessage(release)),
    CHANNEL,
    options,
    verifyBody,
  );
}
