// YouTube data through the signed-in youtube.com session (the same web client
// API youtube.com uses), normalized into the few shapes the UI renders.
//
// Responses are deep, renderer-based JSON whose layout shifts over time, so
// parsing walks the whole tree and recognizes item renderers wherever they are
// instead of depending on exact paths.
import { cacheDelete, cacheEntry, cachePut } from "./cache";
import { invoke } from "./platform";
import { settings } from "./settings";

const MIN = 60_000;

export interface Video {
  kind: "video";
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  description: string;
  durationSec: number;
  /** Display strings exactly as YouTube shows them. */
  durationText: string;
  viewsText: string;
  ageText: string;
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
  subscribersText: string;
  videosText: string;
}

export interface Playlist {
  kind: "playlist";
  id: string;
  title: string;
  channelTitle: string;
  countText: string;
  thumb: string;
  thumbLarge: string;
}

export type Item = Video | Channel | Playlist;

export interface Account {
  name: string;
  avatar: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = "",
  ) {
    super(message);
  }
}

type Json = any;
const isDemo = () => import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

const cacheKey = (endpoint: string, body: Record<string, unknown>) => `yt:${endpoint}:${JSON.stringify(body)}:${settings().region}`;

/** One uncached request to YouTube's web client API. */
async function call(endpoint: string, body: Record<string, unknown>): Promise<Json> {
  try {
    return await invoke<Json>("yt_api", { endpoint, body, hl: navigator.language || "en", gl: settings().region });
  } catch (e) {
    const msg = String(e);
    if (msg === "signedOut") throw new ApiError("Sign in with Google to start watching", 401, "signedOut");
    if (msg === "offline") throw new ApiError("You're offline", 0, "offline");
    throw new ApiError(msg, 500);
  }
}

/**
 * A cached request. `fresh`: always ask YouTube (feeds that should change on
 * every launch), falling back to the cached copy only when offline.
 */
async function yt(endpoint: string, body: Record<string, unknown>, ttl: number, fresh = false): Promise<Json> {
  const key = cacheKey(endpoint, body);
  if (isDemo()) {
    const { demoResponse } = await import("./demo");
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
    return demoResponse(endpoint, body);
  }
  const fetchFresh = async (): Promise<Json> => {
    const res = await call(endpoint, body);
    cachePut(key, res);
    return res;
  };
  if (fresh)
    return fetchFresh().catch(async (e) => {
      const hit = e instanceof ApiError && e.reason === "offline" ? await cacheEntry<Json>(key) : undefined;
      if (hit) return hit.value;
      throw e;
    });
  const hit = await cacheEntry<Json>(key);
  if (hit && hit.age < ttl) return hit.value;
  // Stale-while-revalidate: show what we had instantly (up to a day old) and
  // refresh in the background for next time. Continuation requests carry
  // short-lived tokens, so they're always fetched fresh.
  if (hit && hit.age < STALE_MAX && !("continuation" in body)) {
    fetchFresh().catch(() => {});
    return hit.value;
  }
  return fetchFresh();
}

const STALE_MAX = 24 * 60 * MIN;

// ---- tree helpers ---------------------------------------------------------------

/** Text from any of YouTube's text shapes: simpleText, runs, content. */
const tx = (x: Json): string =>
  !x ? "" : typeof x === "string" ? x : (x.simpleText ?? x.content ?? (Array.isArray(x.runs) ? x.runs.map((r: Json) => r.text).join("") : ""));

/** Every value in the tree for which `pick` returns something, in document order. */
function findAll<T>(node: Json, pick: (n: Json) => T | undefined, out: T[] = [], depth = 0): T[] {
  if (!node || typeof node !== "object" || depth > 40) return out;
  const hit = pick(node);
  if (hit !== undefined) out.push(hit);
  else for (const v of Array.isArray(node) ? node : Object.values(node)) findAll(v, pick, out, depth + 1);
  return out;
}

