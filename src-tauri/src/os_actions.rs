use crate::file_actions::{ActionTarget, FileAction};

pub fn execute(target: &ActionTarget, owner: usize) -> Result<(), String> {
    if target.target.contains('\0') {
        return Err("無効なOS操作です".into());
    }
    match target.action {
        FileAction::CopyPath => copy_path(&target.target, owner),
        FileAction::OpenFolder | FileAction::OpenBrowser => open(&target.target),
    }
}

#[cfg(windows)]
fn copy_path(text: &str, owner: usize) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
        System::{
            DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        },
    };
    if owner == 0 {
        return Err("クリップボードの所有ウィンドウを確認できません".into());
    }
    struct Memory(Option<HGLOBAL>);
    impl Drop for Memory {
        fn drop(&mut self) {
            if let Some(memory) = self.0 {
                unsafe {
                    let _ = GlobalFree(Some(memory));
                }
            }
        }
    }
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }
    let utf16: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // Prepare the movable UTF-16 buffer before clearing any clipboard contents.
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, utf16.len() * std::mem::size_of::<u16>()) }
        .map_err(|_| "パスをコピーできません")?;
    let mut memory = Memory(Some(memory));
    unsafe {
        let pointer = GlobalLock(memory.0.unwrap());
        if pointer.is_null() {
            return Err("パスをコピーできません".into());
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), pointer.cast::<u16>(), utf16.len());
        let _ = GlobalUnlock(memory.0.unwrap());
        OpenClipboard(Some(HWND(owner as *mut _)))
            .map_err(|_| "クリップボードを開けません。再試行してください")?;
        let _clipboard = Clipboard;
        EmptyClipboard().map_err(|_| "パスをコピーできません")?;
        // CF_UNICODETEXT = 13. On success ownership transfers to the system.
        SetClipboardData(13, Some(HANDLE(memory.0.unwrap().0)))
            .map_err(|_| "パスをコピーできません")?;
        memory.0 = None;
    }
    Ok(())
}

#[cfg(windows)]
fn open(target: &str) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };
    struct Com;
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|_| "OS操作を初期化できません")?;
        let _com = Com;
        // No command-line parameters, interpreter, or caller-provided verb.
        let result = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if result.0 as isize <= 32 {
            return Err("OSで開けません。既定アプリとアクセス権を確認してください".into());
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn mac_clipboard_command() -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut command = Command::new("/usr/bin/pbcopy");
    command
        // pbcopy interprets stdin using the child locale. GUI launches may not
        // inherit Terminal's UTF-8 locale; the path bytes here are always UTF-8.
        // Override only this child, including any inherited LC_ALL setting.
        .env("LC_ALL", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(target_os = "macos")]
fn copy_path(text: &str, _owner: usize) -> Result<(), String> {
    use std::io::Write;
    let mut child = mac_clipboard_command()
        .spawn()
        .map_err(|_| "パスをコピーできません")?;
    let write = child
        .stdin
        .take()
        .ok_or("パスをコピーできません")?
        .write_all(text.as_bytes());
    let status = child.wait().map_err(|_| "パスをコピーできません")?;
    if write.is_err() || !status.success() {
        return Err("パスをコピーできません".into());
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn copy_path(_text: &str, _owner: usize) -> Result<(), String> {
    Err("このOSのクリップボード操作は未対応です".into())
}
#[cfg(not(windows))]
fn open(target: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "macos")]
    let program = "/usr/bin/open";
    #[cfg(not(target_os = "macos"))]
    let program = "/usr/bin/xdg-open";
    let mut child = Command::new(program)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "OSで開けません。既定アプリを確認してください")?;
    // Some xdg-open handlers stay alive until the launched application exits.
    // Observe immediate errors briefly, then reap outside the workspace gate.
    for _ in 0..5 {
        if let Some(status) = child.try_wait().map_err(|_| "OS起動を確認できません")? {
            return if status.success() {
                Ok(())
            } else {
                Err("OSで開けません。既定アプリとアクセス権を確認してください".into())
            };
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

// Only fixture-enabled builds can capture dispatch without touching the user's
// clipboard/default browser. The output is local test evidence, never app logs.
#[cfg(feature = "e2e")]
pub fn prepare_capture() -> Result<(), std::io::Error> {
    if let Some(path) = std::env::var_os("MY_KNOWLEDGE_E2E_ACTION_CAPTURE") {
        // The driver removes the old file before launch. Its presence proves
        // this binary supports capture before any side-effect test is allowed.
        std::fs::write(path, [])?;
    }
    Ok(())
}

#[cfg(feature = "e2e")]
pub fn capture(target: &ActionTarget) -> Option<Result<(), String>> {
    use std::{fs::OpenOptions, io::Write};
    let path = std::env::var_os("MY_KNOWLEDGE_E2E_ACTION_CAPTURE")?;
    Some((|| {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|_| "テスト記録を保存できません")?;
        let value = serde_json::to_vec(target).map_err(|_| "テスト記録を保存できません")?;
        file.write_all(&value)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|_| "テスト記録を保存できません".into())
    })())
}

#[cfg(test)]
mod clipboard_encoding_tests {
    #[test]
    fn mac_child_uses_utf8_locale_without_path_arguments_or_parent_env_changes() {
        let before = std::env::var_os("LC_ALL");
        let command = super::mac_clipboard_command();
        assert_eq!(command.get_program(), "/usr/bin/pbcopy");
        assert_eq!(command.get_args().count(), 0);
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "LC_ALL"
                && value == Some(std::ffi::OsStr::new("en_US.UTF-8"))));
        assert_eq!(std::env::var_os("LC_ALL"), before);
        let text = "カンバンToDo.html";
        let ipc = serde_json::to_vec(text).unwrap();
        let decoded: String = serde_json::from_slice(&ipc).unwrap();
        assert_eq!(decoded.as_bytes(), text.as_bytes());
        assert_eq!(std::str::from_utf8(decoded.as_bytes()).unwrap(), text);
    }
}
