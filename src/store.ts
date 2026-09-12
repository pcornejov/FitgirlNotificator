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

/** A release that still has to be notified, and why. */
export interface PendingRelease {
  release: Release;
  /** True when this post was notified before under an earlier timestamp. */
  isUpdate: boolean;
}

/**
 * Key for one *version* of a post.
 *
 * FitGirl updates a repack in place and bumps its publish date, which floats
 * the post back to the top of the feed under the same guid. Keying on the guid
 * alone would swallow those updates, so the timestamp is part of the key.
 */
export function versionKey(release: Release): string {
  const parsed = Date.parse(release.publishedAt);
  const stamp = Number.isNaN(parsed)
    ? release.publishedAt.replace(/\s+/g, "_")
    : String(Math.floor(parsed / 1000));
  return `${release.id}@${stamp}`;
}

/** Key holding the last seen upcoming-repacks list. */
export const UPCOMING_KEY = "upcoming:list";

/**
 * Reads the previously stored upcoming list.
 *
 * `null` means nothing has been stored yet, which the caller treats as a first
 * run: the list is recorded without announcing every title already on it.
 */
export async function readUpcoming(kv: SeenReleasesKV): Promise<string[] | null> {
  const stored = await kv.get(UPCOMING_KEY);
  if (stored === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : null;
  } catch {
    // Unreadable value: treat it as absent and rewrite it below.
    return null;
  }
}

/** Records the current upcoming list. */
export async function writeUpcoming(
  titles: string[],
  kv: SeenReleasesKV,
  ttlDays: number = DEFAULT_SEEN_TTL_DAYS,
): Promise<void> {
  await kv.put(UPCOMING_KEY, JSON.stringify(titles), {
    expirationTtl: ttlSecondsFromDays(ttlDays),
  });
}

/** Key marking that a post has been notified at all, in any version. */
export function postKey(release: Release): string {
  return release.id;
}

/** Cloudflare KV rejects TTLs below 60 seconds. */
const MIN_TTL_SECONDS = 60;
const SECONDS_PER_DAY = 86_400;

export function ttlSecondsFromDays(ttlDays: number): number {
  const seconds = Math.floor(ttlDays * SECONDS_PER_DAY);
  return Number.isFinite(seconds) && seconds > MIN_TTL_SECONDS
    ? seconds
    : MIN_TTL_SECONDS;
}

/** Returns true when this exact version of the release has been notified. */
export async function hasBeenSeen(
  release: Release,
  kv: SeenReleasesKV,
): Promise<boolean> {
  return (await kv.get(versionKey(release))) !== null;
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
): Promise<PendingRelease[]> {
  const unseen: PendingRelease[] = [];
  const inspected = new Set<string>();

  for (const release of releases) {
    const key = versionKey(release);
    if (inspected.has(key)) {
      continue;
    }
    inspected.add(key);

    if (await hasBeenSeen(release, kv)) {
      continue;
    }

    // Known post, new timestamp: the repack was updated and reposted.
    const isUpdate = (await kv.get(postKey(release))) !== null;
    unseen.push({ release, isUpdate });
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
  release: Release,
  kv: SeenReleasesKV,
  ttlDays: number = DEFAULT_SEEN_TTL_DAYS,
): Promise<void> {
  const options = { expirationTtl: ttlSecondsFromDays(ttlDays) };
  const now = new Date().toISOString();

  // The version key suppresses this exact post; the post key is what later
  // tells an update apart from a first-time release.
  await kv.put(versionKey(release), now, options);
  await kv.put(postKey(release), now, options);
}
