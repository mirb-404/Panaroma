// Dev-only fixtures (`pnpm dev`, then open /?demo). Responses mimic the raw Data
// API shapes so normalization is exercised too. Never bundled in production.
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

function fakeVideo(id: string, r: () => number) {
  const ch = Math.floor(r() * CHANNELS.length);
  const mins = 2 + Math.floor(r() * 50);
  return {
    id,
    snippet: {
      title: `${WORDS[Math.floor(r() * WORDS.length)]} ${NOUNS[Math.floor(r() * NOUNS.length)]} — ${WORDS[Math.floor(r() * WORDS.length)]} Edition`,
      channelId: `UCdemo${ch}`,
      channelTitle: CHANNELS[ch],
      publishedAt: new Date(Date.now() - r() * 90 * 864e5).toISOString(),
      description: "A demo description used to exercise the layout.\nSecond line of detail that should be clamped neatly in the hero area.",
      liveBroadcastContent: r() < 0.06 ? "live" : "none",
      thumbnails: {
        medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` },
        high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
        maxres: { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` },
      },
    },
    contentDetails: { duration: `PT${mins}M${Math.floor(r() * 59)}S` },
    statistics: { viewCount: String(Math.floor(r() * 5e7)), likeCount: String(Math.floor(r() * 9e5)) },
  };
}

function shuffled(seed: string) {
  const r = rng(seed);
  const ids = [...IDS, ...IDS].sort(() => r() - 0.5);
  return { ids, r };
}

export function demoResponse(path: string, qs: URLSearchParams): unknown {
  const seed = qs.toString();
  if (path === "videos") {
    const { ids, r } = shuffled(seed);
    const list = qs.get("id")?.split(",") ?? ids;
    return { items: list.map((id) => fakeVideo(id, r)) };
  }
  if (path === "search" || path === "playlistItems") {
    const { ids } = shuffled(seed);
    return {
      items: ids.slice(0, Number(qs.get("maxResults") ?? 30)).map((videoId) => ({
        id: { videoId },
        contentDetails: { videoId, videoPublishedAt: new Date().toISOString() },
      })),
    };
  }
  if (path === "channels") {
    return {
      items: [
        {
          id: qs.get("id") ?? "UCdemo0",
          snippet: { title: "Blender Studio", description: "Open movies.", thumbnails: { high: { url: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg" } } },
          statistics: { subscriberCount: "1830000", videoCount: "612" },
          contentDetails: { relatedPlaylists: { uploads: "UUdemo0" } },
          brandingSettings: {},
        },
      ],
    };
  }
  if (path === "playlists") {
    const { ids } = shuffled(seed);
    return {
      items: ids.slice(0, 8).map((id, i) => ({
        id: `PLdemo${i}`,
        snippet: {
          title: `${WORDS[i % WORDS.length]} collection`,
          channelTitle: CHANNELS[i % CHANNELS.length],
          thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
        },
        contentDetails: { itemCount: 12 + i },
      })),
    };
  }
  return { items: [] };
}