/** First value in the tree for which `pick` returns something. */
function find<T>(node: Json, pick: (n: Json) => T | undefined, depth = 0): T | undefined {
  if (!node || typeof node !== "object" || depth > 40) return undefined;
  const hit = pick(node);
  if (hit !== undefined) return hit;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const r = find(v, pick, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

const https = (u: string) => (u?.startsWith("//") ? `https:${u}` : u ?? "");
const largest = (list: Json[] | undefined): string =>
  https([...(list ?? [])].sort((a, b) => (b?.width ?? 0) - (a?.width ?? 0))[0]?.url ?? "");

function durationToSec(text: string): number {
  if (!/^\d+(:\d+)+$/.test(text)) return 0;
  return text.split(":").reduce((s, p) => s * 60 + +p, 0);
}

const channelIdIn = (n: Json): string =>
  find(n, (x) => (typeof x?.browseId === "string" && x.browseId.startsWith("UC") ? x.browseId : undefined)) ?? "";

function video(v: Partial<Video> & { id: string }): Video {
  const durationText = v.durationText ?? "";
  return {
    kind: "video",
    title: "",
    channelId: "",
    channelTitle: "",
    description: "",
    viewsText: "",
    ageText: "",
    live: false,
    ...v,
    durationText,
    durationSec: durationToSec(durationText),
    thumb: v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    thumbLarge: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
  };
}

// ---- renderer parsers --------------------------------------------------------------

function fromVideoRenderer(r: Json): Video | null {
  if (!r?.videoId) return null;
  const owner = r.ownerText ?? r.longBylineText ?? r.shortBylineText;
  const overlayTime = find(r.thumbnailOverlays, (x) => x?.thumbnailOverlayTimeStatusRenderer?.text);
  const durationText = tx(r.lengthText) || tx(overlayTime);
  const live =
    JSON.stringify(r.badges ?? []).includes("LIVE") ||
    JSON.stringify(r.thumbnailOverlays ?? []).includes('"LIVE"') ||
    durationText.toUpperCase() === "LIVE";
  const info = tx(r.videoInfo); // playlist rows: "1.2M views • 3 days ago"
  const [infoViews, infoAge] = info.split(" • ");
  return video({
    id: r.videoId,
    title: tx(r.title),
    channelId: channelIdIn(owner) || channelIdIn(r.channelThumbnailSupportedRenderers),
    channelTitle: tx(owner),
    durationText: live ? "" : durationText,
    viewsText: tx(r.shortViewCountText) || tx(r.viewCountText) || infoViews || "",
    ageText: tx(r.publishedTimeText) || infoAge || "",
    description: tx(r.descriptionSnippet) || tx(r.detailedMetadataSnippets?.[0]?.snippetText),
    live,
    thumb: largest(r.thumbnail?.thumbnails),
  });
}

function badgesOf(img: Json): string[] {
  const out: string[] = [];
  find(img?.overlays, (x) => {
    if (x?.thumbnailBadgeViewModel?.text) out.push(x.thumbnailBadgeViewModel.text);
    return undefined;
  });
  return out;
}

function fromLockup(l: Json): Item | null {
  const meta = l?.metadata?.lockupMetadataViewModel;
  if (!l?.contentId || !meta) return null;
  const rows: string[][] = (meta.metadata?.contentMetadataViewModel?.metadataRows ?? []).map((row: Json) =>
    (row.metadataParts ?? []).map((p: Json) => tx(p.text)).filter(Boolean),
  );
  const img = l.contentImage?.thumbnailViewModel ?? l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel;
  const thumb = largest(img?.image?.sources);
  const badges = badgesOf(img);
  const title = tx(meta.title);
  const type: string = l.contentType ?? "";
  if (type.includes("PLAYLIST") || type.includes("PODCAST") || /^(PL|RD|OL|UU)/.test(l.contentId)) {
    return {
      kind: "playlist",
      id: l.contentId,
      title,
      channelTitle: rows[0]?.[0] ?? "",
      countText: badges.find((b) => /\d/.test(b)) ?? badges[0] ?? "",
      thumb,
      thumbLarge: thumb,
    };
  }
  if (!type.includes("VIDEO") && type) return null;
  const durationText = badges.find((b) => /^\d+(:\d+)+$/.test(b)) ?? "";
  const live = badges.some((b) => /^live$/i.test(b));
  const flat = rows.flat();
  // On a channel's own page the first line is already "views · age" (no name).
  const isStat = (t: string) => /view|watching|ago|streamed|premiered|scheduled/i.test(t);
  const first = rows[0]?.[0] ?? "";
  return video({
    id: l.contentId,
    title,
    channelId: channelIdIn(meta) || channelIdIn(l.metadata),
    channelTitle: isStat(first) ? "" : first,
    durationText,
    viewsText: flat.find((t) => /view|watching/i.test(t)) ?? "",
    ageText: flat.find((t) => /ago|streamed|premiered/i.test(t)) ?? "",
    live,
    thumb,
  });
}

function fromChannel(r: Json): Channel | null {
  if (!r?.channelId) return null;
  const texts = [tx(r.subscriberCountText), tx(r.videoCountText)];
  return {
    kind: "channel",
    id: r.channelId,
    title: tx(r.title),
    description: tx(r.descriptionSnippet),
    avatar: largest(r.thumbnail?.thumbnails),
    subscribersText: texts.find((t) => /subscriber/i.test(t)) ?? "",
    videosText: texts.find((t) => /video/i.test(t)) ?? "",
  };
}

function fromPlaylist(r: Json): Playlist | null {
  if (!r?.playlistId) return null;
  const thumb = largest(r.thumbnails?.[0]?.thumbnails ?? r.thumbnail?.thumbnails ?? r.thumbnailRenderer?.playlistVideoThumbnailRenderer?.thumbnail?.thumbnails);
  const count = r.videoCount ? `${r.videoCount} videos` : tx(r.videoCountShortText) || tx(r.videoCountText);
  return { kind: "playlist", id: r.playlistId, title: tx(r.title), channelTitle: tx(r.shortBylineText ?? r.longBylineText), countText: count, thumb, thumbLarge: thumb };
}

const PARSERS: Record<string, (r: Json) => Item | null> = {
  videoRenderer: fromVideoRenderer,
  gridVideoRenderer: fromVideoRenderer,
  compactVideoRenderer: fromVideoRenderer,
  playlistVideoRenderer: fromVideoRenderer,
  playlistPanelVideoRenderer: fromVideoRenderer,
  lockupViewModel: fromLockup,
  channelRenderer: fromChannel,
  gridChannelRenderer: fromChannel,
  playlistRenderer: fromPlaylist,
  gridPlaylistRenderer: fromPlaylist,
};

/** Never descend into these (ads, Shorts shelves, menus). */
const SKIP = new Set([
  "adSlotRenderer", "reelShelfRenderer", "reelItemRenderer", "shortsLockupViewModel",
  "menu", "menuRenderer", "header", "topbar", "sidebar", "frameworkUpdates", "responseContext",
]);

function collect(node: Json, out: Item[] = [], depth = 0): Item[] {
  if (!node || typeof node !== "object" || depth > 60) return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (SKIP.has(k)) continue;
    const parse = PARSERS[k];
    if (parse) {
      const item = parse(v);
      if (item) out.push(item);
    } else collect(v, out, depth + 1);
  }
  return out;
}

/**
 * Last-resort extractor for when YouTube renames its item renderers: any object
 * carrying an 11-character video id plus some title-ish text becomes a basic
 * video card. Rows degrade to simpler cards instead of going empty.
 */
function genericVideos(node: Json): Video[] {
  const out: Video[] = [];
  const walk = (n: Json, depth: number) => {
    if (!n || typeof n !== "object" || depth > 60) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    const id = [n.videoId, n.contentId].find((x) => typeof x === "string" && /^[\w-]{11}$/.test(x));
    if (id) {
      const title =
        tx(n.title) || tx(n.headline) || tx(n.metadata?.lockupMetadataViewModel?.title) || n.accessibility?.accessibilityData?.label || "";
      out.push(video({ id, title, channelTitle: tx(n.ownerText ?? n.shortBylineText ?? n.longBylineText), thumb: largest(n.thumbnail?.thumbnails) }));
      return;
    }
    for (const [k, v] of Object.entries(n)) if (!SKIP.has(k)) walk(v, depth + 1);
  };
  walk(node, 0);
  return dedupe(out);
}

/** Items from a response: precise parsers first, the generic extractor if they find nothing. */
function items(node: Json): Item[] {
  const found = collect(node);
  return found.length ? found : genericVideos(node);
}

interface Shelf {
  title: string;
  items: Item[];
}

/** Items outside shelves, plus titled shelves (for Home's rows). */
function collectWithShelves(node: Json): { loose: Item[]; shelves: Shelf[] } {
  const loose: Item[] = [];
  const shelves: Shelf[] = [];
  const walk = (n: Json, depth: number) => {
    if (!n || typeof n !== "object" || depth > 60) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    for (const [k, v] of Object.entries(n)) {
      if (SKIP.has(k)) continue;
      if (k === "richShelfRenderer" || k === "shelfRenderer") {
        const items = collect((v as Json).contents ?? (v as Json).content);
        const title = tx((v as Json).title);
        if (items.length && title) shelves.push({ title, items });
        continue;
      }
      const parse = PARSERS[k];
      if (parse) {
        const item = parse(v);
        if (item) loose.push(item);
      } else walk(v, depth + 1);
    }
  };
  walk(node, 0);
  return { loose, shelves };
}

const continuationOf = (r: Json): string | undefined =>
  find(r, (x) => x?.continuationItemRenderer && (find(x.continuationItemRenderer, (y) => y?.continuationCommand?.token) as string | undefined)) ??
  find(r, (x) => x?.nextContinuationData?.continuation);

function dedupe<T extends Item>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.kind + i.id) && seen.add(i.kind + i.id));
}

