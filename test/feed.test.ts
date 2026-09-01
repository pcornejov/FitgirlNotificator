import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_AGENT,
  FeedError,
  decodeEntities,
  fetchLatestReleases,
  parseFeed,
} from "../src/feed";
import { EMPTY_FEED_XML, FITGIRL_FEED_XML } from "./fixtures";

const FEED_URL = "https://fitgirl-repacks.site/feed/";

function mockFetch(body: string, init: { status?: number } = {}): ReturnType<typeof vi.fn> {
  const status = init.status ?? 200;
  const impl = vi.fn(async () =>
    new Response(body, { status, headers: { "Content-Type": "application/rss+xml" } }),
  );
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseFeed", () => {
  it("maps every item field of a real WordPress feed", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);

    expect(releases).toHaveLength(3);
    expect(releases[0]).toEqual({
      id: "https://fitgirl-repacks.site/?p=48211",
      title: "Silent Hill’s Echo – Director's Cut",
      link: "https://fitgirl-repacks.site/silent-hills-echo/",
      publishedAt: "Mon, 01 Sep 2025 08:30:00 +0000",
      imageUrl: "https://i2.imageban.ru/out/2026/09/01/cover-one.jpg",
    });
  });

  it("unwraps CDATA and decodes entities in titles", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);
    expect(releases[1]?.title).toBe("Cyber Drift 2 & The Lost City");
  });

  it("ignores markup embedded in description/content:encoded blocks", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);
    // The first item embeds a <link> tag inside content:encoded.
    expect(releases[0]?.link).toBe("https://fitgirl-repacks.site/silent-hills-echo/");
  });

  it("extracts the first embedded image as the cover", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);
    expect(releases[0]?.imageUrl).toBe("https://i2.imageban.ru/out/2026/09/01/cover-one.jpg");
  });

  it("leaves imageUrl undefined when the item embeds no image", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);
    expect(releases[1]?.imageUrl).toBeUndefined();
    expect(releases[2]?.imageUrl).toBeUndefined();
  });

  it("ignores non-http image sources", () => {
    const xml = `<rss><channel><item>
      <title>Data URI Cover</title>
      <guid>https://fitgirl-repacks.site/?p=9</guid>
      <content:encoded><![CDATA[<img src="data:image/gif;base64,R0lGOD" />]]></content:encoded>
    </item></channel></rss>`;
    expect(parseFeed(xml)[0]?.imageUrl).toBeUndefined();
  });

  it("decodes entities inside the image URL", () => {
    const xml = `<rss><channel><item>
      <title>Entity Cover</title>
      <guid>https://fitgirl-repacks.site/?p=10</guid>
      <content:encoded><![CDATA[<img src="https://img.example/a.jpg?w=1&amp;h=2" />]]></content:encoded>
    </item></channel></rss>`;
    expect(parseFeed(xml)[0]?.imageUrl).toBe("https://img.example/a.jpg?w=1&h=2");
  });

  it("still keeps embedded markup out of the extracted fields", () => {
    const releases = parseFeed(FITGIRL_FEED_XML);
    expect(releases[0]?.link).toBe("https://fitgirl-repacks.site/silent-hills-echo/");
  });

  it("falls back to <link> when the item has no <guid>", () => {
    const xml = `<rss><channel><item>
      <title>No Guid Release</title>
      <link>https://fitgirl-repacks.site/no-guid/</link>
      <pubDate>Sat, 30 Aug 2025 10:00:00 +0000</pubDate>
    </item></channel></rss>`;

    expect(parseFeed(xml)[0]).toEqual({
      id: "https://fitgirl-repacks.site/no-guid/",
      title: "No Guid Release",
      link: "https://fitgirl-repacks.site/no-guid/",
      publishedAt: "Sat, 30 Aug 2025 10:00:00 +0000",
    });
  });

  it("skips items without a usable id or title", () => {
    const xml = `<rss><channel>
      <item><title>Orphan</title></item>
      <item><guid>https://fitgirl-repacks.site/?p=1</guid></item>
    </channel></rss>`;
    expect(parseFeed(xml)).toEqual([]);
  });

  it("returns an empty array for a feed with no items", () => {
    expect(parseFeed(EMPTY_FEED_XML)).toEqual([]);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("A &amp; B &#8211; C &#x2019;D&apos;")).toBe("A & B – C ’D'");
  });

  it("leaves unknown entities untouched", () => {
    expect(decodeEntities("&unknownentity; stays")).toBe("&unknownentity; stays");
  });
});

describe("fetchLatestReleases", () => {
  it("requests the feed with a browser User-Agent", async () => {
    const fetchMock = mockFetch(FITGIRL_FEED_XML);

    const releases = await fetchLatestReleases(FEED_URL, DEFAULT_USER_AGENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FEED_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(releases.map((r) => r.title)).toEqual([
      "Silent Hill’s Echo – Director's Cut",
      "Cyber Drift 2 & The Lost City",
      "Upcoming Repacks",
    ]);
  });

  it("returns an empty array when the feed has no entries", async () => {
    mockFetch(EMPTY_FEED_XML);
    await expect(fetchLatestReleases(FEED_URL)).resolves.toEqual([]);
  });

  it("throws FeedError with the status on a 403 (WAF block)", async () => {
    mockFetch("<html>Forbidden</html>", { status: 403 });

    const error = await fetchLatestReleases(FEED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).status).toBe(403);
  });

  it("throws FeedError with the status on a 500", async () => {
    mockFetch("boom", { status: 500 });

    const error = await fetchLatestReleases(FEED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).status).toBe(500);
  });

  it("wraps network failures in a FeedError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection reset");
      }),
    );

    const error = await fetchLatestReleases(FEED_URL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FeedError);
    expect((error as FeedError).status).toBeUndefined();
    expect((error as FeedError).message).toContain("connection reset");
  });

  it("throws when the response body is empty", async () => {
    mockFetch("   ");
    await expect(fetchLatestReleases(FEED_URL)).rejects.toBeInstanceOf(FeedError);
  });
});
