/**
 * Conversation with the bot, delivered by Telegram through a webhook.
 *
 * - `/start` answers with the caller's chat id, so a new subscriber can hand it
 *   over without digging through `getUpdates`.
 * - Anything else is a title search, answered only for chats listed in
 *   `TELEGRAM_CHAT_ID`: the bot is public, the search is not.
 */

import { escapeHtml, sendTelegramText } from "./telegram";
import { parseChatIds } from "./notifier";
import type { SendOptions } from "./notify";
import { type Release } from "./feed";
import { normalizeQuery, searchReleases } from "./search";

/** The slice of a Telegram `Update` this bot reads. */
export interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string };
  };
}

export interface BotConfig {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  USER_AGENT?: string;
  REQUIRE_CATEGORY?: string;
}

export type SearchFn = (query: string) => Promise<Release[]>;

/** Strips a leading `/command` (or `/command@botname`) and returns the rest. */
export function parseCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim();
  const match = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (match === null) {
    return { command: "", args: trimmed };
  }
  return { command: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

export function formatResults(query: string, results: Release[]): string {
  if (results.length === 0) {
    return `🔎 No encontré nada para «${escapeHtml(query)}».`;
  }
  const lines = results.map(
    (r, i) => `${i + 1}. <a href="${escapeHtml(r.link)}">${escapeHtml(r.title)}</a>`,
  );
  return `🔎 Resultados para «${escapeHtml(query)}»:\n\n${lines.join("\n")}`;
}

const HELP =
  "Escríbeme el nombre de un juego (o <code>/buscar nombre</code>) y te envío el link de la publicación en FitGirl.";

/**
 * Handles one update. Never throws: a failure is logged and the caller still
 * answers Telegram with 200, otherwise Telegram would redeliver the update.
 */
export async function handleUpdate(
  update: TelegramUpdate,
  config: BotConfig,
  sendOptions: SendOptions = {},
  search?: SearchFn,
): Promise<void> {
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  const token = config.TELEGRAM_BOT_TOKEN ?? "";

  // Only private text messages are answered.
  if (
    token === "" ||
    chatId === undefined ||
    typeof text !== "string" ||
    message?.chat?.type !== "private"
  ) {
    return;
  }

  const chat = String(chatId);
  const reply = (html: string) => sendTelegramText(token, chat, html, sendOptions);

  try {
    const { command, args } = parseCommand(text);

    if (command === "start") {
      await reply(
        `👋 Tu chat id es <code>${escapeHtml(chat)}</code>.\n\n` +
          (parseChatIds(config.TELEGRAM_CHAT_ID).includes(chat)
            ? HELP
            : "Pásaselo a quien administra el bot para recibir los avisos."),
      );
      return;
    }

    if (!parseChatIds(config.TELEGRAM_CHAT_ID).includes(chat)) {
      await reply(
        `No tienes acceso a la búsqueda. Tu chat id es <code>${escapeHtml(chat)}</code>.`,
      );
      return;
    }

    if (command === "help") {
      await reply(HELP);
      return;
    }

    // `/buscar x` and a bare `x` both search; any other command is unknown.
    if (command !== "" && command !== "buscar" && command !== "search") {
      await reply(HELP);
      return;
    }

    const query = normalizeQuery(args);
    if (query === "") {
      await reply(HELP);
      return;
    }

    const run: SearchFn =
      search ??
      ((q) => searchReleases(q, config.USER_AGENT, config.REQUIRE_CATEGORY));
    let results: Release[];
    try {
      results = await run(query);
    } catch (error) {
      console.error(`search failed for "${query}": ${error instanceof Error ? error.message : String(error)}`);
      await reply("No pude consultar el sitio ahora mismo. Inténtalo de nuevo en un rato.");
      return;
    }
    await reply(formatResults(query, results));
  } catch (error) {
    console.error(`bot update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