/** Fetches a feed plus `pages - 1` continuation pages. */
async function paged(endpoint: "browse" | "search", body: Record<string, unknown>, pages: number, ttl: number): Promise<Json[]> {
  const out = [await yt(endpoint, body, ttl)];
  let token = continuationOf(out[0]);
  while (token && out.length < pages) {
    // A failed extra page (e.g. an expired token) just means a shorter list.
    const next = await yt(endpoint, { continuation: token }, ttl).catch(() => null);
    if (!next) break;
    out.push(next);
    token = continuationOf(next);
  }
  return out;
}

const videosOnly = (items: Item[]) => items.filter((i): i is Video => i.kind === "video");

// ---- public queries ---------------------------------------------------------------

let homePages: Promise<Json | null>[] | null = null;
let homeAt = 0;

/**
 * The signed-in Home feed, page by page. Each page is its own promise so the
 * first row renders as soon as page 1 arrives instead of waiting for all three.
 * Always fetched fresh (then kept in memory for 10 minutes): serving the
 * cached feed from the last run made every launch open on the same videos.
 */
export function homeFeedPage(n: 0 | 1 | 2): Promise<Item[]> {
  if (!homePages || Date.now() - homeAt > 10 * MIN) {
    homeAt = Date.now();
    const first = yt("browse", { browseId: "FEwhat_to_watch" }, 0, true);
    const next = (prev: Promise<Json | null>) =>
      prev.then((r) => {
        const token = r && continuationOf(r);
        return token ? yt("browse", { continuation: token }, 10 * MIN).catch(() => null) : null;
      });
    const second = next(first);
    homePages = [first, second, next(second)];
    first.catch(() => (homePages = null));
  }
  const seen = new Set<string>();
  return Promise.all(homePages.slice(0, n + 1)).then((pages) => {
    // Items already shown on earlier pages are skipped.
    pages.slice(0, n).forEach((p) => p && homeItems(p).forEach((i) => seen.add(i.id)));
    const page = pages[n];
    return page ? homeItems(page).filter((i) => !seen.has(i.id)) : [];
  });
}

