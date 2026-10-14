fn main() {
    // App commands must be declared so they can be granted to the window: the UI
    // is served from http://localhost (a "remote" origin to Tauri's ACL).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_ready",
            "set_fullscreen",
            "is_fullscreen",
            "quit_app",
            "yt_signed_in",
            "yt_api",
            "yt_open_sign_in",
            "yt_close_sign_in",
            "yt_sign_out",
            "yt_channel_feeds",
            "yt_open_view",
            "steam_sounds_available",
            "read_steam_sound",
            "import_startup_video",
            "clear_startup_video",
        ]),
    ))
    .expect("failed to run tauri-build");
}
