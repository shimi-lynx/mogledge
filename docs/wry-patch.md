# Windows initialization-script isolation

The vendored Wry 0.57.0 Windows implementation requires an initialization-script guard: upstream `for_main_frame_only=true` does not by itself prevent execution in every child frame in this version. The guarded copy lives in `src-tauri/vendor/wry` and is selected by Cargo's patch configuration.

In `src/webview2/mod.rs`, scripts marked main-frame-only are wrapped so they return immediately when `window !== window.top`. This also prevents the IPC-key closure from being initialized inside a document frame. macOS keeps its existing WKWebView main-frame behavior.

The vendored Cargo manifest omits upstream example declarations. Other upstream source is preserved apart from the targeted guard. Keep its MIT/Apache-2.0 copyright and license files unchanged, and retain vendor exclusions from formatting/linting.

Before upgrading or removing the patch, check the upstream behavior and verify the actual Native app: no `__TAURI_INTERNALS__` in the document frame, direct IPC/parent DOM/storage rejected, and supported modules/JSON/Canvas working. Do not remove the patch because this explanatory file was reorganized.

See the [pinned Wry API](https://docs.rs/wry/0.57.0/wry/struct.WebViewBuilder.html#method.with_initialization_script_for_main_only), [security](security.md) and [testing](testing.md#native-qa).