function homeItems(page: Json): Item[] {
  const { loose, shelves } = collectWithShelves(page);
  const found = dedupe([...loose, ...shelves.flatMap((s) => s.items)]);
  return found.length ? found : genericVideos(page);
}

/** Subscribed channels, in the order YouTube lists them. */
export async function subscribedChannels(): Promise<Channel[]> {
  const r = await yt("browse", { browseId: "FEsubscriptions" }, 60 * MIN);
  return dedupe(items(r).filter((i): i is Channel => i.kind === "channel"));
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(iso: string): string {
  const sec = (Date.parse(iso) - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [u, n] of units) if (Math.abs(sec) >= n) return rtf.format(Math.round(sec / n), u);
  return "just now";
}

/**
 * Newest uploads across subscriptions. This client gets the channel list (not
 * the video feed) from the account's subscriptions page, so the videos come
 * from each channel's public RSS feed, merged newest first.
 */
export async function subscriptionFeed(): Promise<Video[]> {
  if (isDemo()) return videosOnly(items(await yt("browse", { browseId: "FEdemo" }, 0)));
  const channels = await subscribedChannels();
  const xmls = await invoke<string[]>("yt_channel_feeds", { ids: channels.slice(0, 60).map((c) => c.id) });
  const YT = "http://www.youtube.com/xml/schemas/2015";
  const MEDIA = "http://search.yahoo.com/mrss/";
  const entries: { at: number; video: Video }[] = [];
  for (const xml of xmls) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    for (const e of Array.from(doc.getElementsByTagName("entry"))) {
      const id = e.getElementsByTagNameNS(YT, "videoId")[0]?.textContent ?? "";
      const published = e.getElementsByTagName("published")[0]?.textContent ?? "";
      if (!id || !published) continue;
      const views = Number(e.getElementsByTagNameNS(MEDIA, "statistics")[0]?.getAttribute("views") ?? NaN);
      entries.push({
        at: Date.parse(published),
        video: video({
          id,
          title: e.getElementsByTagName("title")[0]?.textContent ?? "",
          channelId: e.getElementsByTagNameNS(YT, "channelId")[0]?.textContent ?? "",
          channelTitle: e.getElementsByTagName("author")[0]?.getElementsByTagName("name")[0]?.textContent ?? "",
          description: e.getElementsByTagNameNS(MEDIA, "description")[0]?.textContent ?? "",
          viewsText: Number.isFinite(views) ? `${compact.format(views)} views` : "",
          ageText: ago(published),
        }),
      });
    }
  }
  return entries.sort((x, y) => y.at - x.at).slice(0, 60).map((x) => x.video);
}

