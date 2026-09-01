/**
 * Deduplication layer on top of the `SEEN_RELEASES` KV namespace.
 *
 * A key is written ONLY after the corresponding WhatsApp message was
 * confirmed as sent, so a failed notification is retried on the next run
 * instead of being silently lost.
 */

import type { Release } from "./feed";

/**
 * Structural subset of `KVNamespace` used by this module. Keeping it minimal
 * lets the tests plug in an in-memory double without stubbing the whole API.
 */
export interface SeenReleasesKV {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export const DEFAULT_SEEN_TTL_DAYS = 30;

/** Cloudflare KV rejects TTLs below 60 seconds. */
const MIN_TTL_SECONDS = 60;
const SECONDS_PER_DAY = 86_400;

export function ttlSecondsFromDays(ttlDays: number): number {
  const seconds = Math.floor(ttlDays * SECONDS_PER_DAY);
  return Number.isFinite(seconds) && seconds > MIN_TTL_SECONDS
    ? seconds
    : MIN_TTL_SECONDS;
}

/** Returns true when the release has already been notified. */
export async function hasBeenSeen(
  releaseId: string,
  kv: SeenReleasesKV,
): Promise<boolean> {
  return (await kv.get(releaseId)) !== null;
}

/**
 * Filters out releases already stored in KV, preserving feed order and
 * dropping duplicate ids present within the same feed payload.
 *
 * Errors from KV are propagated: the run must abort rather than risk
 * re-notifying every release.
 */
export async function filterUnseen(
  releases: Release[],
  kv: SeenReleasesKV,
): Promise<Release[]> {
  const unseen: Release[] = [];
  const inspected = new Set<string>();

  for (const release of releases) {
    if (inspected.has(release.id)) {
      continue;
    }
    inspected.add(release.id);

    if (!(await hasBeenSeen(release.id, kv))) {
      unseen.push(release);
    }
  }

  return unseen;
}

/**
 * Marks a single release as notified.
 *
 * Call this only after a successful WhatsApp send. Failures are propagated so
 * the caller can log them; the release simply stays unseen and is retried.
 */
export async function markSeen(
  releaseId: string,
  kv: SeenReleasesKV,
  ttlDays: number = DEFAULT_SEEN_TTL_DAYS,
): Promise<void> {
  await kv.put(releaseId, new Date().toISOString(), {
    expirationTtl: ttlSecondsFromDays(ttlDays),
  });
}
