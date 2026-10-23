// The player's account panels: comments, live chat, and saving to Watch later
// or a playlist. Comments and chat are feeds that live either in the side panel
// (split layout) or in a drawer that slides in from the right like the playback
// menu (same drawer styles). Every feed takes ▲ ▼ / Ⓐ from the controller or
// keyboard and works with the mouse alone.
import * as api from "../api";
import { decodeEntities, h, icon, keepInView } from "../dom";
import { pointerIsActive, type ActionEvent } from "../input";
import { router } from "../router";
import { cue } from "../sound";
import { toast } from "./chrome";
import { openTextEntry } from "./textentry";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function drawer(title: string, legend: string, ...body: HTMLElement[]): HTMLElement {
  const el: HTMLElement = h(
    "div.overlay.playback-settings",
    {
      onclick: (ev: Event) => {
        if (ev.target === el) router.closeOverlay();
      },
    },
    h("div.ps-panel", null, h("h2", null, title), ...body, h("p.te-legend", null, legend)),
  );
  return el;
}

/** A scrolling list of comments or chat, for the side panel or a drawer. */
export interface Feed {
  el: HTMLElement;
  /** Shows the highlight; the side panel turns it off while focus is elsewhere. */
  setActive(on: boolean): void;
  /** ▲ on the first item and ◀ ▶ are left unhandled, so the side panel can move on. */
  onAction(e: ActionEvent): boolean;
  destroy(): void;
}

/** Opens a feed in a drawer. */
function feedDrawer(title: string, legend: string, feed: Feed) {
  feed.setActive(true);
  router.openOverlay({
    el: drawer(title, legend, feed.el),
    onClose: () => feed.destroy(),
    onAction(e: ActionEvent) {
      if (e.action === "menu") {
        router.closeOverlay();
        return true;
      }
      return feed.onAction(e) || e.action === "up" || e.action === "left" || e.action === "right";
    },
  });
}

// ---- comments -----------------------------------------------------------------

