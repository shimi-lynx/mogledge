//! Windows metadata checks never open placeholder contents for acquisition.
//! The capability directory remains responsible for the actual file open.

use super::reparse::PathInfo;
#[path = "cloud_write.rs"]
mod cloud_write;
use cap_std::fs::{Dir, File, OpenOptions};
pub(crate) use cloud_write::CloudWriteOutcome;
pub(crate) use cloud_write::{
    create_folder as create_cloud_folder, create_html as create_cloud_html,
    move_leaf as move_cloud_leaf,
};
use std::{
    ffi::{c_void, OsString},
    fs, io,
    marker::PhantomData,
    mem::size_of,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt as StdOpenOptionsExt,
        io::{AsRawHandle, RawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    rc::Rc,
    sync::OnceLock,
};

const FILE_READ_ATTRIBUTES: u32 = 0x80;
const FILE_READ_DATA: u32 = 1;
const FILE_LIST_DIRECTORY: u32 = 1;
const FILE_SHARE_READ: u32 = 1;
const FILE_SHARE_WRITE: u32 = 2;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
const FILE_FLAG_OPEN_NO_RECALL: u32 = 0x00100000;
const FILE_ATTRIBUTE_TAG_INFO: i32 = 9;
const FILE_ID_INFO: i32 = 18;
const FILE_TYPE_DISK: u32 = 1;
const MAX_WINDOWS_PATH: usize = 32768;
const UNAVAILABLE: &str = "クラウド上の未取得ファイルやフォルダは読み取れません。エクスプローラーで必要な資料をこのデバイスに保持してから再試行してください";
const UNSUPPORTED: &str = "リンクや未対応のreparse pointへのアクセスは禁止されています";

#[repr(C)]
struct AttributeTagInfo {
    attributes: u32,
    reparse_tag: u32,
}

#[repr(C)]
#[derive(Eq, PartialEq)]
struct FileIdInfo {
    volume_serial: u64,
    file_id: [u8; 16],
}

#[repr(C)]
struct FindData {
    attributes: u32,
    creation_time: [u32; 2],
    access_time: [u32; 2],
    write_time: [u32; 2],
    size_high: u32,
    size_low: u32,
    reparse_tag: u32,
    reserved: u32,
    name: [u16; 260],
    alternate_name: [u16; 14],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandleEx(
        file: RawHandle,
        information_class: i32,
        information: *mut c_void,
        buffer_size: u32,
    ) -> i32;
    fn GetFinalPathNameByHandleW(
        file: RawHandle,
        path: *mut u16,
        path_size: u32,
        flags: u32,
    ) -> u32;
    fn GetFileType(file: RawHandle) -> u32;
    fn GetDriveTypeW(root_path: *const u16) -> u32;
    fn FindFirstFileW(path: *const u16, data: *mut FindData) -> RawHandle;
    fn FindClose(find: RawHandle) -> i32;
    fn GetModuleHandleW(module_name: *const u16) -> RawHandle;
    fn GetProcAddress(
        module: RawHandle,
        procedure_name: *const u8,
    ) -> Option<unsafe extern "system" fn() -> isize>;
}

type SetPlaceholderMode = unsafe extern "system" fn(i8) -> i8;

fn placeholder_mode_function() -> io::Result<SetPlaceholderMode> {
    static FUNCTION: OnceLock<Option<SetPlaceholderMode>> = OnceLock::new();
    let function = FUNCTION.get_or_init(|| {
        let module_name = "ntdll.dll\0".encode_utf16().collect::<Vec<_>>();
        // SAFETY: the NUL-terminated name references the system module already
        // loaded for the lifetime of every Windows process.
        let module = unsafe { GetModuleHandleW(module_name.as_ptr()) };
        if module.is_null() {
            return None;
        }
        // SAFETY: this is the documented export name in the loaded module.
        // An absent export is handled without loading a library.
        let procedure = unsafe {
            GetProcAddress(
                module,
                c"RtlSetThreadPlaceholderCompatibilityMode".as_ptr().cast(),
            )
        }?;
        // SAFETY: the documented export has this exact CHAR->CHAR system ABI.
        Some(unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, SetPlaceholderMode>(
                procedure,
            )
        })
    });
    function.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "クラウドファイル情報の安全な取得に対応していないWindowsです",
        )
    })
}

