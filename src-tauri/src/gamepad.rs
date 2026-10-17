//! Native controller input.
//!
//! Reads controllers through gilrs (Windows.Gaming.Input / XInput) on a dedicated
//! thread instead of the web Gamepad API: the webview only exposes gamepads to the
//! focused frame, so input would die whenever the YouTube player iframe takes focus.
//! Events are emitted to the frontend as `pad` events; key-repeat and navigation
//! semantics live in the frontend so keyboard and controller share one code path.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use gilrs::{Axis, Button, EventType, Gilrs};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum PadEvent {
    Down { button: &'static str },
    Up { button: &'static str },
    Axis { axis: &'static str, value: f32 },
    Connected { name: String },
    Disconnected,
}

/// Controllers gilrs currently sees. The web Gamepad API hides a pad until one of
/// its buttons is pressed, so the frontend asks here to pick the right tutorial.
static CONNECTED: AtomicUsize = AtomicUsize::new(0);

#[tauri::command]
pub fn pad_connected() -> bool {
    CONNECTED.load(Ordering::Relaxed) > 0
}

/// Stick deflection that counts as a direction press, and the lower value it must
/// fall back under to release (hysteresis stops jitter from re-triggering).
const PRESS: f32 = 0.55;
const RELEASE: f32 = 0.35;

fn button_name(b: Button) -> Option<&'static str> {
    Some(match b {
        Button::South => "A",
        Button::East => "B",
        Button::West => "X",
        Button::North => "Y",
        Button::LeftTrigger => "LB",
        Button::RightTrigger => "RB",
        Button::LeftTrigger2 => "LT",
        Button::RightTrigger2 => "RT",
        Button::Select => "View",
        Button::Start => "Menu",
        Button::LeftThumb => "LS",
        Button::RightThumb => "RS",
        Button::DPadUp => "Up",
        Button::DPadDown => "Down",
        Button::DPadLeft => "Left",
        Button::DPadRight => "Right",
        _ => return None,
    })
}

/// Turns one analog axis into a pair of virtual direction buttons.
struct StickAxis {
    neg: &'static str,
    pos: &'static str,
    state: i8,
}

impl StickAxis {
    fn update(&mut self, value: f32, out: &mut Vec<PadEvent>) {
        let next = match self.state {
            0 if value >= PRESS => 1,
            0 if value <= -PRESS => -1,
            1 if value < RELEASE => 0,
            -1 if value > -RELEASE => 0,
            s => s,
        };
        if next == self.state {
            return;
        }
        if self.state != 0 {
            let b = if self.state > 0 { self.pos } else { self.neg };
            out.push(PadEvent::Up { button: b });
        }
        if next != 0 {
            let b = if next > 0 { self.pos } else { self.neg };
            out.push(PadEvent::Down { button: b });
        }
        self.state = next;
    }
}

pub fn spawn(app: AppHandle, focused: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("gamepad".into())
        .spawn(move || {
            let mut gilrs = match Gilrs::new() {
                Ok(g) => g,
                Err(e) => {
                    eprintln!("gamepad: unavailable: {e}");
                    return;
                }
            };
            // gilrs reports +Y as up.
            let mut lx = StickAxis { neg: "Left", pos: "Right", state: 0 };
            let mut ly = StickAxis { neg: "Down", pos: "Up", state: 0 };
            let mut was_focused = true;
            let mut out = Vec::with_capacity(8);
            CONNECTED.store(gilrs.gamepads().count(), Ordering::Relaxed);

            loop {
                let is_focused = focused.load(Ordering::Relaxed);
                while let Some(ev) = gilrs.next_event() {
                    if matches!(ev.event, EventType::Connected | EventType::Disconnected) {
                        CONNECTED.store(gilrs.gamepads().count(), Ordering::Relaxed);
                    }
                    if !is_focused {
                        continue;
                    }
                    match ev.event {
                        EventType::ButtonPressed(b, _) => {
                            if let Some(button) = button_name(b) {
                                out.push(PadEvent::Down { button });
                            }
                        }
                        EventType::ButtonReleased(b, _) => {
                            if let Some(button) = button_name(b) {
                                out.push(PadEvent::Up { button });
                            }
                        }
                        EventType::ButtonChanged(Button::LeftTrigger2, v, _) => {
                            out.push(PadEvent::Axis { axis: "LT", value: v })
                        }
                        EventType::ButtonChanged(Button::RightTrigger2, v, _) => {
                            out.push(PadEvent::Axis { axis: "RT", value: v })
                        }
                        EventType::AxisChanged(Axis::LeftStickX, v, _) => lx.update(v, &mut out),
                        EventType::AxisChanged(Axis::LeftStickY, v, _) => ly.update(v, &mut out),
                        EventType::AxisChanged(Axis::RightStickY, v, _) => {
                            out.push(PadEvent::Axis { axis: "RY", value: v })
                        }
                        EventType::Connected => out.push(PadEvent::Connected {
                            name: gilrs.gamepad(ev.id).name().to_string(),
                        }),
                        EventType::Disconnected => out.push(PadEvent::Disconnected),
                        _ => {}
                    }
                }
                // Losing focus mid-hold would leave a direction "stuck" in the
                // frontend's repeat timer; release the virtual stick buttons.
                if was_focused && !is_focused {
                    lx.update(0.0, &mut out);
                    ly.update(0.0, &mut out);
                }
                was_focused = is_focused;

                for e in out.drain(..) {
                    let _ = app.emit("pad", e);
                }
                // ~250 Hz poll: well under one frame of latency even at 240 Hz.
                std::thread::sleep(Duration::from_millis(4));
            }
        })
        .expect("spawn gamepad thread");
}
