import { describe, expect, it } from "vitest";
import type { Release } from "../src/feed";
import {
  DEFAULT_SEEN_TTL_DAYS,
  filterUnseen,
  hasBeenSeen,
  markSeen,
  ttlSecondsFromDays,
} from "../src/store";
import { MemoryKV } from "./kv";

function release(id: string): Release {
  return {
    id,
    title: `Game ${id}`,
    link: `https://fitgirl-repacks.site/${id}/`,
    publishedAt: "Mon, 01 Sep 2025 08:30:00 +0000",
  };
}

describe("filterUnseen", () => {
  it("returns every release when KV is empty", async () => {
    const kv = new MemoryKV();
    const releases = [release("a"), release("b")];

    await expect(filterUnseen(releases, kv)).resolves.toEqual(releases);
  });

  it("drops releases already stored in KV", async () => {
    const kv = new MemoryKV();
    kv.seed("a");

    const unseen = await filterUnseen([release("a"), release("b")], kv);

    expect(unseen.map((r) => r.id)).toEqual(["b"]);
  });

  it("deduplicates repeated ids inside one feed payload", async () => {
    const kv = new MemoryKV();

    const unseen = await filterUnseen([release("a"), release("a")], kv);

    expect(unseen).toHaveLength(1);
    expect(kv.getCalls).toBe(1);
  });

  it("propagates KV read failures instead of treating them as unseen", async () => {
    const kv = new MemoryKV();
    kv.failNextGet = new Error("kv unavailable");

    await expect(filterUnseen([release("a")], kv)).rejects.toThrow("kv unavailable");
  });
});

describe("markSeen", () => {
  it("stores the release id so it never passes the filter again", async () => {
    const kv = new MemoryKV();
    const releases = [release("a")];

    expect(await filterUnseen(releases, kv)).toHaveLength(1);
    await markSeen("a", kv, DEFAULT_SEEN_TTL_DAYS);
    expect(await filterUnseen(releases, kv)).toEqual([]);
    expect(await hasBeenSeen("a", kv)).toBe(true);
  });

  it("applies the configured TTL in seconds", async () => {
    const kv = new MemoryKV();

    await markSeen("a", kv, 30);

    expect(kv.entries.get("a")?.expirationTtl).toBe(30 * 86_400);
  });

  it("leaves the release unmarked when the KV write fails", async () => {
    const kv = new MemoryKV();
    kv.failNextPut = new Error("network error");

    await expect(markSeen("a", kv, 30)).rejects.toThrow("network error");

    expect(kv.entries.has("a")).toBe(false);
    expect(await filterUnseen([release("a")], kv)).toHaveLength(1);
  });
});

describe("ttlSecondsFromDays", () => {
  it("converts days to seconds", () => {
    expect(ttlSecondsFromDays(30)).toBe(2_592_000);
  });

  it("clamps invalid or too-small TTLs to the KV minimum", () => {
    expect(ttlSecondsFromDays(0)).toBe(60);
    expect(ttlSecondsFromDays(Number.NaN)).toBe(60);
    expect(ttlSecondsFromDays(-5)).toBe(60);
  });
});
