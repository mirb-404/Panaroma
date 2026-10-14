// YouTube Data API v3 client: normalizes responses into the few shapes the UI
// renders, caches aggressively, and meters quota (10,000 units/day per key).
import { accessToken } from "./auth";
import { cacheGet, cachePut } from "./cache";
import { addQuota, settings } from "./settings";

const BASE = "https://www.googleapis.com/youtube/v3/";
const MIN = 60_000;

export interface Video {
  kind: "video";
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  description: string;
  durationSec: number;
  views?: number;
  likes?: number;
  live: boolean;
  thumb: string;
  thumbLarge: string;
}

export interface Channel {
  kind: "channel";
  id: string;
  title: string;
  description: string;
  avatar: string;
  banner?: string;
  subscribers?: number;
  videoCount?: number;
  uploads?: string;
}

export interface Playlist {
  kind: "playlist";
  id: string;
  title: string;
  channelTitle: string;
  count?: number;
  thumb: string;
  thumbLarge: string;
}

export type Item = Video | Channel | Playlist;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = "",
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

async function call<T>(path: string, params: Params, opts: { units: number; ttl: number; auth?: boolean }): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const key = `${opts.auth ? "me:" : ""}${path}?${qs}`;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) {
    if (opts.auth) throw new ApiError("Sign in to see this", 401, "signedOut");
    const { demoResponse } = await import("./demo");
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 400));
    return demoResponse(path, qs) as T;
  }
  const hit = await cacheGet<T>(key, opts.ttl);
  if (hit) return hit;

  // Every request — public or personal — is authorized by the signed-in user's
  // Google token; there is no API key.
  const token = await accessToken();
  if (!token) throw new ApiError("Sign in with Google to start watching", 401, "signedOut");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}?${qs}`, { headers });
  } catch {
    throw new ApiError("You're offline", 0, "offline");
  }
  addQuota(opts.units);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? "";
    const msg =
      reason === "quotaExceeded"
        ? "Daily YouTube API quota reached — it resets at midnight Pacific"
        : (body?.error?.message ?? `YouTube API error ${res.status}`);
    throw new ApiError(msg, res.status, reason);
  }
  cachePut(key, body);
  return body as T;
}

// ---- normalization -------------------------------------------------------

function thumbs(t: any): { thumb: string; thumbLarge: string } {
  t ??= {};
  const pick = (...k: string[]) => k.map((n) => t[n]?.url).find(Boolean) ?? "";
  return {
    thumb: pick("medium", "high", "standard", "default"),
    thumbLarge: pick("maxres", "standard", "high", "medium", "default"),
  };
}

export function parseDuration(iso: string | undefined): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + +(m[4] ?? 0);
}

function toVideo(v: any): Video {
  const s = v.snippet ?? {};
  return {
    kind: "video",
    id: v.id,
    title: s.title ?? "",
    channelId: s.channelId ?? "",
    channelTitle: s.channelTitle ?? "",
    publishedAt: s.publishedAt ?? "",
    description: s.description ?? "",
    durationSec: parseDuration(v.contentDetails?.duration),
    views: v.statistics?.viewCount ? +v.statistics.viewCount : undefined,
    likes: v.statistics?.likeCount ? +v.statistics.likeCount : undefined,
    live: s.liveBroadcastContent === "live",
    ...thumbs(s.thumbnails),
  };
}

function toChannel(c: any): Channel {
  const s = c.snippet ?? {};
  const banner = c.brandingSettings?.image?.bannerExternalUrl;
  return {
    kind: "channel",
    id: typeof c.id === "string" ? c.id : (s.resourceId?.channelId ?? ""),
    title: s.title ?? "",
    description: s.description ?? "",
    avatar: s.thumbnails?.high?.url ?? s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? "",
    banner: banner ? `${banner}=w2560` : undefined,
    subscribers: c.statistics?.hiddenSubscriberCount ? undefined : num(c.statistics?.subscriberCount),
    videoCount: num(c.statistics?.videoCount),
    uploads: c.contentDetails?.relatedPlaylists?.uploads,
  };
}

function toPlaylist(p: any): Playlist {
  const s = p.snippet ?? {};
  return {
    kind: "playlist",
    id: p.id,
    title: s.title ?? "",
    channelTitle: s.channelTitle ?? "",
    count: num(p.contentDetails?.itemCount),
    ...thumbs(s.thumbnails),
  };
}

const num = (s: string | undefined) => (s ? +s : undefined);

/** Hydrates ids into full videos (durations, stats). 1 unit per 50 ids. */
export async function videosById(ids: string[]): Promise<Video[]> {
  const out: Video[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await call<any>(
      "videos",
      { part: "snippet,contentDetails,statistics", id: chunk.join(","), maxResults: 50 },
      { units: 1, ttl: 60 * MIN },
    );
    const byId = new Map<string, Video>((r.items ?? []).map((v: any) => [v.id, toVideo(v)]));
    for (const id of chunk) {
      const v = byId.get(id);
      if (v) out.push(v);
    }
  }
  return out;
}

// ---- public queries --------------------------------------------------------

export async function trending(categoryId?: string): Promise<Video[]> {
  const r = await call<any>(
    "videos",
    {
      part: "snippet,contentDetails,statistics",
      chart: "mostPopular",
      regionCode: settings().region,
      videoCategoryId: categoryId,
      maxResults: 50,
    },
    { units: 1, ttl: 30 * MIN },
  );
  return (r.items ?? []).map(toVideo);
}

export async function search(q: string): Promise<Video[]> {
  const r = await call<any>(
    "search",
    { part: "snippet", q, type: "video", maxResults: 50, regionCode: settings().region, safeSearch: "moderate" },
    { units: 100, ttl: 6 * 60 * MIN },
  );
  return videosById((r.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean));
}

export async function channel(id: string): Promise<Channel> {
  const r = await call<any>(
    "channels",
    { part: "snippet,statistics,contentDetails,brandingSettings", id },
    { units: 1, ttl: 6 * 60 * MIN },
  );
  if (!r.items?.length) throw new ApiError("Channel not found", 404);
  return toChannel(r.items[0]);
}

export async function playlistVideos(playlistId: string, auth = false, max = 50): Promise<Video[]> {
  const r = await call<any>(
    "playlistItems",
    { part: "contentDetails", playlistId, maxResults: Math.min(max, 50) },
    { units: 1, ttl: 20 * MIN, auth },
  );
  return videosById((r.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean));
}

export async function channelPlaylists(channelId: string): Promise<Playlist[]> {
  const r = await call<any>(
    "playlists",
    { part: "snippet,contentDetails", channelId, maxResults: 25 },
    { units: 1, ttl: 6 * 60 * MIN },
  );
  return (r.items ?? []).map(toPlaylist).filter((p: Playlist) => (p.count ?? 1) > 0);
}

// ---- signed-in queries ------------------------------------------------------

export async function mySubscriptions(): Promise<Channel[]> {
  const out: Channel[] = [];
  let pageToken: string | undefined;
  do {
    const r = await call<any>(
      "subscriptions",
      { part: "snippet", mine: true, maxResults: 50, order: "relevance", pageToken },
      { units: 1, ttl: 60 * MIN, auth: true },
    );
    out.push(...(r.items ?? []).map(toChannel));
    pageToken = r.nextPageToken;
  } while (pageToken && out.length < 200);
  return out;
}

/**
 * The API has no "subscriptions feed", so it is assembled: each channel's
 * uploads playlist (UC… → UU…) is read and the results merged by date.
 * Costs ~1 unit per channel; capped to the most relevant channels.
 */
export async function subscriptionFeed(channels: Channel[], maxChannels = 30): Promise<Video[]> {
  const ids = await Promise.all(
    channels.slice(0, maxChannels).map(async (c) => {
      const uploads = "UU" + c.id.slice(2);
      try {
        const r = await call<any>(
          "playlistItems",
          { part: "contentDetails", playlistId: uploads, maxResults: 6 },
          { units: 1, ttl: 15 * MIN },
        );
        return (r.items ?? []).map((i: any) => ({
          id: i.contentDetails?.videoId as string,
          at: Date.parse(i.contentDetails?.videoPublishedAt ?? "") || 0,
        }));
      } catch {
        return [];
      }
    }),
  );
  const newest = ids
    .flat()
    .filter((x) => x.id)
    .sort((a, b) => b.at - a.at)
    .slice(0, 50)
    .map((x) => x.id);
  return videosById(newest);
}

export async function likedVideos(): Promise<Video[]> {
  const r = await call<any>(
    "videos",
    { part: "snippet,contentDetails,statistics", myRating: "like", maxResults: 50 },
    { units: 1, ttl: 10 * MIN, auth: true },
  );
  return (r.items ?? []).map(toVideo);
}

export async function myPlaylists(): Promise<Playlist[]> {
  const r = await call<any>(
    "playlists",
    { part: "snippet,contentDetails", mine: true, maxResults: 50 },
    { units: 1, ttl: 10 * MIN, auth: true },
  );
  return (r.items ?? []).map(toPlaylist);
}

export async function myChannel(): Promise<Channel | null> {
  const r = await call<any>("channels", { part: "snippet", mine: true }, { units: 1, ttl: 60 * MIN, auth: true });
  return r.items?.length ? toChannel(r.items[0]) : null;
}

/** Home shelves: chart categories that reliably have a mostPopular chart. */
export const HOME_CATEGORIES: { id?: string; title: string }[] = [
  { title: "Trending now" },
  { id: "10", title: "Music" },
  { id: "20", title: "Gaming" },
  { id: "17", title: "Sports" },
  { id: "28", title: "Science & Technology" },
  { id: "24", title: "Entertainment" },
  { id: "23", title: "Comedy" },
  { id: "25", title: "News" },
  { id: "1", title: "Film & Animation" },
  { id: "2", title: "Cars & Vehicles" },
];
