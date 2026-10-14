//! Local media: UI sounds read from the user's own Steam install (never bundled
//! or redistributed), and the user's custom startup video.

use std::fs;
use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

/// Only these files may be read, so the command can't be used to read
/// arbitrary paths.
const STEAM_SOUNDS: &[&str] = &[
    "deck_ui_navigation.wav",
    "deck_ui_default_activation.wav",
    "deck_ui_bumper_end_02.wav",
    "deck_ui_into_game_detail.wav",
    "deck_ui_out_of_game_detail.wav",
    "deck_ui_launch_game.wav",
    "deck_ui_tab_transition_01.wav",
    "deck_ui_side_menu_fly_in.wav",
    "deck_ui_side_menu_fly_out.wav",
    "deck_ui_show_modal.wav",
    "deck_ui_hide_modal.wav",
    "deck_ui_switch_toggle_on.wav",
    "deck_ui_switch_toggle_off.wav",
    "deck_ui_slider_up.wav",
    "deck_ui_slider_down.wav",
    "deck_ui_volume.wav",
    "deck_ui_typing.wav",
    "deck_ui_toast.wav",
    "confirmation_positive.wav",
    "confirmation_negative.wav",
    "steam_os_startup.wav",
];

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mov"];

fn steam_sounds_dir() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Software\\Valve\\Steam") {
            if let Ok(p) = key.get_value::<String, _>("SteamPath") {
                roots.push(PathBuf::from(p));
            }
        }
    }
    roots.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    roots.push(PathBuf::from(r"C:\Program Files\Steam"));
    roots
        .into_iter()
        .map(|r| r.join("steamui").join("sounds"))
        .find(|d| d.join(STEAM_SOUNDS[0]).is_file())
}

#[tauri::command]
pub fn steam_sounds_available() -> bool {
    steam_sounds_dir().is_some()
}

/// Raw bytes (not JSON) so a few hundred KB of WAV crosses IPC cheaply.
#[tauri::command]
pub fn read_steam_sound(name: String) -> Result<Response, String> {
    if !STEAM_SOUNDS.contains(&name.as_str()) {
        return Err("unknown sound".into());
    }
    let dir = steam_sounds_dir().ok_or("Steam not found")?;
    fs::read(dir.join(&name)).map(Response::new).map_err(|e| e.to_string())
}

fn startup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("startup"))
}

/// Copies the chosen video into app data, so the startup video keeps working
/// if the original is moved or deleted. Returns the stored path.
#[tauri::command]
pub fn import_startup_video(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| VIDEO_EXTS.contains(&e.as_str()))
        .ok_or("Choose an MP4, WebM, M4V or MOV video")?;
    let dir = startup_dir(&app)?;
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("startup.{ext}"));
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clear_startup_video(app: AppHandle) -> Result<(), String> {
    match fs::remove_dir_all(startup_dir(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
