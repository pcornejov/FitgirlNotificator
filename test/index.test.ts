import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, NOTIFY_INTERVAL_MS, dryRun, runNotifier } from "../src/index";
import { TELEGRAM_API_BASE } from "../src/telegram";
import { CALLMEBOT_ENDPOINT } from "../src/whatsapp";
import { FITGIRL_FEED_XML } from "./fixtures";
import { MemoryKV } from "./kv";

const FEED_URL = "https://fitgirl-repacks.site/feed/";

const TELEGRAM_SECRETS = { TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_CHAT_ID: "42" };
const CALLMEBOT_SECRETS = { CALLMEBOT_PHONE: "10000000000", CALLMEBOT_API_KEY: "key" };

/** The two actual repacks in the fixture, in feed order. */
const RELEASE_IDS = [
  "https://fitgirl-repacks.site/?p=48211",
  "https://fitgirl-repacks.site/?p=48190",
];

/** Recurring posts that are not game releases. */
const NON_RELEASE_IDS = [
  "https://fitgirl-repacks.site/upcoming-repacks/",
  "https://fitgirl-repacks.site/?p=48001",
];

interface Scenario {
  kv: MemoryKV;
  env: Env;
  fetchMock: ReturnType<typeof vi.fn>;
  /** URLs of the notification requests actually issued. */
  notified: () => URL[];
}

function isNotificationUrl(url: URL): boolean {
  return url.origin === TELEGRAM_API_BASE || url.href.startsWith(CALLMEBOT_ENDPOINT);
}

/** The message text, whichever channel produced the request. */
function textOf(url: URL): string {
  return url.searchParams.get("text") ?? "";
}

/**
 * Mocks the feed and both notification endpoints on a single global fetch.
 * `notificationStatus` decides the HTTP status per notification request.
 */
