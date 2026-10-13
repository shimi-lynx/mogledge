use crate::{core::Core, document_server};
use std::sync::Arc;

pub fn document_allowed(core: &Core, url: &tauri::Url) -> bool {
    if url.origin().ascii_serialization() != core.origin {
        return false;
    }
    let Some((token, path)) = document_server::decode_path(url.path()) else {
        return false;
    };
    core.session_for_token(&token)
        .is_some_and(|s| s.entry == path)
}

// Built-in help is root/session independent and has no document privileges.
pub fn frame_allowed(core: &Core, url: &tauri::Url) -> bool {
    document_server::help::allowed_url(&core.origin, url.as_str()) || document_allowed(core, url)
}

#[cfg(windows)]
pub fn install_frame_guard(window: &tauri::WebviewWindow, core: Arc<Core>) -> tauri::Result<()> {
    // Register on each actual frame. The legacy top-level FrameNavigationStarting
    // event is superseded and does not cover all WebView2 frame scenarios.
    window.with_webview(move |platform| unsafe {
        use webview2_com::{
            take_pwstr, FrameCreatedEventHandler, FrameNavigationStartingEventHandler,
            Microsoft::Web::WebView2::Win32::{ICoreWebView2Frame2, ICoreWebView2_4},
        };
        use windows::core::{Interface, PWSTR};
        let webview: ICoreWebView2_4 = platform
            .controller()
            .CoreWebView2()
            .expect("Cannot access WebView2")
            .cast()
            .expect("WebView2 frame API is unavailable");
        let mut event_token = 0i64;
        webview
            .add_FrameCreated(
                &FrameCreatedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let frame: ICoreWebView2Frame2 = args.Frame()?.cast()?;
                        let core = core.clone();
                        let mut navigation_token = 0i64;
                        frame.add_NavigationStarting(
                            &FrameNavigationStartingEventHandler::create(Box::new(
                                move |_, args| {
                                    if let Some(args) = args {
                                        let mut uri = PWSTR::null();
                                        args.Uri(&mut uri)?;
                                        let allowed = tauri::Url::parse(&take_pwstr(uri))
                                            .ok()
                                            .is_some_and(|url| frame_allowed(&core, &url));
                                        if !allowed {
                                            args.SetCancel(true)?;
                                        }
                                    }
                                    Ok(())
                                },
                            )),
                            &mut navigation_token,
                        )?;
                    }
                    Ok(())
                })),
                &mut event_token,
            )
            .expect("Cannot install iframe navigation boundary");
    })
}
#[cfg(not(windows))]
pub fn install_frame_guard(_: &tauri::WebviewWindow, _: Arc<Core>) -> tauri::Result<()> {
    // WKWebView's navigation policy delegate covers subframe navigation too.
    Ok(())
}
