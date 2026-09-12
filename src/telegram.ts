/**
 * Telegram delivery through the official Bot API.
 *
 * Free, with no waiting list: create a bot with @BotFather, take its token and
 * the chat id of the conversation to notify (see README).
 */

import type { Release } from "./feed";
import { formatUpcomingMessage } from "./upcoming";
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
export function formatMessage(release: Release, isUpdate = false): string {
  const heading = isUpdate
    ? "🔄 <b>Repack actualizado en FitGirl</b>"
    : "🎮 <b>Nuevo Release en FitGirl</b>";

  return `${heading}\n\n${escapeHtml(release.title)}\n\n🔗 ${escapeHtml(release.link)}`;
}

/**
 * Announces games newly added to the upcoming-repacks list.
 *
 * @throws {NotificationError} when delivery fails.
 */
export async function sendUpcomingNotification(
  botToken: string,
  chatId: string,
  titles: string[],
  options: SendOptions = {},
): Promise<void> {
  if (botToken === "" || chatId === "") {
    throw new NotificationError(CHANNEL, "Missing Telegram bot token or chat id", 0);
  }

  const message = formatUpcomingMessage(titles, escapeHtml, (t) => `<b>${t}</b>`);
  await deliver(buildRequestUrl(botToken, chatId, message), CHANNEL, options, verifyBody);
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
 * Image CDN used to reach the cover art.
 *
 * The image host does not answer the Worker at all from a scheduled run, and
 * refuses Telegram's fetchers outright, so neither downloading the file nor
 * handing Telegram the original URL delivers a cover from the cron. Both can
 * reach this proxy, which fetches the image on their behalf.
 */
export const IMAGE_PROXY_BASE = "https://i0.wp.com";

/** Rewrites a cover URL to go through the image proxy. */
export function proxiedCoverUrl(imageUrl: string): string {
  const source = new URL(imageUrl);
  const params = new URLSearchParams(source.search);
  if (source.protocol === "https:") {
    // Tells the proxy to fetch the origin over TLS.
    params.set("ssl", "1");
  }

  const query = params.toString();
  return `${IMAGE_PROXY_BASE}/${source.host}${source.pathname}${query === "" ? "" : `?${query}`}`;
}

/**
 * Builds the sendPhoto request URL, with the message as the photo caption.
 *
 * Telegram fetches the image itself, so nothing is downloaded or uploaded here.
 */
export function buildPhotoRequestUrl(
  botToken: string,
  chatId: string,
  photoUrl: string,
  caption: string,
): string {
  const query = [
    `chat_id=${encodeURIComponent(chatId)}`,
    `photo=${encodeURIComponent(photoUrl)}`,
    `caption=${encodeURIComponent(caption)}`,
    "parse_mode=HTML",
  ].join("&");

  return `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/sendPhoto?${query}`;
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
 * When the release carries a cover image it is sent as a photo with the
 * message as caption, which is far more reliable than hoping Telegram builds a
 * rich link preview. If Telegram cannot fetch that image the notification is
 * still delivered as plain text: a broken cover must never cost the alert.
 *
 * @throws {NotificationError} when delivery ultimately fails.
 */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  release: Release,
  isUpdate = false,
  options: SendOptions = {},
): Promise<void> {
  if (botToken === "" || chatId === "") {
    throw new NotificationError(CHANNEL, "Missing Telegram bot token or chat id", 0);
  }

  const message = formatMessage(release, isUpdate);

  if (release.imageUrl !== undefined && release.imageUrl !== "") {
    try {
      await deliver(
        buildPhotoRequestUrl(botToken, chatId, proxiedCoverUrl(release.imageUrl), message),
        CHANNEL,
        options,
        verifyBody,
      );
      return;
    } catch (error) {
      // A cover is a nice-to-have and never costs the alert.
      console.warn(
        `Cover rejected for ${release.id}, falling back to text: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await deliver(buildRequestUrl(botToken, chatId, message), CHANNEL, options, verifyBody);
}