function commentEl(c: api.Comment, reply: boolean): HTMLElement {
  const foot = [
    c.likesText ? h("span.cm-stat", null, icon("like", "icon cm-icon"), c.likesText) : null,
    c.repliesToken ? h("span.cm-stat.cm-replies", null, icon("comments", "icon cm-icon"), h("span", null, c.repliesText || "Replies")) : null,
  ];
  return h(
    `div.cm-item${reply ? ".cm-reply" : ""}`,
    null,
    c.avatar ? h("img.cm-avatar", { src: c.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("div.cm-avatar"),
    h(
      "div.cm-body",
      null,
      h("div.cm-head", null, h("span.cm-author", null, c.author), h("span.cm-age", null, c.ageText)),
      h("p.cm-text", null, decodeEntities(c.text)),
      foot.some(Boolean) ? h("div.cm-foot", null, ...foot) : null,
    ),
  );
}

/**
 * Comments, with their replies: Ⓐ (or a click) on a comment that has replies
 * opens them under it, and again closes them. More load before the end.
 */
export function commentsFeed(token: string): Feed {
  const list = h("div.ps-list.cm-list", { "data-native-scroll": true });
  const status = h("p.ps-help", null, "Loading comments…");
  const el = h("div.feed", null, list, status);
  /** Rows in on-screen order: comments, replies and "more replies" rows. */
  const rows: { el: HTMLElement; run?: () => void }[] = [];
  let idx = 0;
  let active = false;
  let next: string | undefined = token;
  let loading = false;
  let closed = false;

  const paint = () => rows.forEach((r, i) => r.el.classList.toggle("focused", active && i === idx));
  const sync = () => {
    paint();
    keepInView(list, rows[idx]?.el);
    if (idx >= rows.length - 5) void load();
  };

  function insertRows(after: number, added: { el: HTMLElement; run?: () => void }[]) {
    const anchor = rows[after + 1]?.el ?? null;
    for (const r of added) {
      list.insertBefore(r.el, anchor);
      r.el.addEventListener("click", () => {
        idx = rows.indexOf(r);
        r.run?.();
        paint();
      });
      r.el.addEventListener("mousemove", () => {
        const i = rows.indexOf(r);
        if (idx !== i && pointerIsActive()) ((idx = i), paint());
      });
    }
    rows.splice(after + 1, 0, ...added);
  }

  function commentRow(c: api.Comment, reply: boolean) {
    const row: { el: HTMLElement; run?: () => void } = { el: commentEl(c, reply) };
    if (!c.repliesToken) return row;
    // The thread's replies, once open: removed again on close.
    let children: { el: HTMLElement; run?: () => void }[] = [];
    let busy = false;
    const label = row.el.querySelector(".cm-replies span")!;
    const setOpen = (open: boolean) => {
      row.el.classList.toggle("open", open);
      label.textContent = open ? "Hide replies" : c.repliesText || "Replies";
    };
    const loadReplies = async (t: string, more?: { el: HTMLElement }) => {
      busy = true;
      try {
        const page = await api.comments(t);
        // Closed again (or the feed went away) while loading.
        if (closed || !row.el.classList.contains("open")) return;
        const added = page.comments.map((r) => commentRow(r, true));
        if (page.next) {
          const moreRow: { el: HTMLElement; run?: () => void } = { el: h("div.cm-item.cm-reply.cm-more", null, "Show more replies") };
          moreRow.run = () => void loadReplies(page.next!, moreRow);
          added.push(moreRow);
        }
        let at = rows.indexOf(row) + children.length;
        if (more) {
          // Replace the "Show more replies" row with the next page.
          at = rows.indexOf(more) - 1;
          rows.splice(at + 1, 1);
          more.el.remove();
          children = children.filter((x) => x !== more);
        }
        insertRows(at, added);
        children.push(...added);
        paint();
      } catch (e) {
        toast(`Couldn't load replies: ${errText(e)}`, "error", 5000);
        if (!more) setOpen(false);
      } finally {
        busy = false;
      }
    };
    row.run = () => {
      if (busy) return;
      if (row.el.classList.contains("open")) {
        const at = rows.indexOf(row);
        if (idx > at && idx <= at + children.length) idx = at;
        rows.splice(at + 1, children.length);
        children.forEach((x) => x.el.remove());
        children = [];
        setOpen(false);
        cue("toggleOff");
      } else {
        setOpen(true);
        cue("toggleOn");
        void loadReplies(c.repliesToken!);
      }
      paint();
    };
    return row;
  }

  async function load() {
    if (!next || loading) return;
    loading = true;
    const t = next;
    try {
      const page = await api.comments(t);
      if (closed) return;
      next = page.next;
      insertRows(rows.length - 1, page.comments.map((c) => commentRow(c, false)));
      status.textContent = rows.length ? "" : "No comments yet.";
      paint();
    } catch (e) {
      if (!closed) status.textContent = `Couldn't load comments: ${errText(e)}`;
    } finally {
      loading = false;
    }
  }

  // Mouse wheel / scrollbar: fetch more before the end comes into view.
  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - list.clientHeight) void load();
  });
  void load();

  return {
    el,
    setActive(on) {
      active = on;
      if (on) sync();
      else paint();
    },
    onAction(e) {
      if (e.action === "up") {
        if (idx === 0) return false;
        idx--;
      } else if (e.action === "down") idx = Math.min(rows.length - 1, idx + 1);
      else if (e.action === "select") rows[idx]?.run?.();
      else return false;
      sync();
      return true;
    },
    destroy: () => (closed = true),
  };
}

export function openComments(token: string, countText: string) {
  feedDrawer(
    countText ? `Comments · ${countText}` : "Comments",
    "▲ ▼ scroll   Ⓐ replies   Ⓑ / ☰ close   ·   Mouse: wheel, click for replies, click outside to close",
    commentsFeed(token),
  );
}

// ---- live chat -----------------------------------------------------------------

const CHAT_MAX = 250;