pub(super) struct PlaceholderVisibility {
    set_mode: SetPlaceholderMode,
    previous: i8,
    // !Send + !Sync: this setting must be restored on the originating thread.
    _thread_bound: PhantomData<Rc<()>>,
}

impl PlaceholderVisibility {
    pub(super) fn expose() -> io::Result<Self> {
        let set_mode = placeholder_mode_function()?;
        // SAFETY: documented thread mode 2 exposes placeholder metadata and
        // returns the previous mode. It changes no OneDrive/user settings.
        let previous = unsafe { set_mode(2) };
        if previous < 0 {
            return Err(denied("クラウドファイル情報を安全に取得できません"));
        }
        Ok(Self {
            set_mode,
            previous,
            _thread_bound: PhantomData,
        })
    }
}

impl Drop for PlaceholderVisibility {
    fn drop(&mut self) {
        // SAFETY: this !Send guard restores the successful call's valid mode
        // on the same thread, including on error or unwinding.
        unsafe { (self.set_mode)(self.previous) };
    }
}

fn denied(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

pub(super) fn handle_info(handle: RawHandle) -> io::Result<PathInfo> {
    let _visibility = PlaceholderVisibility::expose()?;
    let mut info = AttributeTagInfo {
        attributes: 0,
        reparse_tag: 0,
    };
    // SAFETY: the borrowed handle stays alive and the writable buffer has the
    // documented FILE_ATTRIBUTE_TAG_INFO layout and exact size.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FILE_ATTRIBUTE_TAG_INFO,
            (&mut info as *mut AttributeTagInfo).cast(),
            size_of::<AttributeTagInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PathInfo::from_attributes(info.attributes, info.reparse_tag))
}

fn handle_identity(handle: RawHandle) -> io::Result<FileIdInfo> {
    let mut identity = FileIdInfo {
        volume_serial: 0,
        file_id: [0; 16],
    };
    // SAFETY: the borrowed handle stays live and identity has the documented
    // FILE_ID_INFO layout, including the 128-bit file identifier.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FILE_ID_INFO,
            (&mut identity as *mut FileIdInfo).cast(),
            size_of::<FileIdInfo>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(identity)
}

pub(super) fn final_path(handle: RawHandle) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; MAX_WINDOWS_PATH];
    // SAFETY: the borrowed handle remains live, and buffer is writable for
    // path_size UTF-16 units. Zero requests normalized DOS volume paths.
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) }
            as usize;
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= buffer.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "ファイルパスが長すぎます",
        ));
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

fn metadata_handle(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        // Attribute-only opens inspect without reading contents. Windows
        // sharing checks do not constrain such handles, so actual read opens
        // must compare object identity and recheck availability afterwards.
        .share_mode(FILE_SHARE_READ)
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_NO_RECALL,
        )
        .open(path)
}

fn directory_handle(path: &Path, allow_write_sharing: bool) -> io::Result<fs::File> {
    // Only call after metadata preflight proves the directory is local. The
    // read-data/list right also conflicts with normal Cloud Files exclusive
    // dehydration opens; READ_ATTRIBUTES alone does not provide that lock.
    fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)
        .share_mode(
            FILE_SHARE_READ
                | if allow_write_sharing {
                    FILE_SHARE_WRITE
                } else {
                    0
                },
        )
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_NO_RECALL,
        )
        .open(path)
}

