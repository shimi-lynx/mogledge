//! Fixed application accelerators and narrowly scoped browser refresh/print/close protection.

use super::super::ShortcutState;
use tauri::{Emitter, Manager, WebviewWindow};
use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2AcceleratorKeyPressedEventArgs2, ICoreWebView2Controller,
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
        COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    },
};
use windows::core::Interface;
use windows::Win32::UI::{
    Input::{
        Ime::{ImmGetCompositionStringW, ImmGetContext, ImmReleaseContext, GCS_COMPSTR},
        KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT},
    },
    WindowsAndMessaging::{GetForegroundWindow, GetGUIThreadInfo, GUITHREADINFO},
};
unsafe fn key_down(key: u16) -> bool {
    GetKeyState(i32::from(key)) < 0
}

unsafe fn composing() -> bool {
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(0, &mut info).is_err() || info.hwndFocus.is_invalid() {
        return false;
    }
    let context = ImmGetContext(info.hwndFocus);
    if context.is_invalid() {
        return false;
    }
    let active = ImmGetCompositionStringW(context, GCS_COMPSTR, None, 0) > 0;
    let _ = ImmReleaseContext(info.hwndFocus, context);
    active
}

pub(super) unsafe fn install(
    controller: &ICoreWebView2Controller,
    window: WebviewWindow,
) -> windows::core::Result<()> {
    let mut token = 0i64;
    controller.add_AcceleratorKeyPressed(
        &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = Default::default();
            let mut key = 0;
            args.KeyEventKind(&mut kind)?;
            args.VirtualKey(&mut key)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
            {
                return Ok(());
            }
            if !window
                .hwnd()
                .is_ok_and(|hwnd| GetForegroundWindow() == hwnd)
            {
                return Ok(());
            }
            let control = key_down(VK_CONTROL.0);
            let alt = key_down(VK_MENU.0);
            let windows = key_down(VK_LWIN.0) || key_down(VK_RWIN.0);
            if alt && !control && !windows && !key_down(VK_SHIFT.0) && matches!(key, 0x25 | 0x27) {
                // Disable only browser Back/Forward. Keep DOM delivery so HTML,
                // editors and IME retain first refusal; no Native app dispatch.
                if let Ok(browser_action) =
                    args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()
                {
                    browser_action.SetIsBrowserAcceleratorKeyEnabled(false)?;
                }
                return Ok(());
            }
            if !control || alt || windows {
                return Ok(());
            }
            if key == 0x52 || (matches!(key, 0x50 | 0x57) && !key_down(VK_SHIFT.0)) {
                // Disable browser refresh/print/close without consuming DOM keys.
                // HTML retains first refusal for quick-open. Older runtimes
                // swallow only R to preserve live tabs; swallowing P or W would
                // bypass HTML/editor/IME priority, so keep their DOM delivery.
                // On older WebView2 without Args2, W's browser action remains enabled.
                if let Ok(browser_action) =
                    args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>()
                {
                    browser_action.SetIsBrowserAcceleratorKeyEnabled(false)?;
                } else if key == 0x52 {
                    args.SetHandled(true)?;
                }
                return Ok(());
            }
            if !key_down(VK_SHIFT.0) {
                return Ok(());
            }
            let command = match key {
                0x46 => "focus-search",
                0x54 => "reopen-closed-tab",
                _ => return Ok(()),
            };
            if !window.state::<ShortcutState>().allows(command) || composing() {
                return Ok(());
            }
            // Ctrl+Shift+arrows remain in the document's editing path. Only
            // fixed app shortcuts are swallowed before DOM keydown dispatch.
            args.SetHandled(true)?;
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            if !status.WasKeyDown.as_bool() {
                let _ = window.emit_to(window.label(), "window-command", command);
            }
            Ok(())
        })),
        &mut token,
    )
}
