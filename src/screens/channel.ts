import * as api from "../api";
import { decodeEntities, fmtCount, h } from "../dom";
import { BrowseView } from "../ui/browse";
import { setBackdrop } from "../ui/chrome";
import { errorPanel } from "./common";

export function channelScreen(id: string) {
  const ch = api.channel(id);
  const header = h("header.channel-head", null, h("div.channel-avatar"), h("div", null, h("h1"), h("div.channel-stats")));
  ch.then((c) => {
    (header.querySelector(".channel-avatar") as HTMLElement).style.backgroundImage = `url("${c.avatar}")`;
    header.querySelector("h1")!.textContent = decodeEntities(c.title);
    header.querySelector(".channel-stats")!.textContent = [fmtCount(c.subscribers, "subscriber"), fmtCount(c.videoCount, "video")]
      .filter(Boolean)
      .join("  ·  ");
    if (c.banner) setBackdrop(c.banner, true);
  }).catch(() => {});

  const view = new BrowseView({
    header,
    rows: [
      { title: "Uploads", layout: "grid", load: async () => api.playlistVideos((await ch).uploads ?? "UU" + id.slice(2)) },
      { title: "Playlists", load: () => api.channelPlaylists(id) },
    ],
    empty: errorPanel,
  });
  const show = view.onShow.bind(view);
  view.onShow = () => {
    show();
    ch.then((c) => c.banner && setBackdrop(c.banner, true)).catch(() => {});
  };
  view.el.classList.add("channel-screen");
  return view;
}