fn enumeration_info(path: &Path) -> io::Result<Option<PathInfo>> {
    if path.file_name().is_none() {
        // Drive roots have no parent enumeration entry; GetDriveType and
        // actual handle checks establish their local directory identity.
        return Ok(None);
    }
    let _visibility = PlaceholderVisibility::expose()?;
    // FindFirstFile rejects a trailing separator on a named directory.
    // Rebuilding components preserves the drive-root separator while removing
    // trailing separators from named directories.
    let query_path = path.components().collect::<PathBuf>();
    let mut wide = query_path.as_os_str().encode_wide().collect::<Vec<_>>();
    if wide.len() >= MAX_WINDOWS_PATH || wide.contains(&0) {
        return Err(denied("無効なファイルパスです"));
    }
    wide.push(0);
    // SAFETY: WIN32_FIND_DATAW has integer/UTF-16 fields, for which zero is
    // valid, and the buffer has exactly the documented Windows layout.
    let mut data: FindData = unsafe { std::mem::zeroed() };
    // The caller retains the local parent directory's list guard. This is an
    // exact entry query, without a wildcard or traversal into this entry.
    // SAFETY: wide is NUL-terminated and data is writable for the struct size.
    let find = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if find == (-1isize) as RawHandle {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: this is a successful FindFirstFileW search handle, not an owned
    // file handle. FindClose is the matching release operation.
    if unsafe { FindClose(find) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(PathInfo::from_enumeration(
        data.attributes,
        data.reparse_tag,
    )))
}

pub(super) fn inspect_path(path: &Path) -> io::Result<PathInfo> {
    let _visibility = PlaceholderVisibility::expose()?;
    let file = metadata_handle(path)?;
    let info = handle_info(file.as_raw_handle())?;
    if !info.allowed() {
        return Ok(info);
    }
    let enumerated = enumeration_info(path)?.unwrap_or(info);
    if enumerated.is_dir() != info.is_dir() {
        return Err(denied("ファイルが変更されたため再試行してください"));
    }
    Ok(enumerated)
}

/// Local directories acquire list access after preflight, preventing ancestor
/// replacements and normal exclusive dehydration. Placeholder files use
/// attribute-only handles, then actual reads verify the inspected identity.
pub(super) struct PathGuard {
    handles: Vec<fs::File>,
    paths: Vec<PathBuf>,
    info: PathInfo,
    _visibility: PlaceholderVisibility,
    // Entries shared for ordinary publication must remain ordinary at every
    // revalidation. This has the same length/order as paths and handles.
    requires_ordinary: Vec<bool>,
}

impl PathGuard {
    // Attribute-only file handles do not enforce Windows sharing restrictions.
    // Path-only dispatch still needs a data-access handle to pin the leaf until
    // dispatch returns; no content is read and no write/delete sharing is given.
    pub(super) fn retain_reference_file(&mut self) -> io::Result<()> {
        self.revalidate()?;
        if self.info.is_dir() {
            return Err(denied("通常のファイルのみ利用できます"));
        }
        ensure_local(self.info)?;
        let path = self.paths.last().expect("guard contains leaf");
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_DATA | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL)
            .open(path)?;
        self.verify_identity(file.as_raw_handle())?;
        let info = handle_info(file.as_raw_handle())?;
        // SAFETY: GetFileType only queries this live owned disk handle.
        if !info.allowed()
            || info.is_dir()
            || unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
        {
            return Err(denied(UNSUPPORTED));
        }
        ensure_local(info)?;
        self.revalidate()?;
        *self.handles.last_mut().expect("guard contains leaf") = file;
        self.revalidate()
    }

    pub(super) fn info(&self) -> PathInfo {
        self.info
    }

    pub(super) fn canonical_path(&self) -> io::Result<PathBuf> {
        final_path(
            self.handles
                .last()
                .expect("guard contains leaf")
                .as_raw_handle(),
        )
    }

    pub(super) fn revalidate(&self) -> io::Result<()> {
        for ((path, file), requires_ordinary) in self
            .paths
            .iter()
            .zip(&self.handles)
            .zip(&self.requires_ordinary)
        {
            let info = handle_info(file.as_raw_handle())?;
            if !info.allowed() {
                return Err(denied(UNSUPPORTED));
            }
            if *requires_ordinary && !info.is_ordinary() {
                return Err(denied(UNSUPPORTED));
            }
            ensure_local(info)?;
            if let Some(enumerated) = enumeration_info(path)? {
                if !enumerated.allowed() || enumerated.is_dir() != info.is_dir() {
                    return Err(denied(UNSUPPORTED));
                }
                if *requires_ordinary && !enumerated.is_ordinary() {
                    return Err(denied(UNSUPPORTED));
                }
                ensure_local(enumerated)?;
            }
        }
        Ok(())
    }

    fn verify_identity(&self, handle: RawHandle) -> io::Result<()> {
        let inspected = self.handles.last().expect("guard contains leaf");
        if handle_identity(inspected.as_raw_handle())? != handle_identity(handle)? {
            return Err(denied("ファイルが変更されたため再試行してください"));
        }
        Ok(())
    }
}