function chatEl(m: api.ChatMessage): HTMLElement {
  return h(
    `div.chat-msg.chat-${m.kind}`,
    null,
    m.avatar ? h("img.chat-avatar", { src: m.avatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
    h(
      "p.chat-line",
      null,
      m.author ? h("span.chat-author", null, m.author) : null,
      m.amount ? h("span.chat-amount", null, m.amount) : null,
      h("span.chat-text", null, decodeEntities(m.text)),
    ),
  );
}

/**
 * Live chat, or a finished stream's chat replay in step with `positionMs`.
 * Follows the newest message until ▲ (or the wheel) moves back; ▼ past the
 * last message follows again. Ⓐ writes a message when the viewer may chat.
 * Only polls while `visible()`.
 */
export function chatFeed(source: api.ChatSource, positionMs: () => number, visible: () => boolean): Feed {
  const list = h("div.ps-list.chat-list", { "data-native-scroll": true });
  const pinned = h("div.chat-pinned", { hidden: true });
  const status = h("p.ps-help", null, source.replay ? "Loading chat replay…" : "Connecting to live chat…");
  const compose = h("button.chat-compose", { hidden: true, onclick: () => write() }, icon("comments", "icon cm-icon"), "Chat…");
  const el = h("div.feed.chat-feed", null, pinned, list, status, compose);
  const shown: HTMLElement[] = [];
  const byId = new Map<string, HTMLElement>();
  /** Replay: fetched messages waiting for the video to reach them. */
  let queued: api.ChatMessage[] = [];
  let next: string | undefined = source.token;
  let seek: string | undefined;
  let sendParams: string | undefined;
  let lastPos = -1;
  let idx = -1; // -1: following the newest
  let active = false;
  let closed = false;
  let timer = 0;

  const paint = () => shown.forEach((m, i) => m.classList.toggle("focused", active && i === idx));
  const toBottom = () => (list.scrollTop = list.scrollHeight);

  function show(msgs: api.ChatMessage[]) {
    for (const m of msgs) {
      if (byId.has(m.id)) continue;
      const row = chatEl(m);
      row.addEventListener("mousemove", () => {
        const i = shown.indexOf(row);
        if (idx !== i && pointerIsActive()) ((idx = i), paint());
      });
      byId.set(m.id, row);
      shown.push(row);
      list.append(row);
    }
    while (shown.length > CHAT_MAX) {
      const old = shown.shift()!;
      old.remove();
      for (const [id, e] of byId) if (e === old) byId.delete(id);
      if (idx > 0) idx--;
    }
    if (shown.length) status.textContent = "";
    if (idx < 0) toBottom();
  }

  function apply(page: api.ChatPage) {
    for (const id of page.deleted) {
      const row = byId.get(id);
      if (row) row.querySelector(".chat-text")!.textContent = "[message removed]";
    }
    if (page.pinned) {
      pinned.replaceChildren(h("span.chat-pin-label", null, "Pinned"), chatEl(page.pinned));
      pinned.hidden = false;
    }
    if (page.sendParams !== sendParams) {
      sendParams = page.sendParams;
      compose.hidden = !sendParams;
    }
  }

  function clear() {
    shown.forEach((m) => m.remove());
    shown.length = 0;
    byId.clear();
    queued = [];
    idx = -1;
  }

  async function tick() {
    if (closed) return;
    let wait = 1000;
    if (visible() && next) {
      try {
        if (source.replay) {
          const pos = positionMs();
          // A seek: start over from the new position.
          if (lastPos >= 0 && (pos < lastPos - 3000 || pos > lastPos + 60000)) {
            clear();
            next = seek ?? source.token;
          }
          lastPos = pos;
          show(queued.filter((m) => m.offsetMs <= pos));
          queued = queued.filter((m) => m.offsetMs > pos);
          if (!queued.length || queued[queued.length - 1].offsetMs < pos + 10000) {
            const page = await api.liveChat(source, next, pos);
            if (closed) return;
            apply(page);
            const seen = new Set(queued.map((m) => m.id));
            queued.push(...page.messages.filter((m) => !seen.has(m.id) && !byId.has(m.id)));
            queued.sort((a, b) => a.offsetMs - b.offsetMs);
            next = page.next;
            seek = page.seek ?? seek;
            if (!shown.length && !queued.length) status.textContent = page.next ? "" : "No chat to replay.";
          }
        } else {
          const page = await api.liveChat(source, next);
          if (closed) return;
          apply(page);
          show(page.messages);
          next = page.next;
          if (!next) status.textContent = "The live chat has ended.";
          else if (!shown.length) status.textContent = "No messages yet.";
          wait = Math.min(10000, Math.max(1500, page.waitMs));
        }
      } catch (e) {
        if (closed) return;
        status.textContent = `Couldn't load chat: ${errText(e)}`;
        wait = 10000;
      }
    }
    timer = window.setTimeout(tick, wait);
  }

  function write() {
    const params = sendParams;
    if (!params) return toast("You can't chat here");
    openTextEntry({
      title: "Chat",
      hint: "Your message is posted publicly with your YouTube name.",
      submitLabel: "Send",
      onSubmit: async (text) => {
        if (!text.trim()) return;
        try {
          await api.sendChat(params, text.trim());
          cue("toggleOn");
          idx = -1;
          paint();
        } catch (e) {
          toast(`Couldn't send: ${errText(e)}`, "error", 5000);
        }
      },
    });
  }

  // The wheel moves away from the newest message; back at the bottom, follow again.
  list.addEventListener("wheel", () =>
    requestAnimationFrame(() => {
      idx = list.scrollTop + list.clientHeight >= list.scrollHeight - 8 ? -1 : Math.max(0, idx < 0 ? shown.length - 1 : idx);
      paint();
    }),
  );
  void tick();

  return {
    el,
    setActive(on) {
      active = on;
      paint();
    },
    onAction(e) {
      if (e.action === "up") {
        if (!shown.length || idx === 0) return false;
        idx = idx < 0 ? shown.length - 1 : idx - 1;
        keepInView(list, shown[idx]);
      } else if (e.action === "down") {
        if (idx < 0) return true;
        idx++;
        if (idx >= shown.length) ((idx = -1), toBottom());
        else keepInView(list, shown[idx]);
      } else if (e.action === "select") {
        if (source.replay) return true;
        write();
      } else return false;
      paint();
      return true;
    },
    destroy() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

export function openChat(source: api.ChatSource, positionMs: () => number) {
  feedDrawer(
    source.replay ? "Chat replay" : "Live chat",
    source.replay
      ? "▲ ▼ scroll   Ⓑ / ☰ close   ·   Mouse: wheel, or click outside to close"
      : "▲ ▼ scroll   Ⓐ chat   Ⓑ / ☰ close   ·   Mouse: wheel, Chat… to write, click outside to close",
    chatFeed(source, positionMs, () => true),
  );
}

// ---- save to playlist ----------------------------------------------------------

export function openSaveTo(video: api.Video) {
  const list = h("div.ps-list");
  const status = h("p.ps-help", null, "Loading your playlists…");
  let targets: api.SaveTarget[] = [];
  let rows: HTMLElement[] = [];
  let idx = 0;
  const busy = new Set<string>();

  const sync = () => {
    rows.forEach((row, i) => {
      row.classList.toggle("focused", i === idx);
      row.classList.toggle("on", targets[i].saved);
      row.querySelector(".s-value")!.replaceChildren(targets[i].saved ? icon("check") : icon("add"));
    });
  };

  async function toggle(i: number) {
    const t = targets[i];
    if (!t || busy.has(t.playlistId)) return;
    const on = !t.saved;
    t.saved = on;
    busy.add(t.playlistId);
    cue(on ? "toggleOn" : "toggleOff");
    sync();
    try {
      await api.setSaved(video.id, t.playlistId, on);
      toast(on ? `Saved to ${t.title}` : `Removed from ${t.title}`, "success");
    } catch (e) {
      t.saved = !on;
      sync();
      toast(`Couldn't update ${t.title}: ${errText(e)}`, "error", 5000);
    } finally {
      busy.delete(t.playlistId);
    }
  }

  api
    .saveTargets(video.id)
    .then((found) => {
      targets = found;
      rows = found.map((t, i) =>
        h(
          "div.s-row.save-row",
          {
            onclick: () => {
              idx = i;
              void toggle(i);
            },
            onmousemove: () => {
              if (idx !== i && pointerIsActive()) ((idx = i), sync());
            },
          },
          h("span.s-label", null, decodeEntities(t.title)),
          h("span.s-value"),
        ),
      );
      list.replaceChildren(...rows);
      status.textContent = decodeEntities(video.title);
      sync();
    })
    .catch((e) => (status.textContent = `Couldn't load your playlists: ${errText(e)}`));

  router.openOverlay({
    el: drawer("Save to", "Ⓐ save / remove   Ⓑ / ☰ close   ·   Mouse: click, or click outside to close", list, status),
    onAction(e: ActionEvent) {
      if (e.action === "up") idx = Math.max(0, idx - 1);
      else if (e.action === "down") idx = Math.min(rows.length - 1, idx + 1);
      else if (e.action === "select") {
        void toggle(idx);
        return true;
      } else if (e.action === "menu") {
        router.closeOverlay();
        return true;
      } else return e.action === "left" || e.action === "right";
      sync();
      keepInView(list, rows[idx]);
      return true;
    },
  });
}
