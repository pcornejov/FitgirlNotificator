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
  const heading = bold(
    added.length === 1 ? "🔜 Nuevo en próximos repacks" : "🔜 Nuevos en próximos repacks",
  );
  const news = added.map((title) => `🆕 ${escape(title)}`).join("\n");

  const shown = all.slice(0, MAX_LISTED);
  const omitted = all.length - shown.length;
  const reminder = [
    bold(`📋 Todos los próximos (${all.length})`),
    ...shown.map((title) => `• ${escape(title)}`),
    ...(omitted > 0 ? [`… y ${omitted} más`] : []),
  ].join("\n");

  return `${heading}\n\n${news}\n\n${reminder}`;
}
