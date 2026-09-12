import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/feed";
import {
  MAX_LISTED,
  formatUpcomingMessage,
  isUpcomingPost,
  newEntries,
  parseUpcoming,
  parseUpcomingTitles,
} from "../src/upcoming";
import { FITGIRL_FEED_XML } from "./fixtures";

describe("parseUpcoming", () => {
  it("reads every arrow-prefixed entry, in listing order", () => {
    const body = `<div>
      <span style="color: #339966;">⇢ Anime Shop Simulator</span><br />
      <span style="color: #339966;">⇢ Dig For Riches</span><br />
    </div>`;

    expect(parseUpcoming(body)).toEqual(["Anime Shop Simulator", "Dig For Riches"]);
  });

  it("decodes entities and collapses whitespace in titles", () => {
    const body = `<span>⇢ Dante&#8217;s   Bloodline</span>`;
    expect(parseUpcoming(body)).toEqual(["Dante’s Bloodline"]);
  });

  it("ignores spans without the arrow marker", () => {
    const body = `<span>Repack Size: 12 GB</span><span>⇢ Real Game</span>`;
    expect(parseUpcoming(body)).toEqual(["Real Game"]);
  });

  it("collapses a title listed twice", () => {
    const body = `<span>⇢ Same Game</span><span>⇢ Same Game</span>`;
    expect(parseUpcoming(body)).toEqual(["Same Game"]);
  });

  it("returns nothing for a body with no list", () => {
    expect(parseUpcoming("<p>nothing here</p>")).toEqual([]);
  });
});

describe("parseUpcomingTitles", () => {
  it("finds the list inside the feed document", () => {
    expect(parseUpcomingTitles(FITGIRL_FEED_XML)).toEqual([
      "Tiny Bakery",
      "Sunken Engine",
      "Dante’s Bloodline",
      "Cyber Drift 2",
    ]);
  });

  it("returns nothing when the feed carries no such post", () => {
    const xml = `<rss><channel><item>
      <title>Some Game</title><guid>https://fitgirl-repacks.site/?p=1</guid>
    </item></channel></rss>`;
    expect(parseUpcomingTitles(xml)).toEqual([]);
  });
});

describe("isUpcomingPost", () => {
  const releases = parseFeed(FITGIRL_FEED_XML);

  it("recognises the post by title, whatever follows it", () => {
    const post = releases.find((r) => r.title.startsWith("Upcoming"));
    expect(post).toBeDefined();
    expect(isUpcomingPost(post as (typeof releases)[number])).toBe(true);
  });

  it("does not mistake a repack for it", () => {
    const game = releases.find((r) => r.title.startsWith("Cyber Drift"));
    expect(isUpcomingPost(game as (typeof releases)[number])).toBe(false);
  });
});

describe("newEntries", () => {
  it("reports only what was not listed before, in listing order", () => {
    expect(newEntries(["c", "a", "b"], ["a"])).toEqual(["c", "b"]);
  });

  it("reports nothing when the list is unchanged", () => {
    expect(newEntries(["a", "b"], ["b", "a"])).toEqual([]);
  });

  it("reports nothing when the list only shrank", () => {
    expect(newEntries(["a"], ["a", "b"])).toEqual([]);
  });
});
describe("formatUpcomingMessage", () => {
  const ALL = ["A", "B", "C"];

  it("leads with the additions, then lists everything still coming", () => {
    expect(formatUpcomingMessage(["C"], ALL)).toBe(
      "🔜 Nuevo en próximos repacks\n\n🆕 C\n\n📋 Todos los próximos (3)\n• A\n• B\n• C",
    );
  });

  it("uses the plural heading and marks every addition", () => {
    const message = formatUpcomingMessage(["B", "C"], ALL);
    expect(message).toContain("🔜 Nuevos en próximos repacks");
    expect(message).toContain("🆕 B");
    expect(message).toContain("🆕 C");
  });

  it("counts the whole list, not just the additions", () => {
    expect(formatUpcomingMessage(["C"], ALL)).toContain("Todos los próximos (3)");
  });

  it("applies the channel's own escaping and emphasis", () => {
    const message = formatUpcomingMessage(
      ["A & B"],
      ["A & B"],
      (v) => v.replace(/&/g, "&amp;"),
      (v) => `<b>${v}</b>`,
    );
    expect(message).toContain("<b>🔜 Nuevo en próximos repacks</b>");
    expect(message).toContain("🆕 A &amp; B");
    expect(message).toContain("• A &amp; B");
  });

  it("truncates an unexpectedly long list rather than overflowing the message", () => {
    const many = Array.from({ length: MAX_LISTED + 5 }, (_, i) => `Game ${i}`);

    const message = formatUpcomingMessage(["Game 0"], many);

    expect(message).toContain(`Todos los próximos (${many.length})`);
    expect(message).toContain("… y 5 más");
    expect(message).not.toContain(`• Game ${MAX_LISTED}`);
  });
});
