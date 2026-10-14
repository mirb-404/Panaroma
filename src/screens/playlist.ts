import * as api from "../api";
import { decodeEntities, h } from "../dom";
import { BrowseView } from "../ui/browse";
import { errorPanel } from "./common";

export function playlistScreen(p: api.Playlist) {
  const header = h(
    "header.list-head",
    null,
    h("h1", null, decodeEntities(p.title)),
    h("div.channel-stats", null, [p.channelTitle, p.countText].filter(Boolean).join("  ·  ")),
  );
  return new BrowseView({
    header,
    rows: [{ title: "", layout: "grid", load: () => api.playlistVideos(p.id) }],
    empty: errorPanel,
  });
}
