import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFeed } from "../src/feed";
import worker, { type Env, NOTIFY_INTERVAL_MS, dryRun, runNotifier } from "../src/index";
import { UPCOMING_KEY, versionKey } from "../src/store";
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

const FIXTURE = parseFeed(FITGIRL_FEED_XML);

/** KV key for the exact version of a fixture release. */
function vkey(id: string): string {
  return versionKey(FIXTURE.find((r) => r.id === id) as (typeof FIXTURE)[number]);
}

/**
 * Every key a completed run writes: the two markSeen writes per release, plus
 * the upcoming list it records.
 */
function keysFor(ids: string[]): string[] {
  return [...ids, ...ids.map(vkey), UPCOMING_KEY].sort();
}

interface Scenario {
  kv: MemoryKV;
  env: Env;
  fetchMock: ReturnType<typeof vi.fn>;
  /** The notification requests actually issued. */
  notified: () => Sent[];
}

/** One outbound notification request, with whatever body it carried. */
interface Sent {
  url: URL;
  init: RequestInit | undefined;
}

function isNotificationUrl(url: URL): boolean {
  return url.origin === TELEGRAM_API_BASE || url.href.startsWith(CALLMEBOT_ENDPOINT);
}

/**
 * The message text, whichever shape produced the request: `text` for
 * sendMessage and CallMeBot, `caption` for sendPhoto.
 */
function textOf(sent: Sent): string {
  return (
    sent.url.searchParams.get("text") ?? sent.url.searchParams.get("caption") ?? ""
  );
}

/**
 * Mocks the feed and both notification endpoints on a single global fetch.
 * `notificationStatus` decides the HTTP status per notification request.
 */
function scenario(
  overrides: Partial<Env> = {},
  notificationStatus: (sent: Sent, call: number) => number = () => 200,
): Scenario {
  const kv = new MemoryKV();
  const sent: Sent[] = [];
  let call = 0;

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    if (isNotificationUrl(url)) {
      const entry: Sent = { url, init };
      sent.push(entry);
      call += 1;
      const status = notificationStatus(entry, call);
      // Each channel has its own success shape: JSON for Telegram, an HTML
      // confirmation for CallMeBot.
      const body = url.origin === TELEGRAM_API_BASE
        ? JSON.stringify({ ok: status === 200 })
        : status === 200
          ? "<p><b>Message queued.</b> You will receive it in a few seconds."
          : "<p><b>APIKey is invalid.</b>";
      return new Response(body, { status });
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

    expect(result.channels).toEqual(["telegram"]);
    expect(result.fetched).toBe(4);
    expect(result.filtered).toBe(2);
    expect(result.sent).toEqual(RELEASE_IDS);
    expect(result.failed).toEqual([]);
    expect(notified()).toHaveLength(2);
    expect([...kv.entries.keys()].sort()).toEqual(keysFor(RELEASE_IDS));
  });

  it("sends only the releases not seen before", async () => {
    const { env, kv, notified } = scenario();
    kv.seed(vkey(RELEASE_IDS[0] as string));

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.unseen).toBe(1);
    expect(result.sent).toEqual([RELEASE_IDS[1]]);
    expect(notified()).toHaveLength(1);
    expect(textOf(notified()[0] as Sent)).toContain("Cyber Drift 2 &amp; The Lost City");
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
    expect(kv.entries.has(vkey(RELEASE_IDS[1] as string))).toBe(false);

    // The deferred release goes out on the following run.
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});
    expect(second.sent).toEqual([RELEASE_IDS[1]]);
  });

  it("does not mark a release as seen when delivery fails", async () => {
    // Every attempt for the second release fails with a non-retryable 400.
    const { env, kv } = scenario({}, (sent) =>
      textOf(sent).includes("Cyber Drift") ? 400 : 200,
    );

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.sent).toEqual([RELEASE_IDS[0]]);
    expect(result.failed.map((f) => f.id)).toEqual([RELEASE_IDS[1]]);
    expect(kv.entries.has(vkey(RELEASE_IDS[1] as string))).toBe(false);
  });

  it("retries the failed release on the next run", async () => {
    let failFirstBatch = true;
    const { env, kv } = scenario({}, (sent) =>
      failFirstBatch && textOf(sent).includes("Cyber Drift") ? 400 : 200,
    );

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    failFirstBatch = false;
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.sent).toEqual([RELEASE_IDS[1]]);
    expect(kv.entries.has(vkey(RELEASE_IDS[1] as string))).toBe(true);
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

    expect(notified().every((s) => s.url.origin === TELEGRAM_API_BASE)).toBe(true);
  });

  it("switches to CallMeBot with NOTIFIER=callmebot and no code change", async () => {
    const { env, kv, notified } = scenario({
      NOTIFIER: "callmebot",
      ...CALLMEBOT_SECRETS,
    });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.channels).toEqual(["callmebot"]);
    expect(notified()).toHaveLength(2);
    expect(notified().every((s) => s.url.href.startsWith(CALLMEBOT_ENDPOINT))).toBe(true);
    expect([...kv.entries.keys()].sort()).toEqual(keysFor(RELEASE_IDS));
  });

  it("does not require the inactive channel's credentials", async () => {
    const { env, notified } = scenario({ NOTIFIER: "callmebot", ...CALLMEBOT_SECRETS });
    delete env.TELEGRAM_BOT_TOKEN;
    delete env.TELEGRAM_CHAT_ID;

    await expect(runNotifier(env, { sleep: async () => {} }, async () => {})).resolves.toMatchObject({
      channels: ["callmebot"],
    });
    expect(notified()).toHaveLength(2);
  });
});

