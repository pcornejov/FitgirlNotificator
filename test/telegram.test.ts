import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../src/feed";
import { NotificationError } from "../src/notify";
import {
  IMAGE_PROXY_BASE,
  TELEGRAM_API_BASE,
  buildPhotoRequestUrl,
  buildRequestUrl,
  escapeHtml,
  proxiedCoverUrl,
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

describe("proxiedCoverUrl", () => {
  it("routes the cover through the image proxy", () => {
    expect(proxiedCoverUrl("https://i7.imageban.ru/out/2026/09/06/abc.jpg")).toBe(
      `${IMAGE_PROXY_BASE}/i7.imageban.ru/out/2026/09/06/abc.jpg?ssl=1`,
    );
  });

  it("asks the proxy for TLS only when the origin is https", () => {
    expect(proxiedCoverUrl("http://img.example/a.jpg")).toBe(
      `${IMAGE_PROXY_BASE}/img.example/a.jpg`,
    );
  });

  it("preserves an existing query string", () => {
    const proxied = proxiedCoverUrl("https://img.example/a.jpg?w=1&h=2");
    const params = new URL(proxied).searchParams;
    expect(params.get("w")).toBe("1");
    expect(params.get("h")).toBe("2");
    expect(params.get("ssl")).toBe("1");
  });
});

describe("cover images", () => {
  const COVER_URL = "https://i2.imageban.ru/out/2026/09/06/cover.jpg";
  const WITH_IMAGE: Release = { ...RELEASE, imageUrl: COVER_URL };

  function mockTelegram(photoStatus = 200): ReturnType<typeof vi.fn> {
    const impl = vi.fn(async (input: string | URL) => {
      const ok = !String(input).includes("/sendPhoto") || photoStatus === 200;
      return new Response(JSON.stringify({ ok, description: "nope" }), {
        status: String(input).includes("/sendPhoto") ? photoStatus : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  it("hands Telegram the proxied URL and downloads nothing itself", async () => {
    const fetchMock = mockTelegram();

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, {
      sleep: async () => {},
    });

    // Exactly one request, to Telegram: the image host is never contacted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin).toBe(TELEGRAM_API_BASE);
    expect(url.pathname).toContain("/sendPhoto");
    expect(url.searchParams.get("photo")).toBe(proxiedCoverUrl(COVER_URL));
    expect(url.searchParams.get("caption")).toBe(formatMessage(WITH_IMAGE));
  });

  it("never sends the original host URL, which Telegram cannot fetch", async () => {
    const fetchMock = mockTelegram();

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, {
      sleep: async () => {},
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(
      encodeURIComponent(COVER_URL),
    );
  });

  it("uses sendMessage when the release has no cover", async () => {
    const fetchMock = mockTelegram();

    await sendTelegramNotification(TOKEN, CHAT_ID, RELEASE, false, { sleep: async () => {} });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendMessage");
  });

  it("falls back to text when Telegram rejects the photo", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mockTelegram(400);

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, false, {
      sleep: async () => {},
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendPhoto");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/sendMessage");
  });

  it("carries the update heading into the caption", async () => {
    const fetchMock = mockTelegram();

    await sendTelegramNotification(TOKEN, CHAT_ID, WITH_IMAGE, true, { sleep: async () => {} });

    const caption = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("caption");
    expect(caption).toContain("actualizado");
  });
});

describe("buildPhotoRequestUrl", () => {
  it("encodes the photo URL and the caption", () => {
    const url = new URL(
      buildPhotoRequestUrl(TOKEN, CHAT_ID, "https://i0.wp.com/a/b.jpg?ssl=1", "hola & adiós"),
    );
    expect(url.searchParams.get("photo")).toBe("https://i0.wp.com/a/b.jpg?ssl=1");
    expect(url.searchParams.get("caption")).toBe("hola & adiós");
    expect(url.searchParams.get("parse_mode")).toBe("HTML");
  });
});
