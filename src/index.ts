/**
 * FitGirl Repacks → WhatsApp notifier.
 *
 * `scheduled` runs every 15 minutes: read the RSS feed, drop releases already
 * notified (Workers KV), notify at most MAX_NOTIFICATIONS_PER_RUN of the rest
 * and only then mark each one as seen.
 *
 * `fetch` exposes GET /test, a dry run that reports what *would* be sent
 * without touching KV or the WhatsApp API.
 */

import {
  DEFAULT_FEED_URL,
  DEFAULT_USER_AGENT,
  RELEASE_CATEGORY,
  type Release,
  fetchLatestReleases,
  isGameRelease,
} from "./feed";
import {
  type ChannelName,
  type Notifier,
  NotifierConfigError,
  createNotifiers,
  resolveChannels,
} from "./notifier";
import type { SendOptions } from "./notify";
import {
  DEFAULT_SEEN_TTL_DAYS,
  type SeenReleasesKV,
  filterUnseen,
  markSeen,
} from "./store";

export interface Env {
  /** KV namespace holding the ids of releases already notified. */
  SEEN_RELEASES: SeenReleasesKV;

  // vars (wrangler.toml)
  FEED_URL?: string;
  MAX_NOTIFICATIONS_PER_RUN?: string | number;
  SEEN_TTL_DAYS?: string | number;
  USER_AGENT?: string;
  /** Active channel: "telegram" (default) or "callmebot". */
  NOTIFIER?: string;
  /**
   * Category a post must carry to be notified. Defaults to the repack
   * category, which filters out the site's recurring non-release posts.
   * Set to an empty string to notify every feed entry.
   */
  REQUIRE_CATEGORY?: string;

  // secrets (wrangler secret put)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_API_KEY?: string;
}

export const DEFAULT_MAX_NOTIFICATIONS_PER_RUN = 5;

/**
 * Pause between notifications within a run.
 *
 * Telegram throttles at roughly one message per second per chat, and answers a
 * burst with 429. Since a 429 is retried once and then falls back to a plain
 * text message, a burst silently costs the cover art — so the sends are paced
 * instead. At the default cap this adds about five seconds to a run.
 */
export const NOTIFY_INTERVAL_MS = 1_200;

export interface RunResult {
  channels: ChannelName[];
  fetched: number;
  /** Entries dropped for not being game releases. */
  filtered: number;
  unseen: number;
  selected: number;
  sent: string[];
  /** Subset of `sent` that were updates to a previously notified repack. */
  updated: string[];
  failed: Array<{ id: string; channel?: ChannelName; error: string }>;
}

export interface DryRunResult {
  dryRun: true;
  channels: ChannelName[];
  feedUrl: string;
  requiredCategory: string;
  maxNotificationsPerRun: number;
  fetched: number;
  filtered: number;
  unseen: number;
  wouldNotify: Array<Release & { isUpdate: boolean }>;
  skipped: number;
}

