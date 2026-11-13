/**
 * Pet Post → Chat / Records (docs/INTERACTIONS.md, "Chat / Records"): one conversation per
 * device — texts, files and reminders, sent and received, kept for good. First the list of
 * conversations; one opened, its lines and a box to write (Enter sends) or send files. What
 * didn't get there waits and goes by itself when the device is back (Cancel stops it).
 */
import { msg, t } from "../i18n";
import { clock } from "../i18n/format";
import { formatDay, formatWhen, h } from "../panel/dom";
import {
  chatConversations,
  chatKey,
  chatMatches,
  chatMerge,
  fileCount,
  namesLine,
  formatSize,
  transferOver,
  type ChatConversation,
  type PostChatEntry,
  type PostDevice,
  type PostTransfer,
} from "../features/post/post";
import { deviceName, kindWord, answerText, type ShareKind } from "../features/post/schedule";
import type { Backend, Settings } from "../platform/types";

/** What Chat / Records needs of the Pet Post window. */
export interface ChatContext {
  backend: Backend;
  settings: () => Settings;
  devices: () => PostDevice[];
  render: () => void;
  /** The delivery coming in now, and the one going out. */
  incoming: () => PostTransfer | null;
  outgoing: () => PostTransfer | null;
  /** The small Verified / Paired mark by a device's name. */
  badge: (fingerprint: string) => Node | null;
  copyButton: (css: string, text: string) => Node;
  /** Receive, where what was sent here waits for an answer. */
  showReceive: () => void;
}

/** All of it, the oldest first. */
let entries: PostChatEntry[] = [];
/** The conversation open (its key), or the list. */
let openKey: string | null = null;
let query = "";
/** What's being written, by conversation. */
const drafts = new Map<string, string>();
/** Its box takes the keys when it's drawn next (opened by Reply). */
let focusBox = false;
/** "Clear…" asked: the conversation that waits for yes. */
let clearing: string | null = null;
/** Something to say for a moment in the open conversation (a send that couldn't start). */
let note = "";
/** The thread's scroll: kept at the bottom unless scrolled up. */
let atBottom = true;
let scrollTop = 0;
let loaded = false;

export async function loadChat(ctx: ChatContext): Promise<void> {
  if (loaded) return;
  loaded = true;
  await ctx.backend.on("post-chat", (e) => {
    entries = chatMerge(entries, e);
    ctx.render();
  });
  await ctx.backend.on("post-chat-cleared", ({ key }) => {
    entries = key === null ? entries.filter((e) => e.state === "sending") : entries.filter((e) => chatKey(e) !== key || e.state === "sending");
    ctx.render();
  });
  entries = await ctx.backend.postChat().catch(() => []);
}

/** How many lines received haven't been looked at (the tab's badge). */
export function chatUnread(): number {
  return entries.filter((e) => e.unread).length;
}

/** Opens a device's conversation, its box ready to write in (Reply). */
export function openChat(key: string): void {
  openKey = key;
  query = "";
  focusBox = true;
  atBottom = true;
  note = "";
}

/** Back to the list. */
export function closeChat(): void {
  openKey = null;
  clearing = null;
  note = "";
}

/** Files dropped while a conversation is open: sent there (true). */
export function chatDrop(ctx: ChatContext, paths: string[]): boolean {
  const c = openKey ? conversation(openKey) : null;
  if (!c?.fingerprint || !paths.length) return false;
  void sendTo(ctx, c.fingerprint, null, paths);
  return true;
}

function conversation(key: string): ChatConversation | null {
  return chatConversations(entries).find((c) => c.key === key) ?? null;
}

/** How the device is called here: its nickname (paired), else its name. */
function nameOf(ctx: ChatContext, c: { fingerprint: string; alias: string }): string {
  return deviceName(ctx.settings().post, c.fingerprint, c.alias) || c.alias || "?";
}

async function sendTo(ctx: ChatContext, fingerprint: string, text: string | null, paths: string[]): Promise<void> {
  note = "";
  try {
    await ctx.backend.postChatSend(fingerprint, text, paths);
    if (text !== null && openKey) drafts.delete(openKey);
    atBottom = true;
  } catch (e) {
    note = String(e).includes("gone") ? t("That device isn't known here any more.") : t("Couldn't send: {error}", { error: String(e) });
  }
  ctx.render();
}

/** A record's files by name (the first 20 are kept): just each one's own name. */
function fileNames(e: PostChatEntry): string[] {
  return e.paths.map((p) => p.split(/[\\/]/).pop() || p);
}

/** One file: its name (shown in place of "1 file"). */
function onlyName(e: PostChatEntry): string | null {
  return e.files === 1 && e.paths.length >= 1 ? fileNames(e)[0] : null;
}

