// Root tab screens: Home, Subscriptions, Library — all thin configurations of
// the shared BrowseView, fed by the signed-in YouTube account.
import * as api from "../api";
import { signedIn } from "../auth";
import { BrowseView, type RowSpec } from "../ui/browse";
import { errorPanel } from "./common";

const signedOut = () => Promise.reject(new api.ApiError("Sign in", 401, "signedOut"));

/** One row that fails with "signed out" so the screen shows the sign-in panel. */
const signInRows = (): RowSpec[] => [{ title: "", load: signedOut }];

export function homeScreen() {
  if (!signedIn()) return new BrowseView({ hero: true, rows: signInRows(), empty: errorPanel });
  return new BrowseView({
    hero: true,
    rows: [
      { title: "Recommended for you", load: () => api.homeFeedPage(0) },
      { title: "Latest from your subscriptions", load: api.subscriptionFeed },
      { title: "Continue watching", load: api.history },
      { title: "Picked for you", load: () => api.homeFeedPage(1) },
      { title: "Watch later", load: api.watchLater },
      { title: "More to explore", load: () => api.homeFeedPage(2) },
    ],
    empty: errorPanel,
    youtubePath: "/",
    refresh: api.refreshHome,
  });
}

export function subscriptionsScreen() {
  if (!signedIn()) return new BrowseView({ hero: true, rows: signInRows(), empty: errorPanel });
  return new BrowseView({
    hero: true,
    rows: [
      { title: "Latest videos", load: api.subscriptionFeed },
      { title: "Your channels", load: api.subscribedChannels },
    ],
    empty: errorPanel,
    youtubePath: "/feed/subscriptions",
  });
}

export function libraryScreen() {
  if (!signedIn()) return new BrowseView({ hero: true, rows: signInRows(), empty: errorPanel });
  return new BrowseView({
    hero: true,
    rows: [
      { title: "Continue watching", load: api.history },
      { title: "Watch later", load: api.watchLater },
      { title: "Liked videos", load: api.likedVideos },
      { title: "Your playlists", load: api.myPlaylists },
    ],
    empty: errorPanel,
    youtubePath: "/feed/you",
  });
}