function scenario(
  overrides: Partial<Env> = {},
  notificationStatus: (url: URL, call: number) => number = () => 200,
): Scenario {
  const kv = new MemoryKV();
  const sent: URL[] = [];
  let call = 0;

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    if (isNotificationUrl(url)) {
      sent.push(url);
      call += 1;
      const status = notificationStatus(url, call);
      return new Response(JSON.stringify({ ok: status === 200 }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.href === FEED_URL) {
      return new Response(FITGIRL_FEED_XML, { status: 200 });
    }

    throw new Error(`Unexpected fetch to ${url.href}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const env: Env = {
    SEEN_RELEASES: kv,
    FEED_URL,
    MAX_NOTIFICATIONS_PER_RUN: "5",
    SEEN_TTL_DAYS: "30",
    ...TELEGRAM_SECRETS,
    ...overrides,
  };

  return { kv, env, fetchMock, notified: () => sent };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runNotifier", () => {
  it("notifies every new release and records them in KV", async () => {
    const { env, kv, notified } = scenario();

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.channel).toBe("telegram");
    expect(result.fetched).toBe(4);
    expect(result.filtered).toBe(2);
    expect(result.sent).toEqual(RELEASE_IDS);
    expect(result.failed).toEqual([]);
    expect(notified()).toHaveLength(2);
    expect([...kv.entries.keys()].sort()).toEqual([...RELEASE_IDS].sort());
  });

  it("sends only the releases not seen before", async () => {
    const { env, kv, notified } = scenario();
    kv.seed(RELEASE_IDS[0] as string);

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.unseen).toBe(1);
    expect(result.sent).toEqual([RELEASE_IDS[1]]);
    expect(notified()).toHaveLength(1);
    expect(textOf(notified()[0] as URL)).toContain("Cyber Drift 2 &amp; The Lost City");
  });

  it("is idempotent across consecutive runs", async () => {
    const { env, notified } = scenario();

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.unseen).toBe(0);
    expect(second.sent).toEqual([]);
    expect(notified()).toHaveLength(2);
  });

  it("caps the batch at MAX_NOTIFICATIONS_PER_RUN and defers the rest", async () => {
    const { env, kv, notified } = scenario({ MAX_NOTIFICATIONS_PER_RUN: "1" });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.unseen).toBe(2);
    expect(result.selected).toBe(1);
    expect(notified()).toHaveLength(1);
    expect(kv.entries.has(RELEASE_IDS[1] as string)).toBe(false);

    // The deferred release goes out on the following run.
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});
    expect(second.sent).toEqual([RELEASE_IDS[1]]);
  });

  it("does not mark a release as seen when delivery fails", async () => {
    // Every attempt for the second release fails with a non-retryable 400.
    const { env, kv } = scenario({}, (url) =>
      textOf(url).includes("Cyber Drift") ? 400 : 200,
    );

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.sent).toEqual([RELEASE_IDS[0]]);
    expect(result.failed.map((f) => f.id)).toEqual([RELEASE_IDS[1]]);
    expect(kv.entries.has(RELEASE_IDS[1] as string)).toBe(false);
  });

  it("retries the failed release on the next run", async () => {
    let failFirstBatch = true;
    const { env, kv } = scenario({}, (url) =>
      failFirstBatch && textOf(url).includes("Cyber Drift") ? 400 : 200,
    );

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    failFirstBatch = false;
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.sent).toEqual([RELEASE_IDS[1]]);
    expect(kv.entries.has(RELEASE_IDS[1] as string)).toBe(true);
  });

  it("writes nothing to KV when the feed request fails", async () => {
    const kv = new MemoryKV();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    const env: Env = { SEEN_RELEASES: kv, FEED_URL, ...TELEGRAM_SECRETS };

    await expect(runNotifier(env, { sleep: async () => {} }, async () => {})).rejects.toThrow(/403/);
    expect(kv.putCalls).toBe(0);
  });

  it("refuses to run without the active channel's credentials", async () => {
    const { env, notified } = scenario({ TELEGRAM_CHAT_ID: "" });

    await expect(runNotifier(env, {}, async () => {})).rejects.toThrow(/wrangler secret put/);
    expect(notified()).toHaveLength(0);
  });

  it("refuses to run with an unknown NOTIFIER", async () => {
    const { env, notified } = scenario({ NOTIFIER: "signal" });

    await expect(runNotifier(env, {}, async () => {})).rejects.toThrow(/Unknown NOTIFIER/);
    expect(notified()).toHaveLength(0);
  });
});

describe("channel selection", () => {
  it("uses Telegram by default", async () => {
    const { env, notified } = scenario();

    await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(notified().every((u) => u.origin === TELEGRAM_API_BASE)).toBe(true);
  });

  it("switches to CallMeBot with NOTIFIER=callmebot and no code change", async () => {
    const { env, kv, notified } = scenario({
      NOTIFIER: "callmebot",
      ...CALLMEBOT_SECRETS,
    });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.channel).toBe("callmebot");
    expect(notified()).toHaveLength(2);
    expect(notified().every((u) => u.href.startsWith(CALLMEBOT_ENDPOINT))).toBe(true);
    expect([...kv.entries.keys()].sort()).toEqual([...RELEASE_IDS].sort());
  });

  it("does not require the inactive channel's credentials", async () => {
    const { env, notified } = scenario({ NOTIFIER: "callmebot", ...CALLMEBOT_SECRETS });
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_CHAT_ID;

    await expect(runNotifier(env, { sleep: async () => {} }, async () => {})).resolves.toMatchObject({
      channel: "callmebot",
    });
    expect(notified()).toHaveLength(2);
  });
});

describe("dryRun", () => {
  it("reports what would be sent without touching KV or the notification API", async () => {
    const { env, kv, notified } = scenario({ MAX_NOTIFICATIONS_PER_RUN: "1" });

    const result = await dryRun(env);

    expect(result.dryRun).toBe(true);
    expect(result.channel).toBe("telegram");
    expect(result.fetched).toBe(4);
    expect(result.filtered).toBe(2);
    expect(result.requiredCategory).toBe("Lossless Repack");
    expect(result.unseen).toBe(2);
    expect(result.wouldNotify.map((r) => r.id)).toEqual(RELEASE_IDS.slice(0, 1));
    expect(result.skipped).toBe(1);
    expect(kv.putCalls).toBe(0);
    expect(notified()).toHaveLength(0);
  });

  it("works before any secret is configured", async () => {
    const { env, notified } = scenario();
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_CHAT_ID;

    await expect(dryRun(env)).resolves.toMatchObject({ dryRun: true, fetched: 4 });
    expect(notified()).toHaveLength(0);
  });
});

describe("worker handlers", () => {
  it("GET /test returns valid JSON and mutates nothing", async () => {
    const { env, kv, notified } = scenario();

    const response = await worker.fetch(new Request("https://worker.dev/test"), env);
    const body = (await response.json()) as { dryRun: boolean; wouldNotify: unknown[] };

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(body.dryRun).toBe(true);
    expect(body.wouldNotify).toHaveLength(2);
    expect(kv.putCalls).toBe(0);
    expect(notified()).toHaveLength(0);
  });

  it("GET /test reports feed errors as 502 without throwing", async () => {
    const kv = new MemoryKV();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const response = await worker.fetch(new Request("https://worker.dev/test"), {
      SEEN_RELEASES: kv,
      FEED_URL,
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("500") });
    expect(kv.putCalls).toBe(0);
  });

  it("GET /test reports a bad NOTIFIER as 500", async () => {
    const { env } = scenario({ NOTIFIER: "signal" });

    const response = await worker.fetch(new Request("https://worker.dev/test"), env);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Unknown NOTIFIER"),
    });
  });

  it("GET / reports the active channel", async () => {
    const { env } = scenario({ NOTIFIER: "callmebot", ...CALLMEBOT_SECRETS });

    const response = await worker.fetch(new Request("https://worker.dev/"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ channel: "callmebot" });
  });

  it("rejects non-GET requests to /test", async () => {
    const { env } = scenario();
    const response = await worker.fetch(
      new Request("https://worker.dev/test", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(405);
  });

  it("returns 404 for unknown paths", async () => {
    const { env } = scenario();
    const response = await worker.fetch(new Request("https://worker.dev/nope"), env);
    expect(response.status).toBe(404);
  });

  it("scheduled sends only new releases and keeps KV consistent", async () => {
    const { env, kv, notified } = scenario();
    kv.seed(RELEASE_IDS[0] as string);

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController,
      env,
    );

    expect(notified()).toHaveLength(1);
    expect([...kv.entries.keys()].sort()).toEqual([...RELEASE_IDS].sort());
  });

  it("scheduled swallows a feed outage without writing to KV", async () => {
    const kv = new MemoryKV();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(
      worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController, {
        SEEN_RELEASES: kv,
        FEED_URL,
        ...TELEGRAM_SECRETS,
      }),
    ).resolves.toBeUndefined();

    expect(kv.putCalls).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it("scheduled swallows a credentials outage without writing to KV", async () => {
    const { env, kv, notified } = scenario({ TELEGRAM_BOT_TOKEN: "" });

    await expect(
      worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController,
        env,
      ),
    ).resolves.toBeUndefined();

    expect(kv.putCalls).toBe(0);
    expect(notified()).toHaveLength(0);
  });
});

describe("release filtering", () => {
  it("never notifies the site's non-release posts", async () => {
    const { env, kv, notified } = scenario();

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.filtered).toBe(2);
    const texts = notified().map((u) => textOf(u));
    expect(texts.some((t) => t.includes("Upcoming Repacks"))).toBe(false);
    expect(texts.some((t) => t.includes("Updates Digest"))).toBe(false);
    // Filtered out before the KV lookup, so they never occupy a key either.
    for (const id of NON_RELEASE_IDS) {
      expect(kv.entries.has(id)).toBe(false);
    }
  });

  it("does not spend the per-run budget on filtered posts", async () => {
    const { env, notified } = scenario({ MAX_NOTIFICATIONS_PER_RUN: "2" });

    await runNotifier(env, { sleep: async () => {} }, async () => {});

    // Both real releases go out even though the feed holds 4 entries.
    expect(notified()).toHaveLength(2);
  });

  it("notifies everything when REQUIRE_CATEGORY is empty", async () => {
    const { env, notified } = scenario({ REQUIRE_CATEGORY: "" });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.filtered).toBe(0);
    expect(notified()).toHaveLength(4);
  });

  it("honours a custom required category", async () => {
    const { env, notified } = scenario({ REQUIRE_CATEGORY: "Updates Digest" });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.filtered).toBe(3);
    expect(notified()).toHaveLength(1);
    expect(textOf(notified()[0] as URL)).toContain("Updates Digest");
  });
});

describe("pacing", () => {
  it("pauses between notifications but not before the first", async () => {
    const { env } = scenario();
    const pauses: number[] = [];

    const result = await runNotifier(env, { sleep: async () => {} }, async (ms) => {
      pauses.push(ms);
    });

    // Two releases sent -> exactly one pause between them.
    expect(result.sent).toHaveLength(2);
    expect(pauses).toEqual([NOTIFY_INTERVAL_MS]);
  });

  it("still paces when a send fails, so one failure cannot burst the rest", async () => {
    const { env } = scenario({}, (url) => (textOf(url).includes("Cyber Drift") ? 400 : 200));
    const pauses: number[] = [];

    await runNotifier(env, { sleep: async () => {} }, async (ms) => {
      pauses.push(ms);
    });

    expect(pauses).toEqual([NOTIFY_INTERVAL_MS]);
  });
});
