//! Google OAuth 2.0 for installed apps: loopback redirect + PKCE.
//!
//! The browser handles consent, so Panorama never sees the user's password. The
//! refresh token is kept in Windows Credential Manager; only short-lived access
//! tokens ever reach the webview.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const SCOPE: &str = "https://www.googleapis.com/auth/youtube.readonly";
const KEYRING_SERVICE: &str = "com.panorama.tv";
const KEYRING_USER: &str = "google-refresh-token";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize)]
pub struct Session {
    access_token: String,
    /// Expiry as Unix epoch milliseconds.
    expires_at: u64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
}

fn random_b64(len: usize) -> String {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn session_from(t: &TokenResponse) -> Session {
    // Treat the token as expiring a minute early so a request never races expiry.
    Session {
        access_token: t.access_token.clone(),
        expires_at: now_ms() + t.expires_in.saturating_sub(60) * 1000,
    }
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Panorama</title>\
<body style=\"background:#0b0b0e;color:#eee;font:20px system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"font-weight:600\">You're signed in</h1>\
<p style=\"opacity:.6\">You can close this tab and return to Panorama.</p></div>";

const FAIL_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Panorama</title>\
<body style=\"background:#0b0b0e;color:#eee;font:20px system-ui;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"font-weight:600\">Sign-in was cancelled</h1>\
<p style=\"opacity:.6\">Return to Panorama to try again.</p></div>";

/// Waits for the browser to hit the loopback redirect and returns the auth code.
async fn await_redirect(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        while len < buf.len() {
            let n = sock.read(&mut buf[len..]).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..len]);
        let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
        // Browsers also ask for /favicon.ico and similar; only "/?..." is ours.
        if !target.starts_with("/?") {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        }
        let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| e.to_string())?;
        let q = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());

        let result = match (q("state"), q("code"), q("error")) {
            (Some(s), Some(code), None) if s == state => Ok(code),
            (Some(s), _, _) if s != state => Err("OAuth state mismatch".to_string()),
            (_, _, Some(err)) => Err(format!("Sign-in failed: {err}")),
            _ => Err("Sign-in failed: malformed redirect".to_string()),
        };
        let page = if result.is_ok() { DONE_PAGE } else { FAIL_PAGE };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
            page.len()
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
        return result;
    }
}

async fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        resp.json::<TokenResponse>().await.map_err(|e| e.to_string())
    } else {
        let err = resp.json::<TokenError>().await.map(|e| e.error).unwrap_or_else(|_| "unknown".into());
        Err(err)
    }
}

#[tauri::command]
pub async fn oauth_sign_in(app: AppHandle, client_id: String, client_secret: String) -> Result<Session, String> {
    let verifier = random_b64(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(24);

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|e| e.to_string())?.port());

    let auth = url::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_url(auth.as_str(), None::<&str>).map_err(|e| e.to_string())?;

    let code = tokio::time::timeout(SIGN_IN_TIMEOUT, await_redirect(listener, &state))
        .await
        .map_err(|_| "Sign-in timed out".to_string())??;

    let tokens = post_token(&[
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier.as_str()),
    ])
    .await?;

    if let Some(rt) = &tokens.refresh_token {
        credential()?.set_password(rt).map_err(|e| e.to_string())?;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
    Ok(session_from(&tokens))
}

/// Returns a fresh access token, or `None` when the user is not signed in (or the
/// grant was revoked, in which case the stale refresh token is discarded).
#[tauri::command]
pub async fn oauth_refresh(client_id: String, client_secret: String) -> Result<Option<Session>, String> {
    let entry = credential()?;
    let refresh = match entry.get_password() {
        Ok(t) => t,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    match post_token(&[
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .await
    {
        Ok(t) => Ok(Some(session_from(&t))),
        Err(e) if e == "invalid_grant" => {
            let _ = entry.delete_credential();
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn oauth_sign_out() -> Result<(), String> {
    let entry = credential()?;
    if let Ok(token) = entry.get_password() {
        // Best effort: the local credential is removed even if revocation fails.
        let _ = reqwest::Client::new().post(REVOKE_URL).form(&[("token", token.as_str())]).send().await;
    }
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
