/**
 * WhatsApp delivery through the CallMeBot gateway.
 *
 * The bot must be activated once from the destination phone before the API
 * accepts messages (see README). Availability depends on CallMeBot having free
 * slots; when it does not, use the Telegram channel instead.
 */

import type { Release } from "./feed";
import { NotificationError, type SendOptions, deliver } from "./notify";

export const CALLMEBOT_ENDPOINT = "https://api.callmebot.com/whatsapp.php";
export const CHANNEL = "callmebot";

export { DEFAULT_RETRY_DELAY_MS, DEFAULT_TIMEOUT_MS, type SendOptions } from "./notify";

/**
 * CallMeBot answers 203 — not a 4xx — when it refuses a message, and `ok` is
 * true across the whole 2xx range, so the status alone reports a rejection as
 * a success. The body is the only reliable signal: a queued message says so.
 */
const QUEUED_RE = /message\s+queued/i;

async function verifyBody(response: Response): Promise<string | null> {
  const body = await response.text();
  if (QUEUED_RE.test(body)) {
    return null;
  }

  // Surface CallMeBot's own wording, stripped of the HTML it wraps it in.
  const reason = body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  return `CallMeBot did not queue the message: ${reason === "" ? `HTTP ${response.status}` : reason}`;
}

/** The message body sent to WhatsApp for a release. */
export function formatMessage(release: Release, isUpdate = false): string {
  const heading = isUpdate
    ? "🔄 *Repack actualizado en FitGirl*"
    : "🎮 *Nuevo Release en FitGirl*";

  return `${heading}\n\n${release.title}\n\n🔗 ${release.link}`;
}

/** Builds the fully encoded CallMeBot request URL. */
export function buildRequestUrl(
  phone: string,
  apiKey: string,
  message: string,
): string {
  const query = [
    `phone=${encodeURIComponent(phone)}`,
    `text=${encodeURIComponent(message)}`,
    `apikey=${encodeURIComponent(apiKey)}`,
  ].join("&");

  return `${CALLMEBOT_ENDPOINT}?${query}`;
}

/**
 * Sends one WhatsApp notification, retrying once on a transient error.
 *
 * @throws {NotificationError} when delivery ultimately fails.
 */
export async function sendWhatsAppNotification(
  phone: string,
  apiKey: string,
  release: Release,
  isUpdate = false,
  options: SendOptions = {},
): Promise<void> {
  if (phone === "" || apiKey === "") {
    throw new NotificationError(CHANNEL, "Missing CallMeBot phone or API key", 0);
  }

  await deliver(
    buildRequestUrl(phone, apiKey, formatMessage(release, isUpdate)),
    CHANNEL,
    options,
    verifyBody,
  );
}
