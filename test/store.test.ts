import { describe, expect, it } from "vitest";
import type { Release } from "../src/feed";
import {
  DEFAULT_SEEN_TTL_DAYS,
  filterUnseen,
  hasBeenSeen,
  markSeen,
  postKey,
  ttlSecondsFromDays,
  versionKey,
} from "../src/store";
import { MemoryKV } from "./kv";

function release(id: string, publishedAt = "Mon, 01 Sep 2025 08:30:00 +0000"): Release {
  return {
    id,
    title: `Game ${id}`,
    link: `https://fitgirl-repacks.site/${id}/`,
    publishedAt,
    categories: ["Lossless Repack"],
  };
}

/** Same post, republished later: what an updated repack looks like. */
function republished(id: string): Release {
  return release(id, "Tue, 09 Sep 2025 20:00:00 +0000");
}

describe("keys", () => {
  it("keys a version by guid and publish timestamp", () => {
    expect(versionKey(release("a"))).toBe("a@1756715400");
    expect(postKey(release("a"))).toBe("a");
  });

  it("gives a republished post a different version key", () => {
    expect(versionKey(republished("a"))).not.toBe(versionKey(release("a")));
    expect(postKey(republished("a"))).toBe(postKey(release("a")));
  });

  it("falls back to the raw date when it cannot be parsed", () => {
    expect(versionKey(release("a", "not a date"))).toBe("a@not_a_date");
  });
});

describe("filterUnseen", () => {
  it("returns every release when KV is empty", async () => {
    const kv = new MemoryKV();

    const unseen = await filterUnseen([release("a"), release("b")], kv);

    expect(unseen.map((p) => p.release.id)).toEqual(["a", "b"]);
    expect(unseen.every((p) => !p.isUpdate)).toBe(true);
  });

  it("drops releases already notified in this exact version", async () => {
    const kv = new MemoryKV();
    kv.seed(versionKey(release("a")));

    const unseen = await filterUnseen([release("a"), release("b")], kv);

    expect(unseen.map((p) => p.release.id)).toEqual(["b"]);
  });

  it("lets a republished repack through, flagged as an update", async () => {
    const kv = new MemoryKV();
    await markSeen(release("a"), kv);

    const unseen = await filterUnseen([republished("a")], kv);

    expect(unseen).toHaveLength(1);
    expect(unseen[0]?.isUpdate).toBe(true);
  });

  it("does not flag a first-time release as an update", async () => {
    const kv = new MemoryKV();

    const unseen = await filterUnseen([release("new")], kv);

    expect(unseen[0]?.isUpdate).toBe(false);
  });

  it("deduplicates the same version repeated inside one payload", async () => {
    const kv = new MemoryKV();

    const unseen = await filterUnseen([release("a"), release("a")], kv);

    expect(unseen).toHaveLength(1);
  });

  it("propagates KV read failures instead of treating them as unseen", async () => {
    const kv = new MemoryKV();
    kv.failNextGet = new Error("kv unavailable");

    await expect(filterUnseen([release("a")], kv)).rejects.toThrow("kv unavailable");
  });
});

describe("markSeen", () => {
  it("stores the release so it never passes the filter again", async () => {
    const kv = new MemoryKV();
    const releases = [release("a")];

    expect(await filterUnseen(releases, kv)).toHaveLength(1);
    await markSeen(release("a"), kv, DEFAULT_SEEN_TTL_DAYS);
    expect(await filterUnseen(releases, kv)).toEqual([]);
    expect(await hasBeenSeen(release("a"), kv)).toBe(true);
  });

  it("writes both the version key and the post key", async () => {
    const kv = new MemoryKV();

    await markSeen(release("a"), kv, 30);

    expect(kv.entries.has(versionKey(release("a")))).toBe(true);
    expect(kv.entries.has(postKey(release("a")))).toBe(true);
  });

  it("applies the configured TTL in seconds", async () => {
    const kv = new MemoryKV();

    await markSeen(release("a"), kv, 30);

    expect(kv.entries.get(versionKey(release("a")))?.expirationTtl).toBe(30 * 86_400);
  });

  it("leaves the release unmarked when the KV write fails", async () => {
    const kv = new MemoryKV();
    kv.failNextPut = new Error("network error");

    await expect(markSeen(release("a"), kv, 30)).rejects.toThrow("network error");

    expect(kv.entries.has(versionKey(release("a")))).toBe(false);
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