pub(super) fn validate_local_path(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "絶対パスが必要です",
        ));
    }
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err(denied("ローカルドライブのフォルダを選択してください")),
        },
        // Do not inspect network shares or Windows device namespaces while
        // handling a selected local knowledge folder.
        _ => return Err(denied("ローカルドライブのフォルダを選択してください")),
    };
    let drive_root = [drive as u16, b':' as u16, b'\\' as u16, 0];
    // SAFETY: drive_root is a live, NUL-terminated UTF-16 drive root string.
    // Reject mapped network drives before opening any filesystem metadata.
    if !matches!(unsafe { GetDriveTypeW(drive_root.as_ptr()) }, 2 | 3 | 5 | 6) {
        return Err(denied("ローカルドライブのフォルダを選択してください"));
    }
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(denied("ローカルドライブのフォルダを選択してください"));
    }
    if components.any(|part| match part {
        Component::Normal(name) => name.to_string_lossy().contains(['*', '?', ':', '\0']),
        _ => true,
    }) {
        return Err(denied("親ディレクトリにはアクセスできません"));
    }
    Ok(())
}

pub(super) fn guard_path(path: &Path) -> io::Result<PathGuard> {
    guard_path_inner(path, false, false)
}

// File export may publish into a retained ordinary ancestor. Sharing writes
// there permits the OS rename without releasing its no-delete protection.
// Cloud directories retain their existing read-only sharing policy.
pub(super) fn guard_reference_file(path: &Path) -> io::Result<PathGuard> {
    guard_path_inner(path, false, true)
}

/// Native profile publication needs directory write sharing. All ancestors
/// must be ordinary local directories, and delete sharing remains denied.
/// Document/cloud read guards retain their existing stricter sharing mode.
pub(super) fn guard_profile_directory(path: &Path) -> io::Result<PathGuard> {
    guard_path_inner(path, true, false)
}

fn guard_path_inner(
    path: &Path,
    ordinary_profile: bool,
    reference_file: bool,
) -> io::Result<PathGuard> {
    let visibility = PlaceholderVisibility::expose()?;
    validate_local_path(path)?;
    let ancestors = path.ancestors().collect::<Vec<_>>();
    let mut handles = Vec::with_capacity(ancestors.len());
    let mut paths = Vec::with_capacity(ancestors.len());
    let mut requires_ordinary = Vec::with_capacity(ancestors.len());
    let mut leaf_info = None;
    for ancestor in ancestors.into_iter().rev() {
        // `C:` is drive-relative, not an ancestor directory to inspect.
        if !ancestor.has_root() {
            continue;
        }
        let mut file = metadata_handle(ancestor)?;
        let mut info = handle_info(file.as_raw_handle())?;
        if !info.allowed() {
            return Err(denied(UNSUPPORTED));
        }
        if ordinary_profile && (!info.is_ordinary() || !info.is_dir()) {
            return Err(denied(UNSUPPORTED));
        }
        if ancestor != path && !info.is_dir() {
            return Err(denied("通常のフォルダのみ利用できます"));
        }
        let enumerated = enumeration_info(ancestor)?.unwrap_or(info);
        if !enumerated.allowed() || enumerated.is_dir() != info.is_dir() {
            return Err(denied(UNSUPPORTED));
        }
        if ordinary_profile && !enumerated.is_ordinary() {
            return Err(denied(UNSUPPORTED));
        }
        let share_write = ordinary_profile
            || (reference_file && info.is_dir() && info.is_ordinary() && enumerated.is_ordinary());
        if info.is_dir() {
            ensure_local(info)?;
            ensure_local(enumerated)?;
            let directory = directory_handle(ancestor, share_write)?;
            if handle_identity(file.as_raw_handle())? != handle_identity(directory.as_raw_handle())?
            {
                return Err(denied("フォルダが変更されたため再試行してください"));
            }
            info = handle_info(directory.as_raw_handle())?;
            if !info.allowed() || !info.is_dir() || (share_write && !info.is_ordinary()) {
                return Err(denied(UNSUPPORTED));
            }
            ensure_local(info)?;
            file = directory;
        }
        leaf_info = Some(enumerated);
        handles.push(file);
        paths.push(ancestor.to_path_buf());
        requires_ordinary.push(share_write);
    }
    Ok(PathGuard {
        handles,
        paths,
        info: leaf_info.ok_or_else(|| denied("フォルダを読み取れません"))?,
        _visibility: visibility,
        requires_ordinary,
    })
}

#[cfg(test)]
fn validate_root(path: &Path) -> io::Result<PathBuf> {
    let guard = guard_path(path)?;
    if !guard.info().is_dir() {
        return Err(denied("通常のフォルダを選択してください"));
    }
    guard.canonical_path()
}

pub(super) fn is_device_name(part: &str) -> bool {
    super::reparse::is_device_name(part)
}