describe("dryRun", () => {
  it("reports what would be sent without touching KV or the notification API", async () => {
    const { env, kv, notified } = scenario({ MAX_NOTIFICATIONS_PER_RUN: "1" });

    const result = await dryRun(env);

    expect(result.dryRun).toBe(true);
    expect(result.channels).toEqual(["telegram"]);
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
    expect(await response.json()).toMatchObject({ channels: ["callmebot"] });
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
    kv.seed(vkey(RELEASE_IDS[0] as string), RELEASE_IDS[0] as string);

    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledController,
      env,
    );

    expect(notified()).toHaveLength(1);
    expect([...kv.entries.keys()].sort()).toEqual(keysFor(RELEASE_IDS));
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
    const texts = notified().map((n) => textOf(n));
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
    expect(textOf(notified()[0] as Sent)).toContain("Updates Digest");
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
    const { env } = scenario({}, (sent) => (textOf(sent).includes("Cyber Drift") ? 400 : 200));
    const pauses: number[] = [];

    await runNotifier(env, { sleep: async () => {} }, async (ms) => {
      pauses.push(ms);
    });

    expect(pauses).toEqual([NOTIFY_INTERVAL_MS]);
  });
});

describe("updated repacks", () => {
  /** The fixture, with the first repack republished under a later date. */
  const REPUBLISHED_XML = FITGIRL_FEED_XML.replace(
    "<pubDate>Mon, 01 Sep 2025 08:30:00 +0000</pubDate>",
    "<pubDate>Fri, 12 Sep 2025 11:00:00 +0000</pubDate>",
  );

  it("notifies again when a repack is updated and reposted", async () => {
    const { env, kv, fetchMock, notified } = scenario();

    // First run: both repacks go out as new releases.
    const first = await runNotifier(env, { sleep: async () => {} }, async () => {});
    expect(first.sent).toEqual(RELEASE_IDS);
    expect(first.updated).toEqual([]);

    // The site republishes the first repack with a newer date.
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href === FEED_URL) {
        return new Response(REPUBLISHED_XML, { status: 200 });
      }
      notified().push({ url, init });
      return new Response(
        url.origin === TELEGRAM_API_BASE
          ? JSON.stringify({ ok: true })
          : "<p><b>Message queued.</b>",
        { status: 200 },
      );
    });

    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.sent).toEqual([RELEASE_IDS[0]]);
    expect(second.updated).toEqual([RELEASE_IDS[0]]);
    // Both versions are now recorded, so neither repeats.
    expect(kv.entries.has(vkey(RELEASE_IDS[0] as string))).toBe(true);
  });

  it("labels an update differently from a new release", async () => {
    const { env, notified } = scenario();
    await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(textOf(notified()[0] as Sent)).toContain("Nuevo Release");
    expect(textOf(notified()[0] as Sent)).not.toContain("actualizado");
  });

  it("does not re-notify a repack whose publish date has not changed", async () => {
    const { env, notified } = scenario();

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.sent).toEqual([]);
    expect(notified()).toHaveLength(2);
  });
});

