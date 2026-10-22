// The player's account drawers: comments, and saving to Watch later or a
// playlist. Both slide in from the right like the playback menu (same drawer
// styles), take ▲ ▼ / Ⓐ from the controller and work with the mouse.
import * as api from "../api";
import { decodeEntities, h, icon } from "../dom";
import { pointerIsActive, type ActionEvent } from "../input";
import { router } from "../router";
import { settings } from "../settings";
import { cue } from "../sound";
import { toast } from "./chrome";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function drawer(title: string, body: HTMLElement, status: HTMLElement, legend: string): HTMLElement {
  const el: HTMLElement = h(
    "div.overlay.playback-settings",
    {
      onclick: (ev: Event) => {
        if (ev.target === el) router.closeOverlay();
      },
    },
    h("div.ps-panel", null, h("h2", null, title), body, status, h("p.te-legend", null, legend)),
  );
  return el;
}

function scrollToItem(list: HTMLElement, item: HTMLElement | undefined) {
  if (!item) return;
  const top = item.offsetTop - list.offsetTop - list.clientHeight * 0.3;
  list.scrollTo({ top, behavior: settings().reducedMotion ? "auto" : "smooth" });
}

// ---- comments -----------------------------------------------------------------

function commentEl(c: api.Comment): HTMLElement {
  const foot = [
    c.likesText ? h("span.cm-stat", null, icon("like", "icon cm-icon"), c.likesText) : null,
    c.repliesText ? h("span.cm-stat", null, icon("comments", "icon cm-icon"), c.repliesText) : null,
  ];
  return h(
    "div.cm-item",
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

export function openComments(token: string, countText: string) {
  const list = h("div.ps-list.cm-list", { "data-native-scroll": true });
  const status = h("p.ps-help", null, "Loading comments…");
  const items: HTMLElement[] = [];
  let idx = 0;
  let next: string | undefined = token;
  let loading = false;
  let closed = false;

  const sync = () => {
    items.forEach((el, i) => el.classList.toggle("focused", i === idx));
    scrollToItem(list, items[idx]);
    if (idx >= items.length - 5) void load();
  };

  async function load() {
    if (!next || loading) return;
    loading = true;
    const t = next;
    try {
      const page = await api.comments(t);
      if (closed) return;
      next = page.next;
      for (const c of page.comments) {
        const el = commentEl(c);
        const i = items.length;
        el.addEventListener("mousemove", () => {
          if (idx !== i && pointerIsActive()) {
            idx = i;
            items.forEach((x, j) => x.classList.toggle("focused", j === idx));
          }
        });
        items.push(el);
        list.append(el);
      }
      status.textContent = items.length ? "" : "No comments yet.";
      items.forEach((el, i) => el.classList.toggle("focused", i === idx));
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

  router.openOverlay({
    el: drawer(countText ? `Comments · ${countText}` : "Comments", list, status, "▲ ▼ scroll   Ⓑ / ☰ close   ·   Mouse: wheel, or click outside to close"),
    onClose: () => (closed = true),
    onAction(e: ActionEvent) {
      if (e.action === "up") idx = Math.max(0, idx - 1);
      else if (e.action === "down") idx = Math.min(items.length - 1, idx + 1);
      else if (e.action === "menu") {
        router.closeOverlay();
        return true;
      } else return e.action === "select" || e.action === "left" || e.action === "right";
      sync();
      return true;
    },
  });
  void load();
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
    el: drawer("Save to", list, status, "Ⓐ save / remove   Ⓑ / ☰ close   ·   Mouse: click, or click outside to close"),
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
      scrollToItem(list, rows[idx]);
      return true;
    },
  });
}
