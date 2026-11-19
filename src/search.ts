/**
 * Search over the FitGirl site, through WordPress' own search feed.
 *
 * `?s=<terms>&feed=rss2` returns the matching posts in the same RSS format as
 * the main feed, so the existing parser is reused as is.
 */

import { fetchFeed, isGameRelease, parseFeed, type Release } from "./feed";

export const SEARCH_BASE_URL = "https://fitgirl-repacks.site/";
export const MAX_QUERY_LENGTH = 100;
export const MAX_RESULTS = 5;

export function buildSearchUrl(query: string): string {
  const params = new URLSearchParams({ s: query, feed: "rss2" });
  return `${SEARCH_BASE_URL}?${params.toString()}`;
}

/** Trims, collapses whitespace and caps the length of a user supplied query. */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Looks a title up on the site and returns up to `limit` game releases, best
 * match first (the order WordPress returns).
 */
export async function searchReleases(
  query: string,
  userAgent?: string,
  requiredCategory?: string,
  limit: number = MAX_RESULTS,
): Promise<Release[]> {
  const normalized = normalizeQuery(query);
  if (normalized === "") {
    return [];
  }
  const xml = await fetchFeed(buildSearchUrl(normalized), userAgent);
  return parseFeed(xml)
    .filter((release) => isGameRelease(release, requiredCategory))
    .slice(0, limit);
}