describe("multi-channel delivery", () => {
  const BOTH: Partial<Env> = {
    NOTIFIER: "telegram,callmebot",
    ...CALLMEBOT_SECRETS,
  };

  function byChannel(sent: Sent[]): { telegram: Sent[]; callmebot: Sent[] } {
    return {
      telegram: sent.filter((s) => s.url.origin === TELEGRAM_API_BASE),
      callmebot: sent.filter((s) => s.url.href.startsWith(CALLMEBOT_ENDPOINT)),
    };
  }

  it("sends every release to both channels", async () => {
    const { env, kv, notified } = scenario(BOTH);

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.channels).toEqual(["telegram", "callmebot"]);
    expect(result.sent).toEqual(RELEASE_IDS);
    const split = byChannel(notified());
    expect(split.telegram).toHaveLength(2);
    expect(split.callmebot).toHaveLength(2);
    expect([...kv.entries.keys()].sort()).toEqual(keysFor(RELEASE_IDS));
  });

  it("keeps delivering on one channel when the other fails", async () => {
    const { env, kv, notified } = scenario(BOTH, (sent) =>
      sent.url.href.startsWith(CALLMEBOT_ENDPOINT) ? 400 : 200,
    );

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(byChannel(notified()).telegram).toHaveLength(2);
    // Delivered somewhere, so it is marked and never resent on Telegram.
    expect(result.sent).toEqual(RELEASE_IDS);
    expect(result.failed.map((f) => f.channel)).toEqual(["callmebot", "callmebot"]);
    expect([...kv.entries.keys()].sort()).toEqual(keysFor(RELEASE_IDS));
  });

  it("does not resend on the healthy channel while the other stays broken", async () => {
    const { env, notified } = scenario(BOTH, (sent) =>
      sent.url.href.startsWith(CALLMEBOT_ENDPOINT) ? 400 : 200,
    );

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.sent).toEqual([]);
    expect(byChannel(notified()).telegram).toHaveLength(2);
  });

  it("leaves a release unmarked only when every channel fails", async () => {
    const { env, kv } = scenario(BOTH, () => 400);

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.sent).toEqual([]);
    expect(result.failed).toHaveLength(4); // two releases x two channels
    // No release was recorded; the upcoming list is independent of them.
    for (const id of RELEASE_IDS) {
      expect(kv.entries.has(id)).toBe(false);
      expect(kv.entries.has(vkey(id))).toBe(false);
    }

    // Both channels recover: the releases go out on the next run.
    const { env: healthy } = scenario(BOTH);
    healthy.SEEN_RELEASES = kv;
    const second = await runNotifier(healthy, { sleep: async () => {} }, async () => {});
    expect(second.sent).toEqual(RELEASE_IDS);
  });

  it("reports both channels in the dry run", async () => {
    const { env } = scenario(BOTH);

    await expect(dryRun(env)).resolves.toMatchObject({
      channels: ["telegram", "callmebot"],
    });
  });

  it("refuses to run when one of the two channels lacks credentials", async () => {
    const { env, notified } = scenario({ NOTIFIER: "telegram,callmebot" });

    await expect(runNotifier(env, {}, async () => {})).rejects.toThrow(
      /CALLMEBOT_PHONE and CALLMEBOT_API_KEY/,
    );
    expect(notified()).toHaveLength(0);
  });
});

describe("upcoming repacks", () => {
  const LISTED = ["Tiny Bakery", "Sunken Engine", "Dante’s Bloodline", "Cyber Drift 2"];

  function upcomingMessages(sent: Sent[]): string[] {
    return sent.map((s) => textOf(s)).filter((t) => t.includes("próximos repacks"));
  }

  it("records the list on the first run without announcing it", async () => {
    const { env, kv, notified } = scenario();

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.upcomingAdded).toEqual([]);
    expect(upcomingMessages(notified())).toEqual([]);
    expect(JSON.parse(kv.entries.get(UPCOMING_KEY)?.value ?? "[]")).toEqual(LISTED);
  });

  it("announces only the titles added since the previous run", async () => {
    const { env, kv, notified } = scenario();
    // Everything except the last title was already known.
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify(LISTED.slice(0, 2)) });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.upcomingAdded).toEqual(["Dante’s Bloodline"]);
    const messages = upcomingMessages(notified());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🆕 Dante’s Bloodline");
    // The full list rides along as a reminder of everything still coming.
    expect(messages[0]).toContain("Todos los próximos (3)");
    expect(messages[0]).toContain("• Tiny Bakery");
    expect(messages[0]).not.toContain("🆕 Tiny Bakery");
  });

  it("says nothing when the list has not changed", async () => {
    const { env, notified } = scenario();

    await runNotifier(env, { sleep: async () => {} }, async () => {});
    const second = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(second.upcomingAdded).toEqual([]);
    expect(upcomingMessages(notified())).toEqual([]);
  });

  it("keeps the stored list current when titles only disappear", async () => {
    const { env, kv, notified } = scenario();
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify([...LISTED, "Released Already"]) });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.upcomingAdded).toEqual([]);
    expect(upcomingMessages(notified())).toEqual([]);
    expect(JSON.parse(kv.entries.get(UPCOMING_KEY)?.value ?? "[]")).toEqual(LISTED);
  });

  it("retries the additions next run when the announcement fails", async () => {
    const { env, kv, notified } = scenario({}, (sent) =>
      textOf(sent).includes("próximos repacks") ? 400 : 200,
    );
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify(LISTED.slice(0, 2)) });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.upcomingAdded).toEqual([]);
    expect(result.failed.map((f) => f.id)).toContain("upcoming");
    // The stored list is untouched, so the addition is not lost.
    expect(JSON.parse(kv.entries.get(UPCOMING_KEY)?.value ?? "[]")).toEqual(LISTED.slice(0, 2));
    expect(upcomingMessages(notified())).toHaveLength(1);
  });

  it("stays silent when NOTIFY_UPCOMING is false", async () => {
    const { env, kv, notified } = scenario({ NOTIFY_UPCOMING: "false" });
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify(LISTED.slice(0, 2)) });

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.upcomingAdded).toEqual([]);
    expect(upcomingMessages(notified())).toEqual([]);
  });

  it("reports the pending additions in the dry run without writing KV", async () => {
    const { env, kv, notified } = scenario();
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify(LISTED.slice(0, 2)) });

    const result = await dryRun(env);

    expect(result.upcoming.tracking).toBe(true);
    expect(result.upcoming.listed).toBe(4);
    expect(result.upcoming.wouldAnnounce).toEqual(["Dante’s Bloodline", "Cyber Drift 2"]);
    expect(kv.putCalls).toBe(0);
    expect(notified()).toHaveLength(0);
  });
});

