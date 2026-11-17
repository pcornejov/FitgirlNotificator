/**
 * Transport shared by every notification channel: one GET request, a single
 * retry on transient failures and a typed error carrying the channel name.
 */

export const DEFAULT_RETRY_DELAY_MS = 2_000;
/**
 * Telegram can take a while to answer when it has to fetch a cover image, and
 * a request that times out may still have been delivered, so be generous.
 */
export const DEFAULT_TIMEOUT_MS = 25_000;

export interface SendOptions {
  /** Backoff before the single retry of a transient failure. */
  retryDelayMs?: number;
  /** Per-attempt request timeout. */
  timeoutMs?: number;
  /** Injectable sleep, so tests do not wait for real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

/** Raised when a notification could not be delivered. */
export class NotificationError extends Error {
  readonly channel: string;
  readonly status: number | undefined;
  readonly attempts: number;

  constructor(channel: string, message: string, attempts: number, status?: number) {
    super(message);
    this.name = "NotificationError";
    this.channel = channel;
    this.attempts = attempts;
    this.status = status;
  }
}

/** A 5xx or network drop is worth exactly one retry; a 4xx or a timeout is not. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The request outlived its timeout: the server may still have processed it. */
class RequestTimeoutError extends Error {}

async function attempt(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { method: "GET", signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new RequestTimeoutError(`timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Performs the request, retrying once on a transient error.
 *
 * @param verify optional extra check for APIs that report failures inside a
 * 200 response body. Return an error message to reject the response.
 * @throws {NotificationError} when delivery ultimately fails, so the caller can
 * skip `markSeen` and retry the release on the next scheduled run.
 */
export async function deliver(
  url: string,
  channel: string,
  options: SendOptions = {},
  verify?: (response: Response) => Promise<string | null>,
): Promise<void> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;

  const maxAttempts = 2;
  let lastError: NotificationError | null = null;

  for (let n = 1; n <= maxAttempts; n += 1) {
    let response: Response;
    try {
      response = await attempt(url, timeoutMs);
    } catch (cause) {
      // Network failures and timeouts are transient by definition.
      lastError = new NotificationError(
        channel,
        `${channel} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        n,
      );
      // A timeout is NOT retried: the request may have been delivered anyway,
      // and sending it again is how duplicates happen. Other network errors
      // (refused, reset) failed before delivery, so one retry is safe.
      if (n < maxAttempts && !(cause instanceof RequestTimeoutError)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      const rejection = verify === undefined ? null : await verify(response);
      if (rejection === null) {
        return;
      }
      // A semantic failure behind a 200: the payload is wrong, retrying it
      // would only repeat the same rejection.
      throw new NotificationError(channel, rejection, n, response.status);
    }

    lastError = new NotificationError(
      channel,
      `${channel} responded with HTTP ${response.status}`,
      n,
      response.status,
    );

    if (!isTransientStatus(response.status) || n === maxAttempts) {
      throw lastError;
    }

    await sleep(retryDelayMs);
  }

  /* istanbul ignore next -- the loop always returns or throws. */
  throw lastError ?? new NotificationError(channel, "delivery failed", maxAttempts);
}

/** True for a refusal that retrying will never fix (bad chat id, blocked bot...). */
export function isPermanentFailure(error: unknown): boolean {
  return (
    error instanceof NotificationError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    !isTransientStatus(error.status)
  );
}
