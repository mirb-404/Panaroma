import * as api from "../api";
import { signedIn } from "../auth";
import { decodeEntities, h } from "../dom";
import { BrowseView } from "../ui/browse";
import { errorPanel } from "./common";

export function playlistScreen(p: api.Playlist) {
  const header = h(
    "header.list-head",
    null,
    h("h1", null, decodeEntities(p.title)),
    h("div.channel-stats", null, [p.channelTitle, p.count !== undefined ? `${p.count} videos` : ""].filter(Boolean).join("  ·  ")),
  );
  // Private playlists of the signed-in user need the OAuth token.
  return new BrowseView({
    header,
    rows: [{ title: "", layout: "grid", load: () => api.playlistVideos(p.id, signedIn()) }],
    empty: errorPanel,
  });
}