export async function history(): Promise<Video[]> {
  return dedupe(videosOnly(items(await yt("browse", { browseId: "FEhistory" }, 5 * MIN))));
}

export async function playlistVideos(playlistId: string): Promise<Video[]> {
  const pages = await paged("browse", { browseId: `VL${playlistId}` }, 3, 10 * MIN);
  return dedupe(videosOnly(pages.flatMap((p) => items(p))));
}

export const watchLater = () => playlistVideos("WL");
export const likedVideos = () => playlistVideos("LL");

export async function myPlaylists(): Promise<Playlist[]> {
  const pick = (r: Json) => items(r).filter((i): i is Playlist => i.kind === "playlist");
  const found = pick(await yt("browse", { browseId: "FEplaylist_aggregation" }, 10 * MIN).catch(() => null));
  return found.length ? dedupe(found) : dedupe(pick(await yt("browse", { browseId: "FElibrary" }, 10 * MIN)));
}

export async function search(query: string): Promise<Item[]> {
  const pages = await paged("search", { query }, 2, 60 * MIN);
  return dedupe(pages.flatMap((p) => items(p)));
}

export async function channel(id: string): Promise<Channel> {
  const r = await yt("browse", { browseId: id }, 60 * MIN);
  const meta = r?.metadata?.channelMetadataRenderer ?? {};
  const view = find(r?.header, (x) => x?.pageHeaderViewModel);
  const legacy = r?.header?.c4TabbedHeaderRenderer;
  const parts: string[] = [];
  find(view?.metadata, (x) => {
    if (x?.metadataParts) x.metadataParts.forEach((p: Json) => parts.push(tx(p.text)));
    return undefined;
  });
  const avatar =
    largest(find(view?.image, (x) => x?.sources)) || largest(legacy?.avatar?.thumbnails) || largest(meta.avatar?.thumbnails);
  const banner = largest(find(view?.banner, (x) => x?.sources)) || largest(legacy?.banner?.thumbnails);
  return {
    kind: "channel",
    id,
    title: meta.title ?? tx(legacy?.title) ?? tx(view?.title),
    description: meta.description ?? "",
    avatar,
    banner: banner ? banner.replace(/=w\d+.*$/, "=w2560") : undefined,
    subscribersText: parts.find((t) => /subscriber/i.test(t)) ?? tx(legacy?.subscriberCountText),
    videosText: parts.find((t) => /video/i.test(t)) ?? tx(legacy?.videosCountText),
  };
}

/** Channel tabs by their (stable, public) browse params. */
const VIDEOS_TAB = "EgZ2aWRlb3PyBgQKAjoA";
const PLAYLISTS_TAB = "EglwbGF5bGlzdHPyBgQKAkIA";

export async function channelVideos(id: string): Promise<Video[]> {
  const pages = await paged("browse", { browseId: id, params: VIDEOS_TAB }, 2, 30 * MIN);
  return dedupe(videosOnly(pages.flatMap((p) => items(p))));
}

