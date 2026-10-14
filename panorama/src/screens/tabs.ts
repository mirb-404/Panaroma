// Root tab screens: Home, Subscriptions, Library — all thin configurations of
// the shared BrowseView.
import * as api from "../api";
import { signedIn } from "../auth";
import { BrowseView, type RowSpec } from "../ui/browse";
import { errorPanel } from "./common";

export function homeScreen() {
  const rows: RowSpec[] = [];
  if (signedIn()) {
    rows.push({
      title: "Latest from your subscriptions",
      load: async () => api.subscriptionFeed(await api.mySubscriptions(), 20),
    });
  }
  rows.push(...api.HOME_CATEGORIES.map((c) => ({ title: c.title, load: () => api.trending(c.id) })));
  return new BrowseView({ hero: true, rows, empty: errorPanel });
}

export function subscriptionsScreen() {
  const subs = signedIn() ? api.mySubscriptions() : Promise.reject(new api.ApiError("Sign in", 401, "signedOut"));
  return new BrowseView({
    hero: true,
    rows: [
      { title: "Latest videos", load: async () => api.subscriptionFeed(await subs) },
      { title: "Your channels", load: () => subs },
    ],
    empty: errorPanel,
  });
}

export function libraryScreen() {
  const auth = signedIn();
  const reject = () => Promise.reject(new api.ApiError("Sign in", 401, "signedOut"));
  return new BrowseView({
    hero: true,
    rows: [
      { title: "Liked videos", load: auth ? api.likedVideos : reject },
      { title: "Your playlists", load: auth ? api.myPlaylists : reject },
    ],
    empty: errorPanel,
  });
}
