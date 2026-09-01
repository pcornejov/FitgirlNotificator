import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../src/feed";
import {
  DEFAULT_CHANNEL,
  NotifierConfigError,
  createNotifier,
  createNotifiers,
  resolveChannel,
  resolveChannels,
} from "../src/notifier";

const RELEASE: Release = {
  id: "https://fitgirl-repacks.site/?p=1",
  title: "Test Game",
  link: "https://fitgirl-repacks.site/test-game/",
  publishedAt: "Mon, 01 Sep 2025 08:30:00 +0000",
  categories: ["Lossless Repack"],
};

const TELEGRAM_ENV = {
  TELEGRAM_BOT_TOKEN: "123:token",
  TELEGRAM_CHAT_ID: "42",
};

const CALLMEBOT_ENV = {
  CALLMEBOT_PHONE: "10000000000",
  CALLMEBOT_API_KEY: "key",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveChannel", () => {
  it("defaults to telegram", () => {
    expect(resolveChannel(undefined)).toBe("telegram");
    expect(resolveChannel("")).toBe(DEFAULT_CHANNEL);
  });

  it("accepts both supported channels, case-insensitively", () => {
    expect(resolveChannel("telegram")).toBe("telegram");
    expect(resolveChannel(" CallMeBot ")).toBe("callmebot");
  });

  it("rejects an unknown channel", () => {
    expect(() => resolveChannel("signal")).toThrow(NotifierConfigError);
    expect(() => resolveChannel("signal")).toThrow(/telegram, callmebot/);
  });
});

describe("createNotifier", () => {
  it("builds a telegram notifier by default", () => {
    expect(createNotifier(TELEGRAM_ENV).channel).toBe("telegram");
  });

  it("builds a callmebot notifier when selected", () => {
    expect(createNotifier({ NOTIFIER: "callmebot", ...CALLMEBOT_ENV }).channel).toBe("callmebot");
  });

  it("routes the release to the selected channel's endpoint", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createNotifier(TELEGRAM_ENV).send(RELEASE, false, { sleep: async () => {} });
    await createNotifier({ NOTIFIER: "callmebot", ...CALLMEBOT_ENV }).send(RELEASE, false, {
      sleep: async () => {},
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("api.telegram.org");
    expect(urls[1]).toContain("api.callmebot.com");
  });

  it("fails when the telegram credentials are incomplete", () => {
    expect(() => createNotifier({ TELEGRAM_BOT_TOKEN: "123:token" })).toThrow(
      /TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/,
    );
  });

  it("fails when the callmebot credentials are incomplete", () => {
    expect(() => createNotifier({ NOTIFIER: "callmebot", CALLMEBOT_PHONE: "1" })).toThrow(
      /CALLMEBOT_PHONE and CALLMEBOT_API_KEY/,
    );
  });

  it("does not require the credentials of the inactive channel", () => {
    expect(() => createNotifier({ NOTIFIER: "telegram", ...TELEGRAM_ENV })).not.toThrow();
    expect(() => createNotifier({ NOTIFIER: "callmebot", ...CALLMEBOT_ENV })).not.toThrow();
  });
});

describe("resolveChannels", () => {
  it("defaults to the single default channel", () => {
    expect(resolveChannels(undefined)).toEqual([DEFAULT_CHANNEL]);
    expect(resolveChannels("  ")).toEqual([DEFAULT_CHANNEL]);
  });

  it("parses a comma-separated list, preserving order", () => {
    expect(resolveChannels("callmebot,telegram")).toEqual(["callmebot", "telegram"]);
  });

  it("tolerates spacing and casing", () => {
    expect(resolveChannels(" Telegram , CALLMEBOT ")).toEqual(["telegram", "callmebot"]);
  });

  it("collapses duplicates", () => {
    expect(resolveChannels("telegram,telegram")).toEqual(["telegram"]);
  });

  it("rejects a list containing an unknown channel", () => {
    expect(() => resolveChannels("telegram,signal")).toThrow(NotifierConfigError);
  });
});

describe("createNotifiers", () => {
  it("builds one notifier per configured channel", () => {
    const notifiers = createNotifiers({
      NOTIFIER: "telegram,callmebot",
      ...TELEGRAM_ENV,
      ...CALLMEBOT_ENV,
    });

    expect(notifiers.map((n) => n.channel)).toEqual(["telegram", "callmebot"]);
  });

  it("validates every channel's credentials up front", () => {
    // Telegram is configured, CallMeBot is not: the whole fan-out is refused
    // rather than silently dropping a channel.
    expect(() =>
      createNotifiers({ NOTIFIER: "telegram,callmebot", ...TELEGRAM_ENV }),
    ).toThrow(/CALLMEBOT_PHONE and CALLMEBOT_API_KEY/);
  });

  it("delivers one release to both endpoints", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const notifiers = createNotifiers({
      NOTIFIER: "telegram,callmebot",
      ...TELEGRAM_ENV,
      ...CALLMEBOT_ENV,
    });
    for (const notifier of notifiers) {
      await notifier.send(RELEASE, false, { sleep: async () => {} });
    }

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes("api.telegram.org"))).toBe(true);
    expect(urls.some((u) => u.includes("api.callmebot.com"))).toBe(true);
  });
});
