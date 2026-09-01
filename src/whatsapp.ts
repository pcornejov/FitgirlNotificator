/**
 * WhatsApp delivery through the CallMeBot gateway.
 *
 * The bot must be activated once from the destination phone before the API
 * accepts messages (see README).
 */

import type { Release } from "./feed";

export const CALLMEBOT_ENDPOINT = "https://api.callmebot.com/whatsapp.php";

export const DEFAULT_RETRY_DELAY_MS = 2_000;
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface SendOptions {
  /** Backoff before the single retry of a transient failure. */
  retryDelayMs?: number;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  /** Injectable sleep, so tests do not wait for real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/** Raised when the message could not be delivered. */
export class WhatsAppError extends Error {
  readonly status: number | undefined;
  readonly attempts: number;

  constructor(message: string, attempts: number, status?: number) {
    super(message);
    this.name = "WhatsAppError";
    this.attempts = attempts;
    this.status = status;
  }
}

/** The message body sent to WhatsApp for a release. */
export function formatMessage(release: Release): string {
  return `🎮 *Nuevo Release en FitGirl*\n\n${release.title}\n\n🔗 ${release.link}`;
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

/** A 5xx (or a timeout / network drop) is worth exactly one retry; a 4xx is not. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptSend(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "GET", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one WhatsApp notification, retrying once on a transient error.
 *
 * @throws {WhatsAppError} when delivery ultimately fails, so the caller can
 * skip `markSeen` and retry the release on the next scheduled run.
 */
export async function sendWhatsAppNotification(
  phone: string,
  apiKey: string,
  release: Release,
  options: SendOptions = {},
): Promise<void> {
  if (phone === "" || apiKey === "") {
    throw new WhatsAppError("Missing CallMeBot phone or API key", 0);
  }

  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const url = buildRequestUrl(phone, apiKey, formatMessage(release));

  const maxAttempts = 2;
  let lastError: WhatsAppError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await attemptSend(url, timeoutMs);
    } catch (cause) {
      // Network failures and timeouts are transient by definition.
      lastError = new WhatsAppError(
        `CallMeBot request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        attempt,
      );
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return;
    }

    lastError = new WhatsAppError(
      `CallMeBot responded with HTTP ${response.status}`,
      attempt,
      response.status,
    );

    if (!isTransientStatus(response.status) || attempt === maxAttempts) {
      throw lastError;
    }

    await sleep(retryDelayMs);
  }

  /* istanbul ignore next -- the loop always returns or throws. */
  throw lastError ?? new WhatsAppError("CallMeBot delivery failed", maxAttempts);
}
