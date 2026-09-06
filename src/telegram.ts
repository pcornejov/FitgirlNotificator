/**
 * Telegram delivery through the official Bot API.
 *
 * Free, with no waiting list: create a bot with @BotFather, take its token and
 * the chat id of the conversation to notify (see README).
 */

import { DEFAULT_USER_AGENT, type Release } from "./feed";
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

/** Endpoint for the multipart photo upload. */
export function buildPhotoEndpoint(botToken: string): string {
  return `${TELEGRAM_API_BASE}/bot${encodeURIComponent(botToken)}/sendPhoto`;
}

/**
 * Telegram accepts uploads up to 10 MB; staying well under keeps a run cheap
 * and leaves room for the multipart overhead.
 */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * Timeout for the cover download, deliberately far longer than the one used
 * for the API calls themselves.
 *
 * The image host answers in about a second when the Worker runs from the fetch
 * handler, but takes longer than ten seconds from a scheduled run, which was
 * silently costing every cron notification its cover. The download is not on
 * anyone's critical path, so it can afford to wait.
 */
export const COVER_TIMEOUT_MS = 25_000;

/** Above this, the download is worth a log line even when it succeeds. */
const SLOW_COVER_MS = 4_000;

/** Filename for the upload, derived from the URL so the extension is right. */
function coverFilename(imageUrl: string): string {
  const name = imageUrl.split("?")[0]?.split("/").pop() ?? "";
  return /\.(jpe?g|png|gif|webp)$/i.test(name) ? name : "cover.jpg";
}

/**
 * Downloads the cover so it can be uploaded to Telegram as a file.
 *
 * Passing the URL to Telegram directly does not work for FitGirl: the image
 * host refuses Telegram's fetchers ("failed to get HTTP URL content"), while
 * serving normal clients fine. Fetching it here and uploading the bytes is
 * what makes covers arrive reliably.
 *
 * Returns null on any problem: a cover is a nice-to-have, never a reason to
 * lose the notification.
 */
async function fetchCover(imageUrl: string): Promise<Blob | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(imageUrl, {
      headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "image/*,*/*;q=0.8" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Cover download failed with HTTP ${response.status}: ${imageUrl}`);
      return null;
    }

    const elapsed = Date.now() - started;
    if (elapsed > SLOW_COVER_MS) {
      console.log(`Cover download took ${elapsed}ms: ${imageUrl}`);
    }

    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      console.warn(`Cover is not an image (${contentType || "no type"}): ${imageUrl}`);
      return null;
    }

    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_COVER_BYTES) {
      console.warn(`Cover size out of range (${blob.size} bytes): ${imageUrl}`);
      return null;
    }
    return blob;
  } catch (error) {
    console.warn(
      `Cover download errored after ${Date.now() - started}ms ` +
        `(limit ${COVER_TIMEOUT_MS}ms): ` +
        `${error instanceof Error ? error.message : String(error)} — ${imageUrl}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    const cover = await fetchCover(release.imageUrl);
    if (cover !== null) {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", message);
      form.set("parse_mode", "HTML");
      form.set("photo", cover, coverFilename(release.imageUrl));

      try {
        await deliver(
          { url: buildPhotoEndpoint(botToken), method: "POST", body: form },
          CHANNEL,
          options,
          verifyBody,
        );
        return;
      } catch (error) {
        console.warn(
          `Cover upload rejected for ${release.id}, falling back to text: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  await deliver({ url: buildRequestUrl(botToken, chatId, message) }, CHANNEL, options, verifyBody);
}