/** The Chat / Records tab: the list, or the conversation open. */
export function chatTab(ctx: ChatContext): Node[] {
  if (openKey) {
    const c = conversation(openKey);
    if (c) return thread(ctx, c);
    // (Cleared meanwhile.)
    openKey = null;
  }
  return list(ctx);
}

/** One line of the list: what the latest was. */
function preview(e: PostChatEntry): string {
  const mine = e.dir === "out";
  let what: string;
  if (e.kind === "text") what = e.text ?? "";
  else if (e.kind === "files") {
    const n = onlyName(e) ?? fileCount(e.files);
    what = mine ? t("Sent {files}", { files: n }) : t("Received {files} · {size}", { files: n, size: formatSize(e.bytes) });
  } else what = `${shareIcon(e.share)} ${e.text ?? ""}`;
  return mine && e.kind === "text" ? t("You: {text}", { text: what }) : what;
}

function list(ctx: ChatContext): Node[] {
  const search = h("input", { type: "search", class: "chat-search", placeholder: t("Search texts and file names"), value: query, "aria-label": t("Search") }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    ctx.render();
  });
  const all = chatConversations(entries);
  const shown = query.trim()
    ? all.filter((c) => entries.some((e) => chatKey(e) === c.key && chatMatches(e, query)))
    : all;
  const row = (c: ChatConversation) => {
    const name = nameOf(ctx, c);
    const found = ctx.devices().find((d) => d.fingerprint === c.fingerprint);
    const hit = query.trim() ? [...entries].reverse().find((e) => chatKey(e) === c.key && chatMatches(e, query)) : null;
    return h(
      "li",
      {},
      h(
        "button",
        { class: `chat-conv${c.unread ? " unread" : ""}`, "data-key": c.key, onclick: () => (openChat(c.key), ctx.render()) },
        h("span", { class: "chat-avatar", "aria-hidden": "true" }, [...name][0]?.toUpperCase() ?? "?"),
        h(
          "span",
          { class: "chat-conv-main" },
          h(
            "span",
            { class: "chat-conv-top" },
            h("strong", { class: "chat-conv-name" }, name),
            ctx.badge(c.fingerprint),
            name !== c.alias && c.alias ? h("span", { class: "hint" }, c.alias) : null,
            !c.fingerprint ? h("span", { class: "hint" }, t("(not told apart)")) : found ? null : h("span", { class: "hint" }, t("not online")),
            h("span", { class: "grow" }),
            h("span", { class: "hint chat-conv-when" }, formatWhen(c.last.at)),
          ),
          h(
            "span",
            { class: "chat-conv-bottom" },
            h("span", { class: "chat-conv-last" }, preview(hit ?? c.last)),
            c.unread ? h("span", { class: "post-tab-badge" }, String(c.unread)) : null,
          ),
        ),
      ),
    );
  };
  return ([
    all.length ? h("div", { class: "row" }, search) : null,
    shown.length
      ? h("ul", { class: "chat-convs" }, ...shown.map(row))
      : h("p", { class: "hint chat-empty" }, query.trim() ? t("Nothing matches.") : t("Nothing sent or received yet. Texts and files sent here and from here show up here, device by device.")),
    all.length && !query.trim() ? h("p", { class: "hint" }, t("Each device has its conversation; the latest first. Kept on this computer only.")) : null,
  ] as (Node | null)[]).filter((n): n is Node => n !== null);
}

function shareIcon(kind: string | null): string {
  return kind === "alarm" ? "⏰" : kind === "todo" ? "☑️" : "🎂";
}

/** A reminder received: how it went here. */
function shareInText(state: string): string {
  const words: Record<string, string> = {
    asked: msg("Waiting for your answer (Receive)"),
    added: msg("✓ Added"),
    updated: msg("✓ Updated"),
    have: msg("✓ Already here"),
    kept: msg("Kept yours"),
    declined: msg("Declined"),
  };
  return t(words[state] ?? msg("Declined"));
}

/** A sent line's state, and what can be done about it. */
function outState(ctx: ChatContext, e: PostChatEntry, who: string): Node {
  const cancel = h("button", { class: "link chat-cancel", onclick: () => void ctx.backend.postChatCancel(e.id) }, t("Cancel"));
  const again = h("button", { class: "link chat-retry", onclick: () => void ctx.backend.postChatRetry(e.id) }, t("Send again"));
  const line = (text: string, tone: string, ...actions: Node[]) =>
    h("span", { class: `chat-state ${tone}`, "data-state": e.state }, text, ...actions.flatMap((a) => [" · ", a]));
  switch (e.state) {
    case "sending":
      return line(t("Sending…"), "wait", cancel);
    case "done":
      return line(t("Delivered"), "ok");
    case "waiting":
      return line(t("Not delivered yet: goes by itself when {who} is back", { who }), "wait", cancel);
    case "declined":
      return line(t("{who} didn't take it", { who }), "no", again);
    case "cancelled":
      return line(t("Cancelled"), "no", again);
    default:
      return line(e.error === "gone" ? t("Not sent: the files aren't there any more") : t("Couldn't send"), "no", again);
  }
}