export async function channelPlaylists(id: string): Promise<Playlist[]> {
  const r = await yt("browse", { browseId: id, params: PLAYLISTS_TAB }, 60 * MIN);
  return dedupe(items(r).filter((i): i is Playlist => i.kind === "playlist"));
}

export interface WatchDetails {
  description: string;
  related: Video[];
  liked: boolean;
  /** null when YouTube didn't say (e.g. the viewer's own channel). */
  subscribed: boolean | null;
  subscribeParams?: string;
  unsubscribeParams?: string;
  commentsText: string;
  /** Opens the comments; absent when they're turned off. */
  commentsToken?: string;
  /** Streaming right now (not a finished stream's replay). */
  live: boolean;
  /** "1,234 watching now" while live, else YouTube's view count. */
  viewersText: string;
  /** Live chat, or a finished stream's chat replay; absent when there's none. */
  chat?: ChatSource;
}

/** Description, related videos, the viewer's like/subscribe state and the comments entry. */
export async function watchNext(videoId: string): Promise<WatchDetails> {
  const r = await yt("next", { videoId }, 30 * MIN);
  const secondary = find(r, (x) => x?.videoSecondaryInfoRenderer);
  const description = tx(secondary?.attributedDescription) || tx(secondary?.description);
  const results = find(r, (x) => x?.secondaryResults) ?? {};
  const sub = find(r, (x) => (typeof x?.subscribeButtonRenderer?.subscribed === "boolean" ? x.subscribeButtonRenderer : undefined));
  const subscribed: boolean | null =
    sub?.subscribed ??
    find(r?.frameworkUpdates, (x) => (typeof x?.subscriptionStateEntity?.subscribed === "boolean" ? x.subscriptionStateEntity.subscribed : undefined)) ??
    null;
  const commentSection = find(r, (x) => (x?.itemSectionRenderer?.sectionIdentifier === "comment-item-section" ? x.itemSectionRenderer : undefined));
  const views = find(r, (x) => x?.videoViewCountRenderer);
  const chat = find(r, (x) => x?.liveChatRenderer);
  const chatToken: string | undefined = chat && find(chat.continuations, (x) => x?.continuation);
  return {
    live: !!views?.isLive,
    viewersText: tx(views?.viewCount) || tx(views?.shortViewCount),
    chat: chatToken ? { token: chatToken, replay: !!chat.isReplay } : undefined,
    description,
    related: dedupe(videosOnly(items(results))).filter((v) => v.id !== videoId),
    liked: find(r, (x) => x?.likeStatusEntity?.likeStatus) === "LIKE",
    subscribed,
    subscribeParams: find(r, (x) => x?.subscribeEndpoint?.params),
    unsubscribeParams: find(r, (x) => x?.unsubscribeEndpoint?.params),
    commentsText: tx(find(r, (x) => x?.commentsEntryPointHeaderRenderer?.commentCount)),
    commentsToken: commentSection && find(commentSection, (x) => x?.continuationCommand?.token),
  };
}

// ---- comments -----------------------------------------------------------------------

export interface Comment {
  id: string;
  author: string;
  avatar: string;
  text: string;
  ageText: string;
  likesText: string;
  repliesText: string;
  /** Loads this comment's replies (through `comments`); absent when it has none. */
  repliesToken?: string;
}

/**
 * One page of comments, and the token for the next. Also takes a comment's
 * `repliesToken`: a page of replies has the same shape, without threads.
 */
