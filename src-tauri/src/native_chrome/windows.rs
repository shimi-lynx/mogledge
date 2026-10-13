//! Windows uses a single app title row with scoped minimize/maximize/close actions.

mod shortcuts;
mod theme;

use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            WM_ACTIVATE, WM_DWMCOMPOSITIONCHANGED, WM_NCDESTROY, WM_SETTINGCHANGE, WM_THEMECHANGED,
        },
    },
};

const SUBCLASS_ID: usize = 0x4d4b_4348;

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let window = window.clone();
    let target = window.clone();
    window.with_webview(move |platform| {
        // Tauri runs this closure on the owning WebView/window thread.
        unsafe {
            let controller = platform.controller();
            let hwnd = target.hwnd().expect("Native window is unavailable");
            shortcuts::install(&controller, target).expect("Cannot install window shortcuts");
            // Styling is optional; registration failure must leave standard controls usable.
            let _ = SetWindowSubclass(hwnd, Some(theme_proc), SUBCLASS_ID, 0);
            theme::apply(hwnd);
        }
    })
}

unsafe extern "system" fn theme_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        // No callback allocation is owned, so a failed detach cannot leave dangling data.
        let _ = RemoveWindowSubclass(hwnd, Some(theme_proc), SUBCLASS_ID);
        return DefSubclassProc(hwnd, message, wparam, lparam);
    }
    let result = DefSubclassProc(hwnd, message, wparam, lparam);
    if matches!(
        message,
        WM_THEMECHANGED | WM_SETTINGCHANGE | WM_DWMCOMPOSITIONCHANGED | WM_ACTIVATE
    ) {
        theme::apply(hwnd);
    }
    result
}
