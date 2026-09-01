import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../src/feed";
import { NotificationError } from "../src/notify";
import {
  MAX_COVER_BYTES,
  TELEGRAM_API_BASE,
  buildRequestUrl,
  escapeHtml,
  formatMessage,
  sendTelegramNotification,
} from "../src/telegram";

const TOKEN = "123456:test-bot-token";
const CHAT_ID = "987654321";

const RELEASE: Release = {
  id: "https://fitgirl-repacks.site/?p=48211",
  title: "Cyber Drift 2 & The Lost City",
  link: "https://fitgirl-repacks.site/cyber-drift-2/",
  publishedAt: "Mon, 01 Sep 2025 08:30:00 +0000",
  categories: ["Lossless Repack"],
};

type Step = { status: number; body?: unknown } | Error;

function mockFetchSequence(steps: Step[]): ReturnType<typeof vi.fn> {
  let call = 0;
  const impl = vi.fn(async () => {
    const next = steps[Math.min(call, steps.length - 1)] as Step;
    call += 1;
    if (next instanceof Error) {
      throw next;
    }
    return new Response(JSON.stringify(next.body ?? { ok: true, result: { message_id: 1 } }), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("formatMessage", () => {
  it("uses HTML bold and includes title and link", () => {
    expect(formatMessage(RELEASE)).toBe(
      "🎮 <b>Nuevo Release en FitGirl</b>\n\nCyber Drift 2 &amp; The Lost City\n\n🔗 https://fitgirl-repacks.site/cyber-drift-2/",
    );
  });

  it("escapes HTML-significant characters in the title", () => {
    const message = formatMessage({ ...RELEASE, title: "<Game> & <Co>" });
    expect(message).toContain("&lt;Game&gt; &amp; &lt;Co&gt;");
    // The formatting tag we add ourselves must survive intact.
    expect(message).toContain("<b>Nuevo Release en FitGirl</b>");
  });

  it("does not break on titles with Markdown-hostile characters", () => {
    const title = "F.E.A.R. 3 - Director's Cut (v1.2) [MULTi9]";
    expect(formatMessage({ ...RELEASE, title })).toContain(title);
  });
});

describe("escapeHtml", () => {
  it("escapes only &, < and >", () => {
    expect(escapeHtml("a & b < c > d 'e' \"f\"")).toBe("a &amp; b &lt; c &gt; d 'e' \"f\"");
  });
});

describe("buildRequestUrl", () => {
  it("targets sendMessage with an encoded query", () => {
    const url = new URL(buildRequestUrl(TOKEN, CHAT_ID, formatMessage(RELEASE)));

    expect(url.origin).toBe(TELEGRAM_API_BASE);
    expect(url.pathname).toBe(`/bot${encodeURIComponent(TOKEN)}/sendMessage`);
    expect(url.searchParams.get("chat_id")).toBe(CHAT_ID);
    expect(url.searchParams.get("parse_mode")).toBe("HTML");
    expect(url.searchParams.get("text")).toBe(formatMessage(RELEASE));
    expect(url.search).not.toMatch(/[\s\n]/);
  });

  it("supports channel usernames as chat id", () => {
    const url = new URL(buildRequestUrl(TOKEN, "@mi_canal", "hola"));
    expect(url.searchParams.get("chat_id")).toBe("@mi_canal");
  });
});

describe("sendTelegramNotification", () => {
  it("performs a single GET request on success", async () => {
    const fetchMock = mockFetchSequence([{ status: 200 }]);

    await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep: async () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toContain("/sendMessage?");
  });

  it("retries once with backoff on a 500 and succeeds", async () => {
    const fetchMock = mockFetchSequence([{ status: 500 }, { status: 200 }]);
    const sleep = vi.fn(async () => {});

    await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep, retryDelayMs: 2000 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does NOT retry on a 401 (bad token)", async () => {
    const fetchMock = mockFetchSequence([
      { status: 401, body: { ok: false, description: "Unauthorized" } },
    ]);
    const sleep = vi.fn(async () => {});

    const error = await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep }).catch(
      (e: unknown) => e,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).status).toBe(401);
    expect((error as NotificationError).channel).toBe("telegram");
  });

  it("does NOT retry on a 400 (bad chat id)", async () => {
    const fetchMock = mockFetchSequence([
      { status: 400, body: { ok: false, description: "chat not found" } },
      { status: 200 },
    ]);

    await expect(
      sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep: async () => {} }),
    ).rejects.toBeInstanceOf(NotificationError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a network error / timeout", async () => {
    const fetchMock = mockFetchSequence([new Error("The operation was aborted"), { status: 200 }]);
    const sleep = vi.fn(async () => {});

    await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("treats ok:false behind a 200 as a failure", async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: { ok: false, description: "chat not found" } },
    ]);

    const error = await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, {
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotificationError);
    expect((error as NotificationError).message).toContain("chat not found");
    // Semantic rejection: resending the identical payload would fail again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a 200 whose body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    await expect(
      sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep: async () => {} }),
    ).resolves.toBeUndefined();
  });

  it("fails fast when credentials are missing", async () => {
    const fetchMock = mockFetchSequence([{ status: 200 }]);

    await expect(sendTelegramNotification("", CHAT_ID, RELEASE)).rejects.toBeInstanceOf(
      NotificationError,
    );
    await expect(sendTelegramNotification(TOKEN, "", RELEASE)).rejects.toBeInstanceOf(
      NotificationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cover images", () => {
  const COVER_URL = "https://i2.imageban.ru/out/2026/09/01/cover.jpg";
  const WITH_IMAGE: Release = { ...RELEASE, imageUrl: COVER_URL };

  interface CoverOptions {
    coverStatus?: number;
    coverType?: string;
    coverBytes?: number;
    telegramStatus?: number;
  }

  /**
   * Routes the image host and the Telegram API on one fetch mock, so the test
   * sees exactly which calls the sender makes and in what order.
   */
  function mockCoverFlow(opts: CoverOptions = {}): ReturnType<typeof vi.fn> {
    const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === COVER_URL) {
        const status = opts.coverStatus ?? 200;
        if (status !== 200) {
          return new Response("nope", { status });
        }
        return new Response(new Uint8Array(opts.coverBytes ?? 1024), {
          status: 200,
          headers: { "Content-Type": opts.coverType ?? "image/jpeg" },
        });
      }

      const status = url.includes("/sendPhoto") ? (opts.telegramStatus ?? 200) : 200;
      return new Response(JSON.stringify({ ok: status === 200, description: "nope" }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      void init;
    });
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  function callUrls(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map((call) => String(call[0]));
  }

  it("downloads the cover and uploads it as multipart", async () => {
    const fetchMock = mockCoverFlow();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    const urls = callUrls(fetchMock);
    expect(urls[0]).toBe(COVER_URL);
    expect(urls[1]).toContain("/sendPhoto");
    expect(urls[1]).not.toContain("?");

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe(CHAT_ID);
    expect(form.get("caption")).toBe(formatMessage(WITH_IMAGE));
    expect(form.get("parse_mode")).toBe("HTML");
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });

  it("passes the URL to Telegram nowhere: the host blocks its fetchers", async () => {
    const fetchMock = mockCoverFlow();

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    // The cover URL must never appear inside a Telegram request.
    const telegramCalls = callUrls(fetchMock).filter((u) => u.includes("api.telegram.org"));
    expect(telegramCalls.some((u) => u.includes(encodeURIComponent(COVER_URL)))).toBe(false);
  });

  it("uses sendMessage when the release has no cover", async () => {
    const fetchMock = mockCoverFlow();

    await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep: async () => {} });

    expect(callUrls(fetchMock)).toHaveLength(1);
    expect(callUrls(fetchMock)[0]).toContain("/sendMessage");
  });

  it("falls back to text when the cover cannot be downloaded", async () => {
    const fetchMock = mockCoverFlow({ coverStatus: 404 });

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    const urls = callUrls(fetchMock);
    expect(urls[0]).toBe(COVER_URL);
    expect(urls[1]).toContain("/sendMessage");
  });

  it("falls back to text when the cover is not an image", async () => {
    const fetchMock = mockCoverFlow({ coverType: "text/html" });

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    expect(callUrls(fetchMock)[1]).toContain("/sendMessage");
  });

  it("falls back to text when the cover exceeds the size cap", async () => {
    const fetchMock = mockCoverFlow({ coverBytes: MAX_COVER_BYTES + 1 });

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    expect(callUrls(fetchMock)[1]).toContain("/sendMessage");
  });

  it("falls back to text when Telegram rejects the upload", async () => {
    const fetchMock = mockCoverFlow({ telegramStatus: 400 });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    const urls = callUrls(fetchMock);
    expect(urls[1]).toContain("/sendPhoto");
    expect(urls[2]).toContain("/sendMessage");
  });

  it("still delivers when the cover host hangs", async () => {
    const impl = vi.fn(async (input: string | URL) => {
      if (String(input) === COVER_URL) {
        throw new Error("connection reset");
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", impl);

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, { sleep: async () => {} });

    expect(String(impl.mock.calls[1]?.[0])).toContain("/sendMessage");
  });
});