export async function comments(token: string): Promise<{ comments: Comment[]; next?: string }> {
  const r = await yt("next", { continuation: token }, 10 * MIN);
  const list: Json[] = (r?.onResponseReceivedEndpoints ?? []).flatMap(
    (a: Json) => (a?.reloadContinuationItemsCommand ?? a?.appendContinuationItemsAction)?.continuationItems ?? [],
  );
  // Current responses keep each comment's content in an entity keyed by the
  // comment's commentKey; older ones inline a commentRenderer.
  const entities = new Map<string, Json>();
  findAll(r?.frameworkUpdates, (x) => x?.commentEntityPayload).forEach((p: Json) => entities.set(p.key, p));
  const out: Comment[] = [];
  for (const item of list) {
    // Top-level comments come as threads (with their replies' token); replies bare.
    const thread = item?.commentThreadRenderer;
    const repliesToken: string | undefined = thread?.replies && find(thread.replies, (x) => x?.continuationCommand?.token);
    const e = entities.get((thread?.commentViewModel ?? item)?.commentViewModel?.commentKey);
    if (e) {
      const replies = e.toolbar?.replyCount;
      out.push({
        id: e.properties?.commentId ?? e.key,
        author: e.author?.displayName ?? "",
        avatar: https(e.author?.avatarThumbnailUrl ?? ""),
        text: tx(e.properties?.content),
        ageText: e.properties?.publishedTime ?? "",
        likesText: (e.toolbar?.likeCountNotliked ?? "").trim(),
        repliesText: replies && replies !== "0" ? `${replies} ${replies === "1" ? "reply" : "replies"}` : "",
        repliesToken,
      });
      continue;
    }
    const c = thread?.comment?.commentRenderer ?? item?.commentRenderer;
    if (c)
      out.push({
        id: c.commentId,
        author: tx(c.authorText),
        avatar: largest(c.authorThumbnail?.thumbnails),
        text: tx(c.contentText),
        ageText: tx(c.publishedTimeText),
        likesText: tx(c.voteCount),
        repliesText: c.replyCount ? `${c.replyCount} ${c.replyCount === 1 ? "reply" : "replies"}` : "",
        repliesToken,
      });
  }
  // The page's own continuation is the last item of the list (replies carry
  // their own, nested deeper).
  const next = list
    .map((x) => x?.continuationItemRenderer)
    .filter(Boolean)
    .map((c) => find(c, (y) => y?.continuationCommand?.token) as string | undefined)
    .pop();
  return { comments: out.filter((c) => c.text), next };
}

// ---- live chat ---------------------------------------------------------------------

export interface ChatSource {
  token: string;
  /** A finished stream: messages replay in step with the video. */
  replay: boolean;
}

export interface ChatMessage {
  id: string;
  author: string;
  avatar: string;
  text: string;
  /** Super Chats and Super Stickers: "$5.00". */
  amount: string;
  kind: "text" | "paid" | "member" | "system";
  /** Replay only: when in the video it was sent. */
  offsetMs: number;
}

export interface ChatPage {
  messages: ChatMessage[];
  /** Ids of messages a moderator removed. */
  deleted: string[];
  pinned?: ChatMessage;
  next?: string;
  /** Replay only: restarts the replay at a new position. */
  seek?: string;
  /** How long YouTube asks to wait before the next request. */
  waitMs: number;
  /** Sends a message as the viewer; absent when they can't chat. */
  sendParams?: string;
}

/** Emoji come as their own runs: standard ones as the character, custom ones as :shortcut:. */
const chatText = (x: Json): string =>
  Array.isArray(x?.runs)
    ? x.runs.map((r: Json) => r.text ?? (r.emoji?.isCustomEmoji ? (r.emoji.shortcuts?.[0] ?? "") : (r.emoji?.emojiId ?? ""))).join("")
    : tx(x);

function chatMessage(item: Json, offsetMs: number): ChatMessage | null {
  const r =
    item?.liveChatTextMessageRenderer ??
    item?.liveChatPaidMessageRenderer ??
    item?.liveChatPaidStickerRenderer ??
    item?.liveChatMembershipItemRenderer ??
    item?.liveChatViewerEngagementMessageRenderer;
  if (!r?.id) return null;
  const kind: ChatMessage["kind"] = item.liveChatTextMessageRenderer
    ? "text"
    : item.liveChatMembershipItemRenderer
      ? "member"
      : item.liveChatViewerEngagementMessageRenderer
        ? "system"
        : "paid";
  const text = chatText(r.message) || (kind === "member" ? chatText(r.headerSubtext) : "");
  if (!text && kind !== "paid") return null;
  return {
    id: r.id,
    author: tx(r.authorName),
    avatar: largest(r.authorPhoto?.thumbnails),
    text,
    amount: tx(r.purchaseAmountText),
    kind,
    offsetMs,
  };
}

/**
 * One poll of a live chat, or the next stretch of a chat replay. Replays take
 * the player's position, so they return the messages from there on.
 */
