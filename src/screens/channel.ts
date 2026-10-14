import * as api from "../api";
import { decodeEntities, h } from "../dom";
import { BrowseView } from "../ui/browse";
import { setBackdrop } from "../ui/chrome";
import { errorPanel } from "./common";

export function channelScreen(id: string) {
  const ch = api.channel(id);
  const avatar = h("img.channel-avatar", { alt: "", referrerpolicy: "no-referrer" });
  const header = h("header.channel-head", null, avatar, h("div", null, h("h1"), h("div.channel-stats")));
  ch.then((c) => {
    if (c.avatar) avatar.src = c.avatar;
    header.querySelector("h1")!.textContent = decodeEntities(c.title);
    header.querySelector(".channel-stats")!.textContent = [c.subscribersText, c.videosText].filter(Boolean).join("  ·  ");
    if (c.banner) setBackdrop(c.banner, true);
  }).catch(() => {});

  const view = new BrowseView({
    header,
    rows: [
      { title: "Videos", layout: "grid", load: () => api.channelVideos(id) },
      { title: "Playlists", load: () => api.channelPlaylists(id) },
    ],
    empty: errorPanel,
    youtubePath: `/channel/${id}`,
  });
  const show = view.onShow.bind(view);
  view.onShow = () => {
    show();
    ch.then((c) => c.banner && setBackdrop(c.banner, true)).catch(() => {});
  };
  view.el.classList.add("channel-screen");
  return view;
}
