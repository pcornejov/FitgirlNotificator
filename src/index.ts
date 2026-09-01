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
  type Release,
  fetchLatestReleases,
} from "./feed";
import {
  DEFAULT_SEEN_TTL_DAYS,
  type SeenReleasesKV,
  filterUnseen,
  markSeen,
} from "./store";
import { type SendOptions, sendWhatsAppNotification } from "./whatsapp";

export interface Env {
  /** KV namespace holding the ids of releases already notified. */
  SEEN_RELEASES: SeenReleasesKV;

  // vars (wrangler.toml)
  FEED_URL?: string;
  MAX_NOTIFICATIONS_PER_RUN?: string | number;
  SEEN_TTL_DAYS?: string | number;
  USER_AGENT?: string;

  // secrets (wrangler secret put)
  CALLMEBOT_PHONE?: string;
  CALLMEBOT_API_KEY?: string;
}

export const DEFAULT_MAX_NOTIFICATIONS_PER_RUN = 5;

export interface RunResult {
  fetched: number;
  unseen: number;
  selected: number;
  sent: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface DryRunResult {
  dryRun: true;
  feedUrl: string;
  maxNotificationsPerRun: number;
  fetched: number;
  unseen: number;
  wouldNotify: Release[];
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
): Promise<RunResult> {
  const phone = env.CALLMEBOT_PHONE ?? "";
  const apiKey = env.CALLMEBOT_API_KEY ?? "";
  if (phone === "" || apiKey === "") {
    throw new Error(
      "CALLMEBOT_PHONE and CALLMEBOT_API_KEY must be configured via `wrangler secret put`",
    );
  }

  const maxPerRun = parsePositiveInt(
    env.MAX_NOTIFICATIONS_PER_RUN,
    DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  );
  const ttlDays = parsePositiveInt(env.SEEN_TTL_DAYS, DEFAULT_SEEN_TTL_DAYS);

  // Any failure here aborts the run before a single KV write happens.
  const releases = await fetchLatestReleases(feedUrlOf(env), userAgentOf(env));
  const unseen = await filterUnseen(releases, env.SEEN_RELEASES);
  const selected = unseen.slice(0, maxPerRun);

  const result: RunResult = {
    fetched: releases.length,
    unseen: unseen.length,
    selected: selected.length,
    sent: [],
    failed: [],
  };

  for (const release of selected) {
    try {
      await sendWhatsAppNotification(phone, apiKey, release, sendOptions);
    } catch (error) {
      // Not marked as seen: it will be retried on the next run.
      result.failed.push({ id: release.id, error: errorMessage(error) });
      console.error(`WhatsApp delivery failed for ${release.id}: ${errorMessage(error)}`);
      continue;
    }

    try {
      await markSeen(release.id, env.SEEN_RELEASES, ttlDays);
      result.sent.push(release.id);
    } catch (error) {
      // Delivered but not recorded: log loudly, a duplicate may follow.
      result.failed.push({ id: release.id, error: `KV write failed: ${errorMessage(error)}` });
      console.error(`KV write failed after sending ${release.id}: ${errorMessage(error)}`);
    }
  }

  return result;
}

/** Dry run: read-only, never writes KV and never calls the WhatsApp API. */
export async function dryRun(env: Env): Promise<DryRunResult> {
  const maxPerRun = parsePositiveInt(
    env.MAX_NOTIFICATIONS_PER_RUN,
    DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  );
  const feedUrl = feedUrlOf(env);

  const releases = await fetchLatestReleases(feedUrl, userAgentOf(env));
  const unseen = await filterUnseen(releases, env.SEEN_RELEASES);
  const wouldNotify = unseen.slice(0, maxPerRun);

  return {
    dryRun: true,
    feedUrl,
    maxNotificationsPerRun: maxPerRun,
    fetched: releases.length,
    unseen: unseen.length,
    wouldNotify,
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
        `cron ${event.cron}: fetched=${result.fetched} unseen=${result.unseen} ` +
          `sent=${result.sent.length} failed=${result.failed.length}`,
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
        return json({ error: errorMessage(error) }, 502);
      }
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "fitgirl-notificator",
        cron: "*/15 * * * *",
        endpoints: { dryRun: "GET /test" },
      });
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
