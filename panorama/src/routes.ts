import type { Item, Video } from "./api";
import { router } from "./router";
import { channelScreen } from "./screens/channel";
import { playerScreen } from "./screens/player";
import { playlistScreen } from "./screens/playlist";

export function openItem(item: Item, queue: Video[] = []) {
  if (item.kind === "video") router.push(playerScreen(item, queue.length ? queue : [item]));
  else if (item.kind === "channel") router.push(channelScreen(item.id));
  else router.push(playlistScreen(item));
}

export function openChannel(id: string) {
  router.push(channelScreen(id));
}
