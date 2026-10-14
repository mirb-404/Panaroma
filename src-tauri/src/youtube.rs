//! YouTube account access through the user's own youtube.com session.
//!
//! Sign-in happens on Google's normal login page in a separate window. The
//! session cookies live in the app's WebView2 profile; Rust reads them and calls
//! YouTube's web client API (`/youtubei/v1/*`, the interface youtube.com itself
//! uses) on behalf of the UI. No YouTube page ever gets access to the app's IPC:
//! only Panorama's own UI can call these commands.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const ORIGIN: &str = "https://www.youtube.com";
const SIGN_IN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26next%3Dhttps%253A%252F%252Fwww.youtube.com%252F";
const FALLBACK_CLIENT_VERSION: &str = "2.20251010.01.00";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

/// Endpoints the UI may call; anything else is refused.
const ENDPOINTS: &[&str] = &["browse", "search", "next", "account/account_menu", "guide"];

static CLIENT_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// One HTTP client for the app's lifetime: pooled keep-alive connections,
/// HTTP/2 and compressed responses (YouTube's JSON shrinks ~10×).
fn http() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .user_agent(UA)
                .gzip(true)
                .brotli(true)
                .pool_idle_timeout(std::time::Duration::from_secs(90))
                .build()
                .expect("http client")
        })
        .clone()
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "main window missing".to_string())
}

/// `name=value; …` for youtube.com, including HttpOnly cookies. Must run off the
/// main thread (WebView2 cookie access deadlocks otherwise).
fn session_cookies(app: &AppHandle) -> Result<Vec<(String, String)>, String> {
    let w = main_window(app)?;
    let url = ORIGIN.parse().map_err(|e: url::ParseError| e.to_string())?;
    let cookies = w.cookies_for_url(url).map_err(|e| e.to_string())?;
    Ok(cookies.iter().map(|c| (c.name().to_string(), c.value().to_string())).collect())
}

fn cookie<'a>(cookies: &'a [(String, String)], name: &str) -> Option<&'a str> {
    cookies.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn is_signed_in(cookies: &[(String, String)]) -> bool {
    cookie(cookies, "SAPISID").is_some() || cookie(cookies, "__Secure-3PAPISID").is_some()
}