pub(super) fn ensure_local(info: PathInfo) -> io::Result<()> {
    if info.requires_download() {
        Err(denied(UNAVAILABLE))
    } else {
        Ok(())
    }
}

pub(super) fn configure_read(options: &mut OpenOptions) {
    use cap_std::fs::OpenOptionsExt;
    options
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL);
}

pub(super) fn open_root_dir(guard: &PathGuard) -> io::Result<Dir> {
    guard.revalidate()?;
    if !guard.info().is_dir() {
        return Err(denied("通常のフォルダを選択してください"));
    }
    let root = guard.canonical_path()?;
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_NO_RECALL,
        )
        .open(&root)?;
    guard.verify_identity(file.as_raw_handle())?;
    let dir = Dir::from_std_file(file);
    verify_root(&root, &dir)?;
    guard.revalidate()?;
    Ok(dir)
}

pub(super) fn verify_root(root: &Path, dir: &Dir) -> io::Result<()> {
    let info = handle_info(dir.as_raw_handle())?;
    if !info.allowed() || !info.is_dir() || final_path(dir.as_raw_handle())? != root {
        return Err(denied(
            "knowledgeフォルダが変更されたため再選択してください",
        ));
    }
    ensure_local(info)?;
    Ok(())
}

/// Call after the capability open and before any bytes are read. The caller
/// must retain its PathGuard for the complete read.
pub(super) fn verify_read(
    root: &Path,
    dir: &Dir,
    file: &File,
    guard: &PathGuard,
) -> io::Result<()> {
    guard.revalidate()?;
    verify_root(root, dir)?;
    guard.verify_identity(file.as_raw_handle())?;
    let info = handle_info(file.as_raw_handle())?;
    if !info.allowed() {
        return Err(denied(UNSUPPORTED));
    }
    ensure_local(info)?;
    // SAFETY: GetFileType only queries the live borrowed handle.
    if info.is_dir() || unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(denied("通常のファイルのみ読み取れます"));
    }
    let actual = final_path(file.as_raw_handle())?;
    if actual == root || !actual.starts_with(root) {
        return Err(denied("knowledge外にはアクセスできません"));
    }
    Ok(())
}