/** A delivery's progress bar (this line's, if it's the one going now). */
function progressOf(tr: PostTransfer | null): Node | null {
  if (!tr || transferOver(tr) || tr.total <= 0) return null;
  const pct = Math.floor((tr.done / tr.total) * 100);
  return h(
    "div",
    { class: "chat-progress" },
    h("progress", { max: 100, value: pct }),
    h("span", { class: "hint" }, `${pct}% · ${formatSize(tr.done)} / ${formatSize(tr.total)}`),
  );
}

function line(ctx: ChatContext, e: PostChatEntry, who: string, sendingNow: boolean): Node {
  const mine = e.dir === "out";
  const when = clock(e.at);
  if (e.kind === "share") {
    const kind = kindWord((e.share ?? "alarm") as ShareKind);
    const text = mine
      ? t("You sent {who} {kind} “{title}”", { who, kind, title: e.text ?? "" })
      : t("{who} sent {kind} “{title}”", { who, kind, title: e.text ?? "" });
    const how = mine ? answerText(e.state) : shareInText(e.state);
    return h(
      "li",
      { class: "chat-line chat-share-line", "data-id": e.id },
      h(
        "span",
        { class: "chat-share" },
        `${shareIcon(e.share)} ${text} · ${how}`,
        !mine && e.state === "asked" ? h("button", { class: "link chat-to-receive", onclick: () => ctx.showReceive() }, ` ${t("Answer")}`) : null,
        h("span", { class: "hint" }, ` ${when}`),
      ),
    );
  }
  let body: Node;
  if (e.kind === "text") {
    body = h("div", { class: "chat-bubble chat-text" }, e.text ?? "");
  } else {
    const names = fileNames(e);
    const single = onlyName(e);
    const n = fileCount(e.files);
    const size = formatSize(e.bytes);
    // A file by its name, opened when clicked; a few each on a line; many: the first two "and N more".
    const name = (i: number) =>
      h("button", { class: "link chat-file", title: t("Open"), onclick: () => void openFile(i) }, names[i]);
    let title: Node;
    let rest: Node | null = null;
    if (single) title = h("strong", {}, "📦 ", name(0), h("span", { class: "chat-file-size" }, ` · ${size}`));
    else {
      title = h("strong", {}, `📦 ${mine ? t("Sent {files} · {size}", { files: n, size }) : t("Received {files} · {size}", { files: n, size })}`);
      if (names.length && e.files <= 3 && names.length === e.files) rest = h("div", { class: "chat-file-names" }, ...names.map((_, i) => name(i)));
      else if (names.length) rest = h("div", { class: "hint chat-file-names" }, namesLine(names.slice(0, 2), e.files));
    }
    body = h("div", { class: "chat-bubble chat-files" }, title, rest, sendingNow ? progressOf(ctx.outgoing()) : null);
  }
  const gone = () => {
    note = t("Not there any more (moved or deleted).");
    ctx.render();
  };
  const open = () => ctx.backend.postChatOpen(e.id, true).catch(gone);
  const openFile = (i: number) => ctx.backend.postChatOpen(e.id, false, i).catch(gone);
  const meta = h(
    "div",
    { class: "chat-meta" },
    h("span", { class: "hint" }, when),
    e.kind === "text" && !mine ? ctx.copyButton("link chat-copy", e.text ?? "") : null,
    e.kind === "files" && (!mine || e.state === "done") && e.paths.length ? h("button", { class: "link chat-open", onclick: () => void open() }, t("Open folder")) : null,
    mine ? outState(ctx, e, who) : null,
  );
  return h("li", { class: `chat-line ${mine ? "out" : "in"}`, "data-id": e.id, "data-kind": e.kind }, body, meta);
}

