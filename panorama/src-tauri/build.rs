fn main() {
    // App commands must be declared so they can be granted to the window: the UI
    // is served from http://localhost (a "remote" origin to Tauri's ACL).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_ready",
            "set_fullscreen",
            "is_fullscreen",
            "quit_app",
            "oauth_sign_in",
            "oauth_refresh",
            "oauth_sign_out",
        ]),
    ))
    .expect("failed to run tauri-build");
}