pub(super) fn error_message(error: &io::Error) -> String {
    // Cloud Files errors, including unavailable provider, timeout, aborted
    // fetch, network and authentication failure. No path or OS text is shown.
    match error.raw_os_error() {
        Some(362) => "クラウド同期プロバイダーが動作していません。起動状態を確認して再試行してください".to_owned(),
        Some(386) => "クラウド資料の認証に失敗しました。同期プロバイダーのサインイン状態を確認してください".to_owned(),
        Some(388) => "クラウド資料に接続できません。接続状態を確認し、必要な資料を端末に保持してから再試行してください".to_owned(),
        Some(426) => "クラウド資料の処理がタイムアウトしました。保持状態を確認して再試行してください".to_owned(),
        Some(377 | 387 | 389 | 393 | 398 | 404 | 475 | 4350) => {
            UNAVAILABLE.to_owned()
        }
        Some(5 | 395) => "ファイルを読み取る権限がありません。アクセス権を確認してください".to_owned(),
        Some(32 | 33 | 391 | 397) => {
            "ファイルが同期中か、他の処理でロックされています。処理の終了後に再試行してください"
                .to_owned()
        }
        _ if error.get_ref().is_some() => error.to_string(),
        _ => "ファイル情報を読み取れません。資料の保持状態やフォルダの存在を確認してください"
            .to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an explicitly created disposable OneDrive probe fixture"]
    fn disposable_onedrive_read_and_write_policies() {
        let fixture = PathBuf::from(
            std::env::var_os("MOGLEDGE_ONEDRIVE_PROBE_FIXTURE")
                .expect("supply only the fresh fixture returned by probe-onedrive-writes.ps1"),
        );
        let name = fixture.file_name().unwrap().to_str().unwrap();
        let suffix = name
            .strip_prefix("Mogledge-OneDrive-QA-")
            .expect("the provider root and existing knowledge are not probe fixtures");
        assert!(!suffix.is_empty());
        let guard = guard_path(&fixture).unwrap();
        assert!(guard.info().allowed());
        assert!(guard.info().is_dir());
        assert!(!guard.info().requires_download());
        // Wait for the provider to convert the new fixture before opting in.
        // Immediate ordinary metadata does not establish a Cloud Files result.
        assert!(
            !guard.info().is_ordinary(),
            "provider conversion is unverified"
        );
        let (root, dir) = super::super::open_root(&fixture).unwrap();
        assert!(super::super::validate_cache_path(&root).is_err());
        assert!(crate::write_fs::LockedDir::open(&dir, "").is_err());
        let source =
            super::super::read_source_with_identity(&root, &dir, "target/probe-moved.html")
                .unwrap();
        assert_eq!(
            source.data,
            b"<!doctype html><title>Disposable OneDrive QA 072</title><p>Synthetic fixture only</p>"
        );
        assert!(source.storage_identity.is_some());
        guard.revalidate().unwrap();
    }

    #[test]
    fn cache_preflight_rejects_network_device_and_relative_paths() {
        for path in [
            r"\\server\share\cache",
            r"\\?\UNC\server\share\cache",
            r"\\.\PhysicalDrive0",
            r"C:cache",
            r"C:\cache:stream",
            r"C:\cache\..\other",
        ] {
            assert!(super::super::validate_cache_path(Path::new(path)).is_err());
        }
        let cache = tempfile::tempdir().unwrap();
        let canonical = cache.path().canonicalize().unwrap();
        assert!(super::super::validate_cache_path(&canonical).is_ok());
        assert!(
            super::super::validate_cache_path(&canonical.join("missing").join("cache")).is_ok()
        );
    }

    #[test]
    fn ffi_metadata_layouts_match_windows_sdk() {
        assert_eq!(size_of::<AttributeTagInfo>(), 8);
        assert_eq!(size_of::<FileIdInfo>(), 24);
        assert_eq!(size_of::<FindData>(), 592);
    }

    #[test]
    fn placeholder_visibility_restores_thread_mode() {
        let set_mode = placeholder_mode_function().unwrap();
        // SAFETY: documented valid thread modes, restored before returning.
        let original = unsafe { set_mode(1) };
        assert!(original >= 0);
        {
            let _visibility = PlaceholderVisibility::expose().unwrap();
            // SAFETY: setting the same valid mode reveals the current mode.
            assert_eq!(unsafe { set_mode(2) }, 2);
        }
        // SAFETY: restores the original mode and verifies the guard restored 1.
        assert_eq!(unsafe { set_mode(original) }, 1);
    }

    #[test]
    fn retained_directory_scopes_restore_mode_after_success_error_and_unwind() {
        let set_mode = placeholder_mode_function().unwrap();
        // SAFETY: valid thread mode; an RAII guard restores the original even on panic.
        let original = unsafe { set_mode(1) };
        assert!(original >= 0);
        let _restore = PlaceholderVisibility {
            set_mode,
            previous: original,
            _thread_bound: std::marker::PhantomData,
        };
        let fixture = tempfile::tempdir().unwrap();
        let (_, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        let retained = crate::write_fs::LockedDir::open(&root, "")
            .unwrap()
            .into_retained();
        // SAFETY: setting mode 1 probes the mode restored by into_retained.
        assert_eq!(unsafe { set_mode(1) }, 1);
        {
            let scope = retained.scoped().unwrap();
            let nested = retained.scoped().unwrap();
            drop(nested);
            // SAFETY: setting the active mode probes nested scope restoration.
            assert_eq!(unsafe { set_mode(2) }, 2);
            scope.revalidate(fixture.path(), &root).unwrap();
        }
        // SAFETY: valid thread mode, restoring/probing the caller's mode.
        assert_eq!(unsafe { set_mode(1) }, 1);
        let result = (|| -> Result<(), String> {
            let scope = retained.scoped()?;
            scope.revalidate(&fixture.path().join("missing"), &root)
        })();
        assert!(result.is_err());
        // SAFETY: valid thread mode, probing error-path restoration.
        assert_eq!(unsafe { set_mode(1) }, 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _scope = retained.scoped().unwrap();
            panic!("synthetic scoped operation failure");
        }))
        .is_err());
        // SAFETY: valid thread mode, probing unwind restoration.
        assert_eq!(unsafe { set_mode(1) }, 1);
        std::thread::spawn(move || {
            // SAFETY: valid worker-thread mode, saved and restored by RAII.
            let previous = unsafe { set_mode(1) };
            assert!(previous >= 0);
            let _restore = PlaceholderVisibility {
                set_mode,
                previous,
                _thread_bound: std::marker::PhantomData,
            };
            {
                let _scope = retained.scoped().unwrap();
            }
            // SAFETY: probes restoration on the operation's executing thread.
            assert_eq!(unsafe { set_mode(1) }, 1);
        })
        .join()
        .unwrap();
    }

    #[test]
    fn named_root_with_trailing_separator_is_supported() {
        let temp = tempfile::tempdir().unwrap();
        let with_separator = PathBuf::from(format!("{}\\", temp.path().display()));
        let guard = guard_path(&with_separator).unwrap();
        assert!(guard.info().is_dir());
        let root = guard.canonical_path().unwrap();
        let dir = open_root_dir(&guard).unwrap();
        verify_root(&root, &dir).unwrap();
    }

    #[test]
    fn ordinary_profile_guard_allows_child_publication_but_pins_ancestors() {
        let fixture = tempfile::tempdir().unwrap();
        let ancestor = fixture.path().join("ancestor");
        let profile = ancestor.join("profile");
        fs::create_dir_all(&profile).unwrap();
        let guard = guard_profile_directory(&profile).unwrap();
        fs::write(profile.join("staging.json"), "{}").unwrap();
        fs::rename(profile.join("staging.json"), profile.join("settings.json")).unwrap();
        assert!(fs::rename(&profile, ancestor.join("moved-profile")).is_err());
        assert!(fs::rename(&ancestor, fixture.path().join("moved-ancestor")).is_err());
        guard.revalidate().unwrap();
        drop(guard);
        fs::rename(&profile, ancestor.join("moved-profile")).unwrap();
    }

    #[test]
    fn ordinary_profile_guard_rejects_a_file_leaf() {
        let fixture = tempfile::tempdir().unwrap();
        let file = fixture.path().join("profile.json");
        fs::write(&file, "{}").unwrap();
        assert!(guard_profile_directory(&file).is_err());
    }

    #[test]
    fn actual_handles_accept_local_files_and_reject_another_root() {
        let temp = tempfile::tempdir().unwrap();
        let root_guard = guard_path(temp.path()).unwrap();
        let root = root_guard.canonical_path().unwrap();
        let dir = open_root_dir(&root_guard).unwrap();
        verify_root(&root, &dir).unwrap();
        drop(root_guard);
        fs::write(root.join("page.html"), "local contents").unwrap();
        let other_leaf = root.join("other.html");
        fs::write(&other_leaf, "different contents").unwrap();
        let guard = guard_path(&root.join("page.html")).unwrap();
        assert!(!guard.info().requires_download());
        let mut options = OpenOptions::new();
        configure_read(&mut options);
        let mut file = dir.open_with("page.html", &options).unwrap();
        verify_read(&root, &dir, &file, &guard).unwrap();
        let mut contents = String::new();
        use std::io::Read;
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "local contents");
        let other = tempfile::tempdir().unwrap();
        let other_root = validate_root(other.path()).unwrap();
        let other_guard = guard_path(&other_root).unwrap();
        let other_dir = open_root_dir(&other_guard).unwrap();
        assert!(verify_read(&root, &other_dir, &file, &guard).is_err());
        let other_leaf_guard = guard_path(&other_leaf).unwrap();
        assert!(verify_read(&root, &dir, &file, &other_leaf_guard).is_err());
    }

    #[test]
    fn actual_read_handle_prevents_file_replacement_until_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("page.html");
        fs::write(&path, "local contents").unwrap();
        let root_guard = guard_path(temp.path()).unwrap();
        let root = root_guard.canonical_path().unwrap();
        let dir = open_root_dir(&root_guard).unwrap();
        drop(root_guard);
        let guard = guard_path(&path).unwrap();
        let mut options = OpenOptions::new();
        configure_read(&mut options);
        let file = dir.open_with("page.html", &options).unwrap();
        verify_read(&root, &dir, &file, &guard).unwrap();
        assert!(fs::rename(&path, temp.path().join("moved.html")).is_err());
        assert!(fs::write(&path, "changed contents").is_err());
        drop(file);
        drop(guard);
        fs::rename(&path, temp.path().join("moved.html")).unwrap();
    }

    #[test]
    fn ancestor_junction_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        fs::create_dir_all(target.join("nested")).unwrap();
        let link = temp.path().join("junction");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "cannot create disposable junction fixture"
        );
        assert!(!inspect_path(&link).unwrap().allowed());
        assert!(guard_path(&link.join("nested")).is_err());
        fs::remove_dir(&link).unwrap();
    }
}
