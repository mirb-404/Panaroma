// Dev-only fixtures (`pnpm dev`, then open /?demo). Responses mimic YouTube's
// web client JSON — classic renderers and the newer lockup view models — so
// the parser in api.ts is exercised too. Never bundled in production.
const IDS = [
  "aqz-KE-bpKQ", "YE7VzlLtp-4", "eRsGyueVLvQ", "WhWc3b3KhnY", "R6MlUcmOul8", "jNQXAC9IVRw",
  "dQw4w9WgXcQ", "9bZkp7q19f0", "kJQP7kiw5Fk", "JGwWNGJdvx8", "RgKAFK5djSk", "OPf0YbXqDm0",
  "fJ9rUzIMcZQ", "hT_nvWreIhg", "CevxZvSJLk8", "60ItHLz5WEA", "e-ORhEE9VVg", "YQHsXMglC9A",
  "pRpeEdMmmQ0", "LsoLEjrDogU",
];
const WORDS = ["Aurora", "Midnight", "Neon", "Velvet", "Orbit", "Cascade", "Ember", "Prism", "Drift", "Summit", "Echo", "Lumen"];
const NOUNS = ["Sessions", "Live in Tokyo", "Full Documentary", "Speedrun", "Review", "Behind the Scenes", "Deep Dive", "Highlights"];
const CHANNELS = ["Blender Studio", "Northern Lights", "Pixel Forge", "The Long Drive", "Orbital Lab", "Quiet Hours"];

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) % 10000) / 10000;
}

const pick = <T,>(r: () => number, a: T[]) => a[Math.floor(r() * a.length)];
const runs = (text: string, browseId?: string) => ({
  runs: [{ text, ...(browseId ? { navigationEndpoint: { browseEndpoint: { browseId } } } : {}) }],
});

function videoRenderer(id: string, r: () => number) {
  const ch = Math.floor(r() * CHANNELS.length);
  return {
    videoRenderer: {
      videoId: id,
      title: runs(`${pick(r, WORDS)} ${pick(r, NOUNS)} — ${pick(r, WORDS)} Edition`),
      ownerText: runs(CHANNELS[ch], `UCdemo${ch}`),
      lengthText: { simpleText: `${2 + Math.floor(r() * 50)}:${String(Math.floor(r() * 60)).padStart(2, "0")}` },
      shortViewCountText: { simpleText: `${(r() * 9 + 1).toFixed(1)}M views` },
      publishedTimeText: { simpleText: `${1 + Math.floor(r() * 11)} days ago` },
      descriptionSnippet: runs("A demo description used to exercise the layout. Second line of detail that should be clamped neatly in the hero area."),
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 }] },
    },
  };
}

/** The newer (2025) item format, for a few items in each feed. */
function lockup(id: string, r: () => number) {
  const ch = Math.floor(r() * CHANNELS.length);
  return {
    lockupViewModel: {
      contentId: id,
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      contentImage: {
        thumbnailViewModel: {
          image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480 }] },
          overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: `${3 + Math.floor(r() * 30)}:0${Math.floor(r() * 9)}` } }] } }],
        },
      },
      metadata: {
        lockupMetadataViewModel: {
          title: { content: `${pick(r, WORDS)} ${pick(r, NOUNS)}` },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: CHANNELS[ch], commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: `UCdemo${ch}` } } } }] } }] },
                { metadataParts: [{ text: { content: `${Math.floor(r() * 900)}K views` } }, { text: { content: `${1 + Math.floor(r() * 4)} weeks ago` } }] },
              ],
            },
          },
        },
      },
    },
  };
}

function feed(seed: string, n = 30) {
  const r = rng(seed);
  const ids = [...IDS, ...IDS].sort(() => r() - 0.5).slice(0, n);
  return ids.map((id, i) => ({ richItemRenderer: { content: i % 5 === 3 ? lockup(id, r) : videoRenderer(id, r) } }));
}

export function demoResponse(endpoint: string, body: Record<string, unknown>): unknown {
  const seed = JSON.stringify(body);
  if (endpoint === "account/account_menu") {
    return { actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: {
      accountName: { simpleText: "Demo Viewer" },
      accountPhoto: { thumbnails: [{ url: "https://i.ytimg.com/vi/aqz-KE-bpKQ/default.jpg", width: 88 }] },
    } } } } } }] };
  }
  if (endpoint === "next") {
    return {
      contents: { twoColumnWatchNextResults: {
        results: { results: { contents: [{ videoSecondaryInfoRenderer: { attributedDescription: { content: "Demo description from the watch page.\nIt has several lines." } } }] } },
        secondaryResults: { secondaryResults: { results: feed(seed, 12).map((x) => x.richItemRenderer.content) } },
      } },
    };
  }
  const browseId = String(body.browseId ?? "");
  if (browseId === "FEsubscriptions") {
    return { contents: CHANNELS.map((title, i) => ({ channelRenderer: {
      channelId: `UCdemo${i}`, title: { simpleText: title },
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${IDS[i]}/hqdefault.jpg`, width: 480 }] },
      videoCountText: { simpleText: `${(i + 1) * 120}K subscribers` },
    } })) };
  }
  if (browseId === "FEplaylist_aggregation") {
    return { contents: IDS.slice(0, 8).map((id, i) => ({ gridPlaylistRenderer: {
      playlistId: `PLdemo${i}`, title: runs(`${WORDS[i]} collection`),
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480 }] },
      videoCountShortText: { simpleText: String(12 + i) },
    } })) };
  }
  if (browseId.startsWith("UC") && !body.params) {
    return {
      metadata: { channelMetadataRenderer: { title: "Blender Studio", description: "Open movies.", avatar: { thumbnails: [{ url: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg", width: 480 }] } } },
      header: { c4TabbedHeaderRenderer: { subscriberCountText: { simpleText: "1.83M subscribers" }, videosCountText: runs("612 videos") } },
    };
  }
  return { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: feed(seed) } } } }] } } };
}