export async function liveChat(source: ChatSource, token: string, positionMs = 0): Promise<ChatPage> {
  const body: Record<string, unknown> = { continuation: token };
  if (source.replay) body.currentPlayerState = { playerOffsetMs: String(Math.max(0, Math.floor(positionMs))) };
  const r = await call(source.replay ? "live_chat/get_live_chat_replay" : "live_chat/get_live_chat", body);
  const c = r?.continuationContents?.liveChatContinuation ?? {};
  const page: ChatPage = { messages: [], deleted: [], waitMs: 5000 };
  const add = (a: Json, offsetMs: number) => {
    const m = chatMessage(a?.addChatItemAction?.item, offsetMs);
    if (m) page.messages.push(m);
    const gone = a?.markChatItemAsDeletedAction?.targetItemId ?? a?.markChatItemsByAuthorAsDeletedAction?.targetItemId;
    if (gone) page.deleted.push(gone);
    const banner = a?.addBannerToLiveChatCommand?.bannerRenderer?.liveChatBannerRenderer?.contents;
    const pinned = banner && chatMessage(banner, offsetMs);
    if (pinned) page.pinned = pinned;
  };
  for (const a of c.actions ?? []) {
    const replay = a?.replayChatItemAction;
    if (replay) for (const inner of replay.actions ?? []) add(inner, Number(replay.videoOffsetTimeMsec) || 0);
    else add(a, 0);
  }
  for (const k of c.continuations ?? []) {
    if (k.playerSeekContinuationData) page.seek = k.playerSeekContinuationData.continuation;
    else {
      const d = k.invalidationContinuationData ?? k.timedContinuationData ?? k.liveChatReplayContinuationData ?? k.reloadContinuationData;
      if (d?.continuation) page.next = d.continuation;
      if (d?.timeoutMs) page.waitMs = Number(d.timeoutMs);
    }
  }
  page.sendParams = find(c.actionPanel, (x) => x?.sendLiveChatMessageEndpoint?.params);
  return page;
}

/** Posts a message to a live chat as the signed-in viewer. */
export async function sendChat(params: string, text: string): Promise<void> {
  await call("live_chat/send_message", {
    params,
    clientMessageId: `pn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    richMessage: { textSegments: [{ text }] },
  });
}

// ---- account actions (save, like, subscribe) ---------------------------------------
// Never cached; each drops the cached pages it makes stale.

export interface SaveTarget {
  playlistId: string;
  title: string;
  saved: boolean;
}

/** The viewer's playlists (Watch later first) and whether each holds the video. */
export async function saveTargets(videoId: string): Promise<SaveTarget[]> {
  const r = await call("playlist/get_add_to_playlist", { videoIds: [videoId], excludeWatchLater: false });
  const list: SaveTarget[] = findAll(r, (x) => x?.playlistAddToOptionRenderer)
    .filter((o: Json) => o.playlistId)
    .map((o: Json) => ({ playlistId: o.playlistId, title: tx(o.title), saved: o.containsSelectedVideos === "ALL" }));
  if (!list.some((t) => t.playlistId === "WL")) list.unshift({ playlistId: "WL", title: "Watch later", saved: false });
  return list.sort((a, b) => +(b.playlistId === "WL") - +(a.playlistId === "WL"));
}

const dropPlaylist = (playlistId: string) => cacheDelete(cacheKey("browse", { browseId: `VL${playlistId}` }));
const dropWatch = (videoId: string) => cacheDelete(cacheKey("next", { videoId }));

export async function setSaved(videoId: string, playlistId: string, on: boolean): Promise<void> {
  const action = on
    ? { action: "ACTION_ADD_VIDEO", addedVideoId: videoId }
    : { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: videoId };
  await call("browse/edit_playlist", { playlistId, actions: [action] });
  await dropPlaylist(playlistId);
}

export async function setLiked(videoId: string, on: boolean): Promise<void> {
  await call(on ? "like/like" : "like/removelike", { target: { videoId } });
  await Promise.all([dropPlaylist("LL"), dropWatch(videoId)]);
}

export async function setSubscribed(channelId: string, on: boolean, videoId: string, params?: string): Promise<void> {
  await call(on ? "subscription/subscribe" : "subscription/unsubscribe", { channelIds: [channelId], ...(params ? { params } : {}) });
  await Promise.all([cacheDelete(cacheKey("browse", { browseId: "FEsubscriptions" })), dropWatch(videoId)]);
}

export async function account(): Promise<Account | null> {
  const r = await yt("account/account_menu", {}, 60 * MIN);
  const h = find(r, (x) => x?.activeAccountHeaderRenderer);
  return h ? { name: tx(h.accountName), avatar: largest(h.accountPhoto?.thumbnails) } : null;
}