function parsePositiveInt(
  value: string | number | undefined,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function feedUrlOf(env: Env): string {
  return env.FEED_URL !== undefined && env.FEED_URL !== "" ? env.FEED_URL : DEFAULT_FEED_URL;
}

function requiredCategoryOf(env: Env): string {
  // Only an explicit empty string disables the filter; an unset var keeps it.
  return env.REQUIRE_CATEGORY === undefined ? RELEASE_CATEGORY : env.REQUIRE_CATEGORY;
}

function userAgentOf(env: Env): string {
  return env.USER_AGENT !== undefined && env.USER_AGENT !== ""
    ? env.USER_AGENT
    : DEFAULT_USER_AGENT;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Full pipeline: feed → KV filter → cap → WhatsApp → KV mark.
 *
 * A failure on one release never blocks the remaining ones, and a release is
 * marked as seen only after its own message was delivered.
 */
export async function runNotifier(
  env: Env,
  sendOptions: SendOptions = {},
  /** Injectable pause, so tests do not wait for real pacing. */
  pause: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RunResult> {
  // Throws on a bad channel or missing credentials, before any KV write.
  const notifiers: Notifier[] = createNotifiers(env);

  const maxPerRun = parsePositiveInt(
    env.MAX_NOTIFICATIONS_PER_RUN,
    DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  );
  const ttlDays = parsePositiveInt(env.SEEN_TTL_DAYS, DEFAULT_SEEN_TTL_DAYS);

  // Any failure here aborts the run before a single KV write happens.
  const fetched = await fetchLatestReleases(feedUrlOf(env), userAgentOf(env));
  const requiredCategory = requiredCategoryOf(env);
  // Filtered before the KV lookup, so non-releases never occupy a key.
  const releases = fetched.filter((release) => isGameRelease(release, requiredCategory));
  const unseen = await filterUnseen(releases, env.SEEN_RELEASES);
  const selected = unseen.slice(0, maxPerRun);

  const result: RunResult = {
    channels: notifiers.map((n) => n.channel),
    fetched: fetched.length,
    filtered: fetched.length - releases.length,
    unseen: unseen.length,
    selected: selected.length,
    sent: [],
    updated: [],
    failed: [],
  };

  for (const [index, pending] of selected.entries()) {
    const { release, isUpdate } = pending;

    if (index > 0) {
      await pause(NOTIFY_INTERVAL_MS);
    }

    // Every channel is attempted; one failing must not stop the others.
    let delivered = 0;
    for (const notifier of notifiers) {
      try {
        await notifier.send(release, isUpdate, sendOptions);
        delivered += 1;
      } catch (error) {
        result.failed.push({
          id: release.id,
          channel: notifier.channel,
          error: errorMessage(error),
        });
        console.error(
          `${notifier.channel} delivery failed for ${release.id}: ${errorMessage(error)}`,
        );
      }
    }

    if (delivered === 0) {
      // Nowhere to be seen: leave it unmarked so the next run retries it.
      continue;
    }

    // Marked once at least one channel delivered. Holding the mark back until
    // every channel succeeds would make a persistently broken channel resend
    // the same release on the working ones every 15 minutes.
    try {
      await markSeen(release, env.SEEN_RELEASES, ttlDays);
      result.sent.push(release.id);
      if (isUpdate) {
        result.updated.push(release.id);
      }
    } catch (error) {
      // Delivered but not recorded: log loudly, a duplicate may follow.
      result.failed.push({ id: release.id, error: `KV write failed: ${errorMessage(error)}` });
      console.error(`KV write failed after sending ${release.id}: ${errorMessage(error)}`);
    }
  }

  return result;
}

/** Dry run: read-only, never writes KV and never calls the notification API. */
export async function dryRun(env: Env): Promise<DryRunResult> {
  const maxPerRun = parsePositiveInt(
    env.MAX_NOTIFICATIONS_PER_RUN,
    DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  );
  const feedUrl = feedUrlOf(env);
  const requiredCategory = requiredCategoryOf(env);

  const fetched = await fetchLatestReleases(feedUrl, userAgentOf(env));
  const releases = fetched.filter((release) => isGameRelease(release, requiredCategory));
  const unseen = await filterUnseen(releases, env.SEEN_RELEASES);
  const wouldNotify = unseen.slice(0, maxPerRun);

  return {
    dryRun: true,
    channels: resolveChannels(env.NOTIFIER),
    feedUrl,
    requiredCategory,
    maxNotificationsPerRun: maxPerRun,
    fetched: fetched.length,
    filtered: fetched.length - releases.length,
    unseen: unseen.length,
    wouldNotify: wouldNotify.map((p) => ({ ...p.release, isUpdate: p.isUpdate })),
    skipped: unseen.length - wouldNotify.length,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    try {
      const result = await runNotifier(env);
      console.log(
        `cron ${event.cron} [${result.channels.join("+")}]: fetched=${result.fetched} ` +
          `filtered=${result.filtered} unseen=${result.unseen} ` +
          `sent=${result.sent.length} updates=${result.updated.length} ` +
          `failed=${result.failed.length}`,
      );
    } catch (error) {
      // Feed or KV outage: nothing was written, the next run retries.
      console.error(`Scheduled run aborted: ${errorMessage(error)}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      try {
        return json(await dryRun(env));
      } catch (error) {
        // A misconfigured channel is our fault (500); a broken feed is upstream (502).
        const status = error instanceof NotifierConfigError ? 500 : 502;
        return json({ error: errorMessage(error) }, status);
      }
    }

    if (url.pathname === "/" || url.pathname === "") {
      try {
        return json({
          service: "fitgirl-notificator",
          cron: "*/15 * * * *",
          channels: resolveChannels(env.NOTIFIER),
          endpoints: { dryRun: "GET /test" },
        });
      } catch (error) {
        return json({ error: errorMessage(error) }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
