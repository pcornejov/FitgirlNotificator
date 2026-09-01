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
    { url: buildRequestUrl(phone, apiKey, formatMessage(release, isUpdate)) },
    CHANNEL,
    options,
  );
}
