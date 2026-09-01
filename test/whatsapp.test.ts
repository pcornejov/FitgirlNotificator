import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../src/feed";
import {
  CALLMEBOT_ENDPOINT,
  WhatsAppError,
  buildRequestUrl,
  formatMessage,
  sendWhatsAppNotification,
} from "../src/whatsapp";

const PHONE = "+10000000000";
const API_KEY = "test-api-key";

const RELEASE: Release = {
  id: "https://fitgirl-repacks.site/?p=48211",
  title: "Cyber Drift 2 & The Lost City",
  link: "https://fitgirl-repacks.site/cyber-drift-2/",
  publishedAt: "Mon, 01 Sep 2025 08:30:00 +0000",
};

/** Queues one Response (or thrown error) per attempt. */
function mockFetchSequence(
  responses: Array<{ status: number } | Error>,
): ReturnType<typeof vi.fn> {
  let call = 0;
  const impl = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof Error) {
      throw next;
    }
    return new Response("Message queued", { status: next.status });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("formatMessage", () => {
  it("includes the title and the direct link", () => {
    expect(formatMessage(RELEASE)).toBe(
      "🎮 *Nuevo Release en FitGirl*\n\nCyber Drift 2 & The Lost City\n\n🔗 https://fitgirl-repacks.site/cyber-drift-2/",
    );
  });
});

describe("buildRequestUrl", () => {
  it("URL-encodes phone, text and apikey", () => {
    const url = new URL(buildRequestUrl(PHONE, API_KEY, formatMessage(RELEASE)));

    expect(`${url.origin}${url.pathname}`).toBe(CALLMEBOT_ENDPOINT);
    expect(url.searchParams.get("phone")).toBe(PHONE);
    expect(url.searchParams.get("apikey")).toBe(API_KEY);
    expect(url.searchParams.get("text")).toBe(formatMessage(RELEASE));
    // Raw query must be escaped: no literal spaces, newlines, '&' or '+'.
    expect(url.search).not.toMatch(/[\s\n]/);
    expect(url.search.split("&")).toHaveLength(3);
  });
});

describe("sendWhatsAppNotification", () => {
  it("performs a single GET request on success", async () => {
    const fetchMock = mockFetchSequence([{ status: 200 }]);

    await sendWhatsAppNotification(PHONE, API_KEY, RELEASE, { sleep: async () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url.startsWith(`${CALLMEBOT_ENDPOINT}?`)).toBe(true);
    expect(url).toContain(`apikey=${API_KEY}`);
    expect(url).toContain(encodeURIComponent(RELEASE.link));
  });

  it("retries once with backoff on a 500 and succeeds", async () => {
    const fetchMock = mockFetchSequence([{ status: 500 }, { status: 200 }]);
    const sleep = vi.fn(async () => {});

    await sendWhatsAppNotification(PHONE, API_KEY, RELEASE, {
      sleep,
      retryDelayMs: 2000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("throws after the retry when the API keeps failing with 5xx", async () => {
    const fetchMock = mockFetchSequence([{ status: 500 }, { status: 503 }]);

    const error = await sendWhatsAppNotification(PHONE, API_KEY, RELEASE, {
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(WhatsAppError);
    expect((error as WhatsAppError).status).toBe(503);
    expect((error as WhatsAppError).attempts).toBe(2);
  });

  it("does NOT retry on a 400", async () => {
    const fetchMock = mockFetchSequence([{ status: 400 }, { status: 200 }]);
    const sleep = vi.fn(async () => {});

    const error = await sendWhatsAppNotification(PHONE, API_KEY, RELEASE, { sleep }).catch(
      (e: unknown) => e,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(WhatsAppError);
    expect((error as WhatsAppError).status).toBe(400);
  });

  it("does NOT retry on a 403 (bad api key)", async () => {
    const fetchMock = mockFetchSequence([{ status: 403 }]);

    await expect(
      sendWhatsAppNotification(PHONE, API_KEY, RELEASE, { sleep: async () => {} }),
    ).rejects.toBeInstanceOf(WhatsAppError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a network error / timeout", async () => {
    const fetchMock = mockFetchSequence([new Error("The operation was aborted"), { status: 200 }]);
    const sleep = vi.fn(async () => {});

    await sendWhatsAppNotification(PHONE, API_KEY, RELEASE, { sleep });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("fails fast when credentials are missing", async () => {
    const fetchMock = mockFetchSequence([{ status: 200 }]);

    await expect(
      sendWhatsAppNotification("", API_KEY, RELEASE),
    ).rejects.toBeInstanceOf(WhatsAppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
