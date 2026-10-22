type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

type TagOf<S extends string> = S extends `${infer T}.${string}` ? T : S;
type ElOf<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement;

/** Tiny hyperscript: h("div.card.big", { onclick }, child, "text"). */
export function h<S extends string>(spec: S, attrs?: Attrs | null, ...children: Child[]): ElOf<S>;
export function h(spec: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "style") el.style.cssText = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function icon(name: keyof typeof ICONS, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  return svg;
}

/** Panorama's own solid glyphs (24×24, one even-odd path each: cut-outs are holes). */
const ICONS = {
  home: "M12 2.5 2 11h3v10h5.5v-6.5h3V21H19V11h3z",
  subs: "M6 2.5h12v2H6zM4 6h16v2H4zM2 9.5h20v12H2zm8 2.8v6.4l5.4-3.2z",
  search: "M10.5 2a8.5 8.5 0 0 1 6.8 13.6l4.8 4.8-1.8 1.8-4.8-4.8A8.5 8.5 0 1 1 10.5 2zm0 2.6a5.9 5.9 0 1 0 0 11.8 5.9 5.9 0 0 0 0-11.8z",
  library: "M3.5 4h3.5v16H3.5zM9 4h3.5v16H9zM14.6 5.3l3.4-.9 3.8 15.2-3.4.9z",
  settings:
    "M10 2h4l.6 2.9 1.6.9 2.8-1 2 3.4-2.2 2a6.6 6.6 0 0 1 0 1.8l2.2 2-2 3.4-2.8-1-1.6.9L14 22h-4l-.6-2.9-1.6-.9-2.8 1-2-3.4 2.2-2a6.6 6.6 0 0 1 0-1.8l-2.2-2 2-3.4 2.8 1 1.6-.9zm2 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z",
  play: "M7.5 4.5v15L20 12z",
  backspace:
    "M8.5 4H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8.5L2 12zm6.1 6.8-1.8-1.8-1.2 1.2 1.8 1.8-1.8 1.8 1.2 1.2 1.8-1.8 1.8 1.8 1.2-1.2-1.8-1.8 1.8-1.8-1.2-1.2z",
  space: "M3 8.5h2.2v4.3h13.6V8.5H21v6.7H3z",
  pad:
    "M7 6h10a5 5 0 0 1 4.9 6l-.9 4.6a2.6 2.6 0 0 1-4.5 1.3l-2.1-2.4H9.6l-2.1 2.4A2.6 2.6 0 0 1 3 16.6L2.1 12A5 5 0 0 1 7 6zm-.8 3v1.6H4.6v1.6h1.6v1.6h1.6v-1.6h1.6v-1.6H7.8V9zM16 8.9a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm2.3 2.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
  keyboard:
    "M4 5.5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM5 8.5v2h2v-2zm3.5 0v2h2v-2zm3.5 0v2h2v-2zm3.5 0v2h2v-2zM5 12v2h2v-2zm12 0v2h2v-2zm-9 3v1.6h8V15zm9.5-6.5v2h1.5v-2z",
  mouse: "M12 2.5a6 6 0 0 1 6 6v7a6 6 0 0 1-12 0v-7a6 6 0 0 1 6-6zM11.1 6v4.5h1.8V6z",
  back: "M15.6 3.4l2.1 2.1-6.5 6.5 6.5 6.5-2.1 2.1L7 12z",
  next: "M8.4 3.4 6.3 5.5l6.5 6.5-6.5 6.5 2.1 2.1L17 12z",
  user: "M12 3.5a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6zM3.5 21a8.5 8.5 0 0 1 17 0z",
  external: "M4 5h7v2.2H6.2v10.6h10.6V13H19v7H4zM13 3h8v8h-2.2V6.8l-7.1 7.1-1.6-1.6 7.1-7.1H13z",
  like: "M2 10h4v11H2zm6 .2 4.6-6.7c.9-.9 2.6-.3 2.6 1.1 0 .3 0 .5-.1.8l-.9 4.1H20a2 2 0 0 1 2 2.2l-1 7.5a2.2 2.2 0 0 1-2.2 1.8H8z",
  comments: "M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
  add: "M10.8 4h2.4v6.8H20v2.4h-6.8V20h-2.4v-6.8H4v-2.4h6.8z",
  check: "M9.2 15.6 4.9 11.3 3.2 13l6 6L21 7.2l-1.7-1.7z",
  subscribe: "M12 2.5A1.5 1.5 0 0 1 13.5 4v.7a6 6 0 0 1 4.5 5.8V16l2 2v1H4v-1l2-2v-5.5a6 6 0 0 1 4.5-5.8V4A1.5 1.5 0 0 1 12 2.5zm-2.2 17.7h4.4a2.2 2.2 0 0 1-4.4 0z",
} as const;

// ---- formatting -----------------------------------------------------------------

export function fmtDuration(sec: number): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** Decodes HTML entities that can appear in titles (&amp; &#39; …). */
const decoder = document.createElement("textarea");
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  decoder.innerHTML = s;
  return decoder.value;
}