describe("upcoming dry run before a baseline exists", () => {
  it("reports that it is not tracking yet", async () => {
    const { env } = scenario();

    const result = await dryRun(env);

    expect(result.upcoming.tracking).toBe(false);
    expect(result.upcoming.listed).toBe(4);
    expect(result.upcoming.wouldAnnounce).toEqual([]);
  });
});

describe("upcoming list alongside releases", () => {
  function upcomingMessages(sent: Sent[]): string[] {
    return sent.map((s) => textOf(s)).filter((t) => t.includes("Todos los próximos"));
  }

  /** A baseline that matches the fixture, so nothing counts as an addition. */
  function seedCurrentList(kv: MemoryKV): void {
    kv.entries.set(UPCOMING_KEY, {
      value: JSON.stringify(["Tiny Bakery", "Sunken Engine", "Dante’s Bloodline", "Cyber Drift 2"]),
    });
  }

  it("sends the list as a reminder when a release goes out", async () => {
    const { env, kv, notified } = scenario();
    seedCurrentList(kv);

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.sent).toEqual(RELEASE_IDS);
    expect(result.upcomingSent).toBe(true);
    expect(result.upcomingAdded).toEqual([]);
    const messages = upcomingMessages(notified());
    expect(messages).toHaveLength(1);
    // No additions, so the message is the standing list on its own.
    expect(messages[0]).not.toContain("🆕");
  });

  it("drops the game it just published from the list", async () => {
    const { env, kv, notified } = scenario();
    seedCurrentList(kv);

    await runNotifier(env, { sleep: async () => {} }, async () => {});

    const message = upcomingMessages(notified())[0] as string;
    // "Cyber Drift 2" was released in this run, so it is no longer coming.
    expect(message).not.toContain("Cyber Drift 2");
    expect(message).toContain("Todos los próximos (3)");
    expect(message).toContain("• Tiny Bakery");
  });

  it("sends one list even when several releases go out", async () => {
    const { env, kv, notified } = scenario();
    seedCurrentList(kv);

    await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(upcomingMessages(notified())).toHaveLength(1);
  });

  it("stays silent when nothing was released and nothing was added", async () => {
    const { env, kv, notified } = scenario();
    seedCurrentList(kv);
    // Mark both releases as already notified.
    for (const id of RELEASE_IDS) kv.seed(vkey(id), id);

    const result = await runNotifier(env, { sleep: async () => {} }, async () => {});

    expect(result.sent).toEqual([]);
    expect(result.upcomingSent).toBe(false);
    expect(upcomingMessages(notified())).toEqual([]);
  });

  it("combines additions and the reminder into a single message", async () => {
    const { env, kv, notified } = scenario();
    kv.entries.set(UPCOMING_KEY, { value: JSON.stringify(["Tiny Bakery", "Sunken Engine"]) });

    await runNotifier(env, { sleep: async () => {} }, async () => {});

    const messages = upcomingMessages(notified());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("🆕 Dante’s Bloodline");
    expect(messages[0]).toContain("📋");
  });
});
