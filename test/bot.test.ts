import { afterEach, describe, expect, it, vi } from "vitest";
import type { Release } from "../src/feed";
import { formatResults, handleUpdate, parseCommand } from "../src/bot";
import { buildSearchUrl, normalizeQuery } from "../src/search";
import { TELEGRAM_API_BASE } from "../src/telegram";

const CONFIG = { TELEGRAM_BOT_TOKEN: "123:token", TELEGRAM_CHAT_ID: "42,43" };

const RESULT: Release = {
  id: "g1",
  title: "Call of Duty: Modern Warfare 4 – v13 <Campaign>",
  link: "https://fitgirl-repacks.site/call-of-duty-modern-warfare-4/",
  publishedAt: "Tue, 17 Nov 2026 19:30:56 +0000",
  categories: ["Lossless Repack"],
};

function updateFrom(chatId: number, text: string, type = "private") {
  return { message: { text, chat: { id: chatId, type } } };
}

function mockSend() {
  const fetchMock = vi.fn(async (_url: string | URL) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const sent = () =>
    fetchMock.mock.calls.map((c) => {
      const u = new URL(String(c[0]));
      return { chat: u.searchParams.get("chat_id"), text: u.searchParams.get("text") ?? "", url: u };
    });
  return { fetchMock, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseCommand", () => {
  it("splits a command and its arguments", () => {
    expect(parseCommand("/buscar call of duty")).toEqual({ command: "buscar", args: "call of duty" });
    expect(parseCommand("/Buscar@my_bot  halo ")).toEqual({ command: "buscar", args: "halo" });
    expect(parseCommand("/start")).toEqual({ command: "start", args: "" });
  });

  it("treats plain text as arguments with no command", () => {
    expect(parseCommand("  modern warfare 4 ")).toEqual({ command: "", args: "modern warfare 4" });
  });
});

describe("search helpers", () => {
  it("builds the RSS search URL with the query encoded", () => {
    const url = new URL(buildSearchUrl("call of duty & more"));
    expect(url.searchParams.get("s")).toBe("call of duty & more");
    expect(url.searchParams.get("feed")).toBe("rss2");
  });

  it("collapses whitespace and caps the length", () => {
    expect(normalizeQuery("  a   b \n c ")).toBe("a b c");
    expect(normalizeQuery("x".repeat(500))).toHaveLength(100);
  });
});

describe("formatResults", () => {
  it("lists linked, HTML-escaped results", () => {
    const text = formatResults("cod <4>", [RESULT]);
    expect(text).toContain("cod &lt;4&gt;");
    expect(text).toContain(`<a href="${RESULT.link}">Call of Duty: Modern Warfare 4 – v13 &lt;Campaign&gt;</a>`);
  });

  it("says so when nothing matches", () => {
    expect(formatResults("zzz", [])).toContain("No encontré nada");
  });
});

describe("handleUpdate", () => {
  it("answers /start with the chat id, even to a stranger", async () => {
    const { sent } = mockSend();
    await handleUpdate(updateFrom(999, "/start"), CONFIG);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.chat).toBe("999");
    expect(sent()[0]?.text).toContain("<code>999</code>");
    expect(sent()[0]?.text).toContain("administra");
  });

  it("searches for an authorized chat and replies with the links", async () => {
    const { sent } = mockSend();
    const search = vi.fn(async () => [RESULT]);

    await handleUpdate(updateFrom(42, "/buscar call of duty modern warfare 4"), CONFIG, {}, search);

    expect(search).toHaveBeenCalledWith("call of duty modern warfare 4");
    expect(sent()[0]?.chat).toBe("42");
    expect(sent()[0]?.text).toContain(RESULT.link);
    expect(sent()[0]?.url.searchParams.get("disable_web_page_preview")).toBe("true");
  });

  it("searches on plain text too", async () => {
    mockSend();
    const search = vi.fn(async () => []);
    await handleUpdate(updateFrom(43, "halo infinite"), CONFIG, {}, search);
    expect(search).toHaveBeenCalledWith("halo infinite");
  });

  it("refuses to search for a chat that is not on the list", async () => {
    const { sent } = mockSend();
    const search = vi.fn(async () => [RESULT]);

    await handleUpdate(updateFrom(999, "call of duty"), CONFIG, {}, search);

    expect(search).not.toHaveBeenCalled();
    expect(sent()[0]?.text).toContain("No tienes acceso");
  });

  it("shows help for an empty search and for unknown commands", async () => {
    const { sent } = mockSend();
    const search = vi.fn(async () => [RESULT]);
    await handleUpdate(updateFrom(42, "/buscar"), CONFIG, {}, search);
    await handleUpdate(updateFrom(42, "/borrar todo"), CONFIG, {}, search);
    expect(search).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(2);
  });

  it("tells the user when the site cannot be reached", async () => {
    const { sent } = mockSend();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handleUpdate(updateFrom(42, "doom"), CONFIG, {}, async () => {
      throw new Error("feed down");
    });
    expect(sent()[0]?.text).toContain("No pude consultar");
  });

  it("ignores groups, non-text updates and a missing token", async () => {
    const { fetchMock } = mockSend();
    await handleUpdate(updateFrom(42, "doom", "group"), CONFIG);
    await handleUpdate({ message: { chat: { id: 42, type: "private" } } }, CONFIG);
    await handleUpdate({}, CONFIG);
    await handleUpdate(updateFrom(42, "doom"), { ...CONFIG, TELEGRAM_BOT_TOKEN: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the reply itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));
    await expect(handleUpdate(updateFrom(42, "/start"), CONFIG)).resolves.toBeUndefined();
  });

  it("only talks to the Telegram API", async () => {
    const { sent } = mockSend();
    await handleUpdate(updateFrom(42, "/start"), CONFIG);
    expect(sent()[0]?.url.origin).toBe(TELEGRAM_API_BASE);
  });
});
