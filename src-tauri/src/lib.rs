mod gamepad;
mod media;
mod youtube;

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

/// WebView2 options for every window. They must be identical across windows:
/// all windows share one browser profile, and WebView2 refuses to create a
/// webview whose options differ from the profile's running instance.
pub(crate) const BROWSER_ARGS: &str = concat!(
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

/// Gives a window the large (taskbar / Alt+Tab) icon from the exe's resources.
/// Tauri only sets the small icon and leaves the window class without one, so
/// once Windows re-reads the window's icon (after fullscreen toggles, explorer
/// refreshes, …) the taskbar button went blank.
pub(crate) fn set_taskbar_icon(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetSystemMetrics, LoadImageW, SendMessageW, SetClassLongPtrW, GCLP_HICON, ICON_BIG, IMAGE_ICON, LR_SHARED,
            SM_CXICON, SM_CYICON, WM_SETICON,
        };
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as _;
        // SAFETY: plain Win32 calls on a live window handle. LR_SHARED icons are
        // owned by the system and stay valid for the process's lifetime.
        unsafe {
            let id = tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16;
            let icon = LoadImageW(GetModuleHandleW(std::ptr::null()), id, IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), LR_SHARED);
            if icon.is_null() {
                return;
            }
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
            SetClassLongPtrW(hwnd, GCLP_HICON, icon as isize);
        }
    }
    #[cfg(not(windows))]
    let _ = window;
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
        .plugin(tauri_plugin_dialog::init())
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
                // Runs inside the YouTube player iframes (see ytembed.js).
                .initialization_script_for_all_frames(include_str!("ytembed.js"))
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
            set_taskbar_icon(&window);

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
            gamepad::pad_connected,
            youtube::yt_signed_in,
            youtube::yt_api,
            youtube::yt_open_sign_in,
            youtube::yt_close_sign_in,
            youtube::yt_sign_out,
            youtube::yt_channel_feeds,
            youtube::yt_open_view,
            media::steam_sounds_available,
            media::read_steam_sound,
            media::import_startup_video,
            media::clear_startup_video,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
