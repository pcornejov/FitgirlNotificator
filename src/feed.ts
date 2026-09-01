/**
 * Minimal, dependency-free RSS reader for the official FitGirl Repacks feed
 * (a standard WordPress RSS 2.0 document).
 */

export interface Release {
  /** Stable unique id for the release: the <guid>, falling back to <link>. */
  id: string;
  title: string;
  link: string;
  /** Raw <pubDate> value as published by the feed (RFC 822). */
  publishedAt: string;
  /** Cover image from the post body, when the item embeds one. */
  imageUrl?: string;
}

/** Browser-like UA: the site sits behind a WAF that rejects generic bot agents. */
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const DEFAULT_FEED_URL = "https://fitgirl-repacks.site/feed/";

/** Raised when the feed cannot be downloaded or is not parseable. */
export class FeedError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FeedError";
    this.status = status;
  }
}

const ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

/** Ordered by preference: the full post body first, the summary as fallback. */
const CONTENT_BLOCK_RES = [
  /<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i,
  /<description\b[^>]*>([\s\S]*?)<\/description>/i,
];

const IMG_SRC_RE = /<img[^>]+\bsrc=["']([^"']+)["']/i;

/**
 * Blocks that legitimately embed markup (and therefore may contain tags whose
 * names collide with the ones we extract) are dropped before field extraction.
 */
const RICH_TEXT_BLOCKS_RE =
  /<(description|content:encoded|excerpt:encoded|media:[a-z]+)\b[^>]*>[\s\S]*?<\/\1>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** Unwraps `<![CDATA[ ... ]]>` wrappers, keeping the inner text. */
function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Decodes the HTML entities WordPress commonly emits inside titles. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded === undefined ? match : decoded;
    });
}

function cleanText(value: string): string {
  return decodeEntities(stripCdata(value)).replace(/\s+/g, " ").trim();
}

/** Reads the first occurrence of `<tag>` inside a single `<item>` block. */
function readTag(itemXml: string, tag: string): string {
  const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = matcher.exec(itemXml);
  return match?.[1] === undefined ? "" : cleanText(match[1]);
}

/**
 * First image embedded in the post body, which on FitGirl is the cover art.
 *
 * Sending it explicitly beats relying on the messaging app's link preview,
 * which renders inconsistently depending on what it manages to scrape.
 */
function readCoverImage(itemXml: string): string | undefined {
  for (const blockRe of CONTENT_BLOCK_RES) {
    const content = blockRe.exec(itemXml)?.[1];
    if (content === undefined) {
      continue;
    }

    const src = IMG_SRC_RE.exec(stripCdata(content))?.[1];
    if (src === undefined) {
      continue;
    }

    const url = decodeEntities(src).trim();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
  }

  return undefined;
}

/** Parses an RSS document into releases, skipping entries without a usable id. */
export function parseFeed(xml: string): Release[] {
  const releases: Release[] = [];

  ITEM_RE.lastIndex = 0;
  let itemMatch: RegExpExecArray | null = ITEM_RE.exec(xml);
  while (itemMatch !== null) {
    const rawItemXml = itemMatch[1] ?? "";
    // Fields are read from the item with its rich-text blocks removed, so
    // markup embedded in the post body cannot be mistaken for a field.
    const itemXml = rawItemXml.replace(RICH_TEXT_BLOCKS_RE, "");
    const title = readTag(itemXml, "title");
    const link = readTag(itemXml, "link");
    const guid = readTag(itemXml, "guid");
    const publishedAt = readTag(itemXml, "pubDate");

    const id = guid !== "" ? guid : link;
    if (id !== "" && title !== "") {
      const release: Release = { id, title, link, publishedAt };
      const imageUrl = readCoverImage(rawItemXml);
      if (imageUrl !== undefined) {
        release.imageUrl = imageUrl;
      }
      releases.push(release);
    }

    itemMatch = ITEM_RE.exec(xml);
  }

  return releases;
}

/**
 * Downloads and parses the FitGirl RSS feed.
 *
 * @throws {FeedError} on network failure or a non-2xx response (403 from the
 * WAF, 5xx from the origin). The caller is expected to abort the run so no
 * state is mutated.
 */
export async function fetchLatestReleases(
  feedUrl: string = DEFAULT_FEED_URL,
  userAgent: string = DEFAULT_USER_AGENT,
): Promise<Release[]> {
  let response: Response;
  try {
    response = await fetch(feedUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (cause) {
    throw new FeedError(
      `Network error while fetching the feed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!response.ok) {
    throw new FeedError(
      `Feed request failed with HTTP ${response.status}`,
      response.status,
    );
  }

  const xml = await response.text();
  if (xml.trim() === "") {
    throw new FeedError("Feed response body was empty");
  }

  return parseFeed(xml);
}
