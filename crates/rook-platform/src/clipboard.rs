use std::fmt::Debug;

pub trait Clipboard: Send + Sync + Debug {
    fn text(&self) -> Option<String>;
    fn set_text(&self, text: &str);
}

/// The system's clipboard through arboard, opened for each use: holding
/// it open would keep other programs off it on some systems.
#[cfg(all(feature = "native", not(target_os = "android")))]
#[derive(Debug)]
pub struct System;

#[cfg(all(feature = "native", not(target_os = "android")))]
impl Clipboard for System {
    fn text(&self) -> Option<String> {
        arboard::Clipboard::new().ok()?.get_text().ok()
    }

    fn set_text(&self, text: &str) {
        // Best effort: a clipboard another program holds just misses it.
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            let _ = clipboard.set_text(text);
        }
    }
}

/// Android has no arboard backend (a game embeds the text field instead).
#[cfg(all(feature = "native", target_os = "android"))]
#[derive(Debug)]
pub struct System;

#[cfg(all(feature = "native", target_os = "android"))]
impl Clipboard for System {
    fn text(&self) -> Option<String> {
        None
    }

    fn set_text(&self, _text: &str) {}
}
