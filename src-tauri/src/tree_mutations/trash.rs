//! OS recycle APIs only. An unsupported volume/OS or any error stops the
//! operation; there is no permanent-delete or copy/delete recovery path.
use std::path::Path;

#[cfg(windows)]
pub(super) fn execute(path: &Path) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::Shell::{
                BHID_Transfer, FOLDERID_RecycleBinFolder, IShellItem, ITransferSource,
                SHCreateItemFromParsingName, SHGetKnownFolderItem, KF_FLAG_DEFAULT,
            },
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
    let wide = |path: &Path| -> Result<Vec<u16>, String> {
        Ok(crate::file_actions::os_path(path)?
            .encode_utf16()
            .chain(Some(0))
            .collect())
    };
    let source = wide(path)?;
    let parent = wide(path.parent().ok_or("親フォルダーを確認できません")?)?;
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE)
            .ok()
            .map_err(|_| "ごみ箱操作を初期化できません")?;
        let _com = Com;
        let source: IShellItem = SHCreateItemFromParsingName(PCWSTR(source.as_ptr()), None)
            .map_err(|_| "ごみ箱に移動する対象を取得できません")?;
        let parent: IShellItem = SHCreateItemFromParsingName(PCWSTR(parent.as_ptr()), None)
            .map_err(|_| "親フォルダーを取得できません")?;
        let transfer: ITransferSource = parent
            .BindToHandler(None, &BHID_Transfer)
            .map_err(|_| "この場所では安全なごみ箱移動を利用できません")?;
        let bin: IShellItem =
            SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None)
                .map_err(|_| "OSのごみ箱を取得できません")?;
        // RecycleItem is explicitly a recycle operation. Do not call RemoveItem
        // or use DeleteItem/ALLOWUNDO, which can permit permanent deletion.
        let _recycled = transfer.RecycleItem(&source, &bin, 0).map_err(|_| {
            "ごみ箱に移動できません。アクセス権・ロック・ごみ箱の対応を確認してください"
        })?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn execute(path: &Path) -> Result<(), String> {
    use std::{
        ffi::{c_char, c_void, CString},
        os::unix::ffi::OsStrExt,
    };
    type Object = *mut c_void;
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Object;
        fn sel_registerName(name: *const c_char) -> Object;
        fn objc_msgSend();
    }
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| "無効なパスです")?;
    // Each message signature is fixed to its documented Foundation selector.
    // NSString converts filesystem UTF-8; no shell, script, or URL is accepted.
    unsafe {
        let send: unsafe extern "C" fn(Object, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let send_string: unsafe extern "C" fn(Object, Object, *const c_char) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let send_object: unsafe extern "C" fn(Object, Object, Object) -> Object =
            std::mem::transmute(objc_msgSend as *const ());
        let recycle: unsafe extern "C" fn(
            Object,
            Object,
            Object,
            *mut Object,
            *mut Object,
        ) -> bool = std::mem::transmute(objc_msgSend as *const ());
        let pool = send(
            objc_getClass(c"NSAutoreleasePool".as_ptr()),
            sel_registerName(c"new".as_ptr()),
        );
        let string = send_string(
            objc_getClass(c"NSString".as_ptr()),
            sel_registerName(c"stringWithUTF8String:".as_ptr()),
            path.as_ptr(),
        );
        let url = send_object(
            objc_getClass(c"NSURL".as_ptr()),
            sel_registerName(c"fileURLWithPath:".as_ptr()),
            string,
        );
        let manager = send(
            objc_getClass(c"NSFileManager".as_ptr()),
            sel_registerName(c"defaultManager".as_ptr()),
        );
        let mut result = std::ptr::null_mut();
        let mut error = std::ptr::null_mut();
        let success = !string.is_null()
            && !url.is_null()
            && recycle(
                manager,
                sel_registerName(c"trashItemAtURL:resultingItemURL:error:".as_ptr()),
                url,
                &mut result,
                &mut error,
            );
        send(pool, sel_registerName(c"drain".as_ptr()));
        if !success {
            return Err(
                "ごみ箱に移動できません。アクセス権・ロック・ごみ箱の対応を確認してください".into(),
            );
        }
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(super) fn execute(_path: &Path) -> Result<(), String> {
    Err("このOSのごみ箱操作は未対応です。原本は削除していません".into())
}