/// The `Authorization` header youtube.com sends for signed-in API calls.
fn sapisid_hash(cookies: &[(String, String)]) -> Option<String> {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let hash = |sid: &str| {
        let digest = Sha1::digest(format!("{ts} {sid} {ORIGIN}").as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        format!("{ts}_{hex}")
    };
    let mut parts = Vec::new();
    if let Some(s) = cookie(cookies, "SAPISID").or(cookie(cookies, "__Secure-3PAPISID")) {
        parts.push(format!("SAPISIDHASH {}", hash(s)));
    }
    if let Some(s) = cookie(cookies, "__Secure-1PAPISID") {
        parts.push(format!("SAPISID1PHASH {}", hash(s)));
    }
    if let Some(s) = cookie(cookies, "__Secure-3PAPISID") {
        parts.push(format!("SAPISID3PHASH {}", hash(s)));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn cookie_header(cookies: &[(String, String)]) -> String {
    cookies.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
}

/// The web client version YouTube currently expects, read once from its HTML.
async fn client_version(http: &reqwest::Client, cookies: &str) -> String {
    if let Some(v) = CLIENT_VERSION.lock().ok().and_then(|g| g.clone()) {
        return v;
    }
    let found = async {
        let html = http.get(ORIGIN).header("Cookie", cookies).header("User-Agent", UA).send().await.ok()?.text().await.ok()?;
        let key = "\"INNERTUBE_CLIENT_VERSION\":\"";
        let start = html.find(key)? + key.len();
        let end = html[start..].find('"')? + start;
        Some(html[start..end].to_string())
    }
    .await;
    let v = found.unwrap_or_else(|| FALLBACK_CLIENT_VERSION.to_string());
    if let Ok(mut g) = CLIENT_VERSION.lock() {
        *g = Some(v.clone());
    }
    v
}

#[tauri::command]
pub async fn yt_signed_in(app: AppHandle) -> Result<bool, String> {
    let cookies = tauri::async_runtime::spawn_blocking(move || session_cookies(&app))
        .await
        .map_err(|e| e.to_string())??;
    Ok(is_signed_in(&cookies))
}

/// Calls `/youtubei/v1/<endpoint>` as the signed-in user and returns the JSON.
#[tauri::command]
pub async fn yt_api(app: AppHandle, endpoint: String, body: Value, hl: String, gl: String) -> Result<Value, String> {
    if !ENDPOINTS.contains(&endpoint.as_str()) {
        return Err("unsupported endpoint".into());
    }
    let cookies = tauri::async_runtime::spawn_blocking(move || session_cookies(&app))
        .await
        .map_err(|e| e.to_string())??;
    if !is_signed_in(&cookies) {
        return Err("signedOut".into());
    }
    let header = cookie_header(&cookies);
    let http = http();
    let version = client_version(&http, &header).await;

    let mut payload = json!({
        "context": { "client": { "clientName": "WEB", "clientVersion": version, "hl": hl, "gl": gl } }
    });
    if let (Some(p), Value::Object(extra)) = (payload.as_object_mut(), body) {
        p.extend(extra);
    }

    let mut req = http
        .post(format!("{ORIGIN}/youtubei/v1/{endpoint}?prettyPrint=false"))
        .header("Content-Type", "application/json")
        .header("Cookie", header)
        .header("Origin", ORIGIN)
        .header("X-Origin", ORIGIN)
        .header("Referer", format!("{ORIGIN}/"))
        .header("User-Agent", UA)
        .header("X-Youtube-Client-Name", "1")
        .header("X-Youtube-Client-Version", version)
        .header("X-Goog-AuthUser", "0");
    if let Some(auth) = sapisid_hash(&cookies) {
        req = req.header("Authorization", auth);
    }
    let res = req.json(&payload).send().await.map_err(|_| "offline".to_string())?;
    let status = res.status();
    let value: Value = res.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = value.pointer("/error/message").and_then(Value::as_str).unwrap_or("YouTube request failed");
        return Err(format!("{msg} ({status})"));
    }
    Ok(value)
}

/// Opens Google's YouTube sign-in in its own window. Emits `yt-auth` (true) to
/// the main window and closes itself once the session exists.
#[tauri::command]
pub async fn yt_open_sign_in(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("signin") {
        let _ = w.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let window = WebviewWindowBuilder::new(&app, "signin", WebviewUrl::External(SIGN_IN_URL.parse().map_err(|e: url::ParseError| e.to_string())?))
        .title("Sign in to YouTube")
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(560.0, 780.0)
        .center()
        .always_on_top(true)
        .focused(true)
        .on_page_load(move |_w, payload| {
            if payload.event() != PageLoadEvent::Finished || payload.url().host_str() != Some("www.youtube.com") {
                return;
            }
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let check = app.clone();
                let ok = tauri::async_runtime::spawn_blocking(move || session_cookies(&check))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .map(|c| is_signed_in(&c))
                    .unwrap_or(false);
                if ok {
                    let _ = app.emit_to("main", "yt-auth", true);
                    if let Some(w) = app.get_webview_window("signin") {
                        let _ = w.close();
                    }
                    if let Some(m) = app.get_webview_window("main") {
                        let _ = m.set_focus();
                    }
                }
            });
        })
        .build()
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let _ = handle.emit_to("main", "yt-signin-closed", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn yt_close_sign_in(app: AppHandle) {
    if let Some(w) = app.get_webview_window("signin") {
        let _ = w.close();
    }
}

/// Signs out by clearing the app's browsing data (cookies, site storage).
#[tauri::command]
pub async fn yt_sign_out(app: AppHandle) -> Result<(), String> {
    if let Ok(mut g) = CLIENT_VERSION.lock() {
        *g = None;
    }
    let w = main_window(&app)?;
    tauri::async_runtime::spawn_blocking(move || w.clear_all_browsing_data().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Latest uploads for subscribed channels via YouTube's public per-channel RSS
/// feeds (the account's own subscriptions feed isn't available to this client).
/// Returns the raw XML documents; the UI parses them.
#[tauri::command]
pub async fn yt_channel_feeds(ids: Vec<String>) -> Result<Vec<String>, String> {
    let valid = |id: &String| {
        id.len() == 24 && id.starts_with("UC") && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    let http = http();
    let tasks: Vec<_> = ids
        .into_iter()
        .filter(valid)
        .take(60)
        .map(|id| {
            let http = http.clone();
            tauri::async_runtime::spawn(async move {
                let res = http
                    .get(format!("{ORIGIN}/feeds/videos.xml?channel_id={id}"))
                    .header("User-Agent", UA)
                    .send()
                    .await
                    .ok()?;
                res.status().is_success().then_some(())?;
                res.text().await.ok()
            })
        })
        .collect();
    let mut out = Vec::new();
    for t in tasks {
        if let Ok(Some(xml)) = t.await {
            out.push(xml);
        }
    }
    Ok(out)
}

// ---- in-app YouTube view ---------------------------------------------------------
// The ytmdesktop principle as a safety net: when Panorama's own UI can't show
// something (a video whose creator blocks embedding, or a page that can't be
// read), YouTube's own page is shown in a full-window view instead.

/// Pages the view may open (paths on www.youtube.com).
const VIEW_PATHS: &[&str] = &["/watch?v=", "/feed/", "/@", "/channel/", "/playlist?list=", "/results?search_query="];
const CLOSE_HOST: &str = "panorama.invalid";

fn view_allowed_host(host: &str) -> bool {
    host == "youtube.com" || host.ends_with(".youtube.com") || host == "accounts.google.com" || host.ends_with(".google.com")
}

#[tauri::command]
pub async fn yt_open_view(app: AppHandle, path: String) -> Result<(), String> {
    let ok = path == "/"
        || (path.len() < 400 && !path.contains("//") && VIEW_PATHS.iter().any(|p| path.starts_with(p)));
    if !ok {
        return Err("unsupported page".into());
    }
    let url: url::Url = format!("{ORIGIN}{path}").parse().map_err(|e: url::ParseError| e.to_string())?;
    if let Some(w) = app.get_webview_window("ytview") {
        w.navigate(url).map_err(|e| e.to_string())?;
        let _ = w.set_focus();
        return Ok(());
    }
    let fullscreen = app.get_webview_window("main").and_then(|m| m.is_fullscreen().ok()).unwrap_or(false);
    let handle = app.clone();
    let window = WebviewWindowBuilder::new(&app, "ytview", WebviewUrl::External(url))
        .title("YouTube — Panorama")
        .additional_browser_args(crate::BROWSER_ARGS)
        .inner_size(1600.0, 900.0)
        .maximized(true)
        .fullscreen(fullscreen)
        .focused(true)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .initialization_script(include_str!("ytview.js"))
        .on_navigation(move |u| {
            let host = u.host_str().unwrap_or("");
            if host == CLOSE_HOST {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(w) = h.get_webview_window("ytview") {
                        let _ = w.close();
                    }
                    if let Some(m) = h.get_webview_window("main") {
                        let _ = m.set_focus();
                    }
                });
                return false;
            }
            if view_allowed_host(host) {
                return true;
            }
            if matches!(u.scheme(), "http" | "https") {
                let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>);
            }
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let _ = handle.emit_to("main", "ytview-closed", ());
        }
    });
    Ok(())
}