function thread(ctx: ChatContext, c: ChatConversation): Node[] {
  const name = nameOf(ctx, c);
  const found = ctx.devices().find((d) => d.fingerprint === c.fingerprint);
  // Looked at: nothing here is new any more.
  if (c.unread) void ctx.backend.postChatRead(c.key);
  const status = !c.fingerprint
    ? t("Not told apart from other devices with this name: can't reply from here.")
    : found
      ? [t("Online"), found.epet ? "ePet" : "LocalSend"].join(" · ")
      : t("Not online: what you send waits, and goes when it's back.");
  const head = h(
    "div",
    { class: "chat-head row" },
    h("button", { class: "small chat-back", onclick: () => (closeChat(), ctx.render()) }, `‹ ${t("All conversations")}`),
    h(
      "div",
      { class: "grow chat-head-name" },
      h("div", {}, h("strong", {}, name), ctx.badge(c.fingerprint), name !== c.alias && c.alias ? h("span", { class: "hint" }, ` ${c.alias}`) : null),
      h("div", { class: `hint chat-online${found ? " on" : ""}` }, status),
    ),
    h("button", { class: "small chat-clear", onclick: () => ((clearing = c.key), ctx.render()) }, t("Clear…")),
  );
  const ask =
    clearing === c.key
      ? h(
          "div",
          { class: "box chat-clear-ask row" },
          h("span", { class: "grow" }, t("Clear everything with {who}? The files received stay where they are.", { who: name })),
          h("button", { class: "small danger chat-clear-yes", onclick: () => ((clearing = null), closeChat(), void ctx.backend.postChatClear(c.key)) }, t("Clear")),
          h("button", { class: "small", onclick: () => ((clearing = null), ctx.render()) }, t("Cancel")),
        )
      : null;

  const mine = entries.filter((e) => chatKey(e) === c.key);
  const out = ctx.outgoing();
  const sendingId = mine.filter((e) => e.state === "sending").pop()?.id;
  const items: Node[] = [];
  let day = "";
  for (const e of mine) {
    const d = formatDay(e.at);
    if (d !== day) {
      day = d;
      items.push(h("li", { class: "chat-day" }, d));
    }
    items.push(line(ctx, e, name, e.id === sendingId && !!out && !transferOver(out)));
  }
  // Coming in from it now.
  const inc = ctx.incoming();
  if (inc && !transferOver(inc) && inc.fingerprint && inc.fingerprint === c.fingerprint) {
    items.push(
      h(
        "li",
        { class: "chat-line in", "data-kind": "incoming" },
        h(
          "div",
          { class: "chat-bubble chat-files coming" },
          h("strong", {}, `📦 ${t("Receiving {files}…", { files: fileCount(inc.files) })}`),
          progressOf(inc),
        ),
        h("div", { class: "chat-meta" }, h("button", { class: "link chat-stop", onclick: () => void ctx.backend.postStopReceiving() }, t("Stop"))),
      ),
    );
  }
  const box = h("ol", { class: "chat-thread" }, ...items) as HTMLOListElement;
  box.addEventListener("scroll", () => {
    scrollTop = box.scrollTop;
    atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  });
  requestAnimationFrame(() => {
    box.scrollTop = atBottom ? box.scrollHeight : scrollTop;
  });

  const composer = c.fingerprint ? writeBox(ctx, c) : null;
  return ([head, ask, box, note ? h("p", { class: "warning chat-note" }, note) : null, composer] as (Node | null)[]).filter((n): n is Node => n !== null);
}

/** The box to write in (Enter sends, Shift+Enter a new line) and 📎 to send files. */
function writeBox(ctx: ChatContext, c: ChatConversation): Node {
  const fp = c.fingerprint;
  const text = h("textarea", { class: "chat-input", rows: 2, placeholder: t("Write something, or drop files here…"), "aria-label": t("Message") }) as HTMLTextAreaElement;
  text.value = drafts.get(c.key) ?? "";
  const go = () => {
    const v = text.value;
    if (!v.trim()) return;
    void sendTo(ctx, fp, v, []);
  };
  text.addEventListener("input", () => {
    drafts.set(c.key, text.value);
    sendButton.classList.toggle("primary", !!text.value.trim());
  });
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      go();
    }
  });
  const sendButton = h("button", { class: `chat-send${text.value.trim() ? " primary" : ""}`, onclick: go }, t("Send"));
  const files = h(
    "button",
    {
      class: "chat-attach",
      title: t("Send files…"),
      "aria-label": t("Send files…"),
      onclick: async () => {
        const paths = await ctx.backend.postPick(false, t("Choose files to send to {who}", { who: nameOf(ctx, c) }));
        if (paths?.length) void sendTo(ctx, fp, null, paths);
      },
    },
    "📎",
  );
  if (focusBox) {
    focusBox = false;
    setTimeout(() => {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    });
  }
  return h("div", { class: "chat-write row" }, files, text, sendButton);
}

/** Settings → Pet Post: how much is kept, and Clear all. */
export function chatCount(): { entries: number; conversations: number } {
  return { entries: entries.length, conversations: chatConversations(entries).length };
}

/** For e2e: what's shown. */
export function chatState(): { open: string | null; entries: PostChatEntry[] } {
  return { open: openKey, entries };
}
