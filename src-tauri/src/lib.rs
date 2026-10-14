mod gamepad;
mod oauth;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::window::Color;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// The release build serves the UI from http://localhost:<port> rather than the
/// default tauri:// origin: the YouTube IFrame player refuses to start (error 153)
/// without a real http(s) origin + Referer. The port is fixed because localStorage
/// and IndexedDB are keyed by origin; fallbacks only kick in if it's taken.
const PORTS: [u16; 4] = [47801, 47811, 47821, 47831];

const BROWSER_ARGS: &str = concat!(
    // Tauri's defaults (replaced wholesale when this is set).
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection ",
    "--autoplay-policy=no-user-gesture-required ",
    "--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist"
);

fn pick_port() -> u16 {
    PORTS
        .into_iter()
        .find(|p| TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .unwrap_or(PORTS[0])
}

/// Called by the frontend once the first frame is painted, so the window never
/// flashes an empty webview.
#[tauri::command]
fn app_ready(window: WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> bool {
    let _ = window.set_fullscreen(on);
    window.is_fullscreen().unwrap_or(on)
}

#[tauri::command]
fn is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dev = tauri::is_dev();
    let port = pick_port();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build());
    if !dev {
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());
    }

    builder
        .setup(move |app| {
            let (url, origin) = if dev {
                (WebviewUrl::App("index.html".into()), "http://localhost:1420".to_string())
            } else {
                let origin = format!("http://localhost:{port}");
                (WebviewUrl::External(origin.parse().expect("valid localhost url")), origin)
            };

            let window = WebviewWindowBuilder::new(app, "main", url)
                .title("Panorama")
                .inner_size(1600.0, 900.0)
                .min_inner_size(960.0, 540.0)
                .maximized(true)
                .visible(false)
                .background_color(Color(8, 8, 11, 255))
                .additional_browser_args(BROWSER_ARGS)
                .on_navigation(move |u| {
                    // The top-level document must stay on our own origin; anything
                    // else (e.g. a "Watch on YouTube" link) opens in the browser.
                    let same = u.origin().ascii_serialization() == origin;
                    if !same && matches!(u.scheme(), "http" | "https") {
                        let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>);
                    }
                    same
                })
                .build()?;

            let focused = Arc::new(AtomicBool::new(true));
            let f = focused.clone();
            window.on_window_event(move |e| {
                if let WindowEvent::Focused(v) = e {
                    f.store(*v, Ordering::Relaxed);
                }
            });
            gamepad::spawn(app.handle().clone(), focused);

            // Safety net: show the window even if the frontend never reports ready.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            set_fullscreen,
            is_fullscreen,
            quit_app,
            oauth::oauth_sign_in,
            oauth::oauth_refresh,
            oauth::oauth_sign_out,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
