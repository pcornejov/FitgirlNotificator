/**
 * The site publishes a single, continuously edited post listing the repacks
 * being worked on. It is not a release, so it never goes out as one — what is
 * worth knowing is when a game *joins* that list.
 */

import { type Release, decodeEntities, splitItems } from "./feed";

/** Title of the post holding the list, matched case-insensitively by prefix. */
export const UPCOMING_TITLE_PREFIX = "upcoming repacks";

/** Every listed game is a span whose text starts with this arrow. */
const ENTRY_RE = /<span[^>]*>\s*⇢\s*([^<]+)<\/span>/g;

/** True when this feed entry is the upcoming-repacks post. */
export function isUpcomingPost(release: Release): boolean {
  return release.title.trim().toLowerCase().startsWith(UPCOMING_TITLE_PREFIX);
}

/**
 * Extracts the listed game titles, in the order the post lists them.
 *
 * Duplicates collapse so a title repeated in the post cannot be reported as an
 * addition twice.
 */
export function parseUpcoming(body: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  ENTRY_RE.lastIndex = 0;
  let match: RegExpExecArray | null = ENTRY_RE.exec(body);
  while (match !== null) {
    const title = decodeEntities(match[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (title !== "" && !seen.has(title)) {
      seen.add(title);
      titles.push(title);
    }
    match = ENTRY_RE.exec(body);
  }

  return titles;
}

/**
 * Pulls the listed titles straight out of the feed document.
 *
 * The post body runs to tens of kilobytes of markup, so it is read here rather
 * than carried on every parsed release.
 */
export function parseUpcomingTitles(xml: string): string[] {
  for (const item of splitItems(xml)) {
    const title = /<title>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? "";
    const clean = title.replace(/<!\[CDATA\[|\]\]>/g, "").trim().toLowerCase();
    if (!clean.startsWith(UPCOMING_TITLE_PREFIX)) {
      continue;
    }

    const body = /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i.exec(item)?.[1];
    return body === undefined ? [] : parseUpcoming(body);
  }

  return [];
}

/**
 * Reduces a title to the part that identifies the game.
 *
 * The two sides never match literally: the upcoming list says
 * "Moonlight Peaks, v1.2.7" while the release is published as
 * "Moonlight Peaks – v1.2.7 + 2 DLCs". Everything from the first version or
 * bundle marker onwards is dropped, and the rest is reduced to bare words.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    // Version, build and bundle markers, whichever comes first.
    .split(/,?\s*[-–]\s*v\d|,\s*v\d|\sv\d+\.|\sbuild\s|\s\+\s|\s\(/)[0]!
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when a listed title refers to the same game as a published release.
 *
 * One side is allowed to be a prefix of the other, since a release often adds
 * an edition the list omits. A length floor keeps a short name from matching
 * an unrelated longer one.
 */
export function isSameGame(listedTitle: string, releaseTitle: string): boolean {
  const listed = titleKey(listedTitle);
  const released = titleKey(releaseTitle);
  if (listed === "" || released === "") {
    return false;
  }
  if (listed === released) {
    return true;
  }

  const [shorter, longer] = listed.length <= released.length ? [listed, released] : [released, listed];
  return shorter.length >= 8 && longer.startsWith(`${shorter} `);
}

/** Drops the listed games that these releases have just published. */
export function excludeReleased(listed: string[], releaseTitles: string[]): string[] {
  return listed.filter(
    (title) => !releaseTitles.some((released) => isSameGame(title, released)),
  );
}

/** Titles present now that were not present before, in listing order. */
export function newEntries(current: string[], previous: string[]): string[] {
  const before = new Set(previous);
  return current.filter((title) => !before.has(title));
}

/**
 * Upper bound on the reminder list, so an unexpectedly long post cannot push
 * the message past what the channels accept.
 */
export const MAX_LISTED = 40;

/**
 * The announcement: what was just added, then the full list as a reminder of
 * everything still on the way.
 *
 * The additions appear in both blocks on purpose — the first is the news, the
 * second is the standing list.
 */
export function formatUpcomingMessage(
  added: string[],
  all: string[],
  escape: (value: string) => string = (value) => value,
  bold: (value: string) => string = (value) => value,
): string {
  const shown = all.slice(0, MAX_LISTED);
  const omitted = all.length - shown.length;
  const reminder = [
    bold(`📋 Todos los próximos (${all.length})`),
    ...shown.map((title) => `• ${escape(title)}`),
    ...(omitted > 0 ? [`… y ${omitted} más`] : []),
  ].join("\n");

  // With no additions the message is the standing list on its own, which is
  // what rides along with a release.
  if (added.length === 0) {
    return reminder;
  }

  const heading = bold(
    added.length === 1 ? "🔜 Nuevo en próximos repacks" : "🔜 Nuevos en próximos repacks",
  );
  const news = added.map((title) => `🆕 ${escape(title)}`).join("\n");

  return `${heading}\n\n${news}\n\n${reminder}`;
}
