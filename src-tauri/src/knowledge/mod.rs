pub mod media;
#[cfg(any(test, all(target_os = "macos", feature = "macos-persistent-storage")))]
pub(crate) mod persistent_identity;
#[cfg(not(windows))]
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Serialize;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

#[cfg(any(windows, test))]
mod reparse;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use windows::CloudWriteOutcome;
#[cfg(windows)]
pub(crate) use windows::{create_cloud_folder, move_cloud_leaf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub relative_path: String,
    pub name: String,
    pub kind: &'static str,
    pub children: Vec<TreeNode>,
}

fn inspect_entry(path: &Path) -> io::Result<(bool, bool, bool)> {
    #[cfg(windows)]
    {
        let info = windows::inspect_path(path)?;
        Ok((!info.allowed(), info.is_dir(), !info.is_dir()))
    }
    #[cfg(not(windows))]
    {
        let meta = fs::symlink_metadata(path)?;
        Ok((meta.file_type().is_symlink(), meta.is_dir(), meta.is_file()))
    }
}

pub(crate) enum RootOpenFailure {
    Io(io::Error, String),
    Unsupported,
}
impl RootOpenFailure {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Io(_, message) => message.clone(),
            Self::Unsupported => {
                "通常のフォルダを選択してください（リンクは利用できません）".into()
            }
        }
    }
}
pub fn open_root(path: &Path) -> Result<(PathBuf, Arc<Dir>), String> {
    open_root_checked(path).map_err(|error| error.message())
}
// Preserve OS error kind/code for startup recovery without changing callers'
// existing guarded-root checks or their human-readable errors.
pub(crate) fn open_root_checked(path: &Path) -> Result<(PathBuf, Arc<Dir>), RootOpenFailure> {
    #[cfg(windows)]
    {
        let root_io = |error: io::Error| {
            let message = windows::error_message(&error);
            RootOpenFailure::Io(error, message)
        };
        let guard = windows::guard_path(path).map_err(root_io)?;
        if !guard.info().is_dir() {
            return Err(RootOpenFailure::Unsupported);
        }
        windows::ensure_local(guard.info()).map_err(root_io)?;
        let canonical = guard.canonical_path().map_err(root_io)?;
        let dir = windows::open_root_dir(&guard).map_err(root_io)?;
        windows::verify_root(&canonical, &dir).map_err(root_io)?;
        Ok((canonical, Arc::new(dir)))
    }
    #[cfg(not(windows))]
    {
        let meta = fs::symlink_metadata(path)
            .map_err(|error| RootOpenFailure::Io(error, "フォルダを読み取れません".into()))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(RootOpenFailure::Unsupported);
        }
        let canonical = path
            .canonicalize()
            .map_err(|error| RootOpenFailure::Io(error, "フォルダを解決できません".into()))?;
        let dir = Dir::open_ambient_dir(&canonical, ambient_authority())
            .map_err(|error| RootOpenFailure::Io(error, "フォルダを開けません".into()))?;
        Ok((canonical, Arc::new(dir)))
    }
}

// Compare directory handles, not names: a root can be replaced at the same path.
pub fn same_directory(a: &Dir, b: &Dir) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let a = a
            .dir_metadata()
            .map_err(|_| "フォルダ情報を読み取れません")?;
        let b = b
            .dir_metadata()
            .map_err(|_| "フォルダ情報を読み取れません")?;
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(windows)]
    {
        use ::windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
        };
        use std::os::windows::io::AsRawHandle;
        fn identity(dir: &Dir) -> Result<(u64, [u8; 16]), String> {
            let file = dir
                .try_clone()
                .map_err(|_| "フォルダ情報を読み取れません")?
                .into_std_file();
            let mut info = FILE_ID_INFO::default();
            // A 64-bit file index is not unique on ReFS. Keep the cloned handle
            // alive and provide the exact FILE_ID_INFO buffer size to Win32.
            unsafe {
                GetFileInformationByHandleEx(
                    HANDLE(file.as_raw_handle()),
                    FileIdInfo,
                    (&mut info as *mut FILE_ID_INFO).cast(),
                    std::mem::size_of::<FILE_ID_INFO>() as u32,
                )
            }
            .map_err(|_| "フォルダ情報を読み取れません")?;
            Ok((info.VolumeSerialNumber, info.FileId.Identifier))
        }
        Ok(identity(a)? == identity(b)?)
    }
}

pub fn validate_relative(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains(['\\', ':', '\0']) {
        return Err("無効な相対パスです".into());
    }
    let mut output = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part.starts_with('.') {
            return Err("隠しファイルや親ディレクトリにはアクセスできません".into());
        }
        #[cfg(windows)]
        if part.ends_with([' ', '.']) || windows::is_device_name(part) {
            return Err("無効な相対パスです".into());
        }
        if !matches!(
            Path::new(part).components().next(),
            Some(Component::Normal(_))
        ) {
            return Err("無効な相対パスです".into());
        }
        output.push(part);
    }
    Ok(output)
}

// The capability directory performs the actual open beneath the selected root.
// Path checks also reject in-root symlinks/junctions, rather than following them.
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = validate_relative(relative)?;
    #[cfg(windows)]
    {
        let guard =
            windows::guard_path(&root.join(&rel)).map_err(|e| windows::error_message(&e))?;
        let canonical = guard
            .canonical_path()
            .map_err(|e| windows::error_message(&e))?;
        if !canonical.starts_with(root) {
            return Err("knowledge外にはアクセスできません".into());
        }
        Ok(rel)
    }
    #[cfg(not(windows))]
    {
        let mut path = root.to_path_buf();
        for part in rel.components() {
            path.push(part);
            let meta = fs::symlink_metadata(&path)
                .map_err(|_| "ファイルが見つからないか、読み取れません".to_owned())?;
            if meta.file_type().is_symlink() {
                return Err("リンク先へのアクセスは禁止されています".into());
            }
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| "ファイルを解決できません".to_owned())?;
        if !canonical.starts_with(root) {
            return Err("knowledge外にはアクセスできません".into());
        }
        Ok(rel)
    }
}

pub struct SourceRead {
    pub data: Vec<u8>,
    pub modified_ns: Option<String>,
    pub storage_identity: Option<String>,
}

// Cached paths are checked without loading or hydrating document bodies.
/// Thread-bound scope retained across native write metadata and directory
/// enumeration. Compatibility mode must never disguise Cloud Files as local.
#[cfg(windows)]
pub(crate) struct LocalMetadataScope {
    _visibility: windows::PlaceholderVisibility,
}

#[cfg(windows)]
pub(crate) fn local_metadata_scope() -> io::Result<LocalMetadataScope> {
    Ok(LocalMetadataScope {
        _visibility: windows::PlaceholderVisibility::expose()?,
    })
}

/// Write operations require every ancestor and the capability handle itself to
/// remain ordinary. This preflight does not lock a renameable source directory.
#[cfg(windows)]
pub(crate) fn ordinary_directory_path(dir: &Dir) -> io::Result<PathBuf> {
    use std::os::windows::io::AsRawHandle;
    let _scope = local_metadata_scope()?;
    let path = windows::final_path(dir.as_raw_handle())?;
    validate_cache_path(&path)?;
    let info = windows::handle_info(dir.as_raw_handle())?;
    if !info.is_ordinary() || !info.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Write operations require ordinary local directories",
        ));
    }
    Ok(path)
}

/// Attribute-only, no-recall entry inspection after ordinary parent preflight.
/// Never use capability metadata on a possibly cloud-backed entry first.
#[cfg(windows)]
pub(crate) fn ordinary_entry_is_directory(dir: &Dir, name: impl AsRef<Path>) -> io::Result<bool> {
    let _scope = local_metadata_scope()?;
    let name = name.as_ref();
    if name.components().count() != 1
        || !matches!(name.components().next(), Some(Component::Normal(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid entry name",
        ));
    }
    let relative = name
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid entry name"))?;
    // Recursive mutation preflight also inspects ordinary dotfiles. The entry
    // is still a single normal leaf; user-facing paths reject hidden components
    // before reaching this metadata helper.
    validate_relative(relative.trim_start_matches('.'))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid entry name"))?;
    let path = ordinary_directory_path(dir)?.join(name);
    validate_cache_path(&path)?;
    let info = windows::inspect_path(&path)?;
    if !info.is_ordinary() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Write operations require ordinary local entries",
        ));
    }
    Ok(info.is_dir())
}

/// The derived database uses only ordinary local paths, even when document
/// roots allow resident Cloud Files. Inspect before any SQLite/content open.
#[cfg(windows)]
pub fn validate_cache_path(path: &Path) -> std::io::Result<()> {
    let _scope = local_metadata_scope()?;
    windows::validate_local_path(path)?;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Index cache must use an absolute local path",
        ));
    }
    let ancestors: Vec<_> = path
        .ancestors()
        .filter(|ancestor| ancestor.has_root())
        .collect();
    for ancestor in ancestors.iter().rev() {
        match windows::inspect_path(ancestor) {
            Ok(info) if !info.is_ordinary() || (*ancestor != path && !info.is_dir()) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Index cache must use ordinary local paths",
                ));
            }
            Ok(_) => {}
            // Descendants of a missing ordinary path cannot exist; creation is
            // allowed only after all existing ancestors passed exposed checks.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

pub fn validate_cached_path(root: &Path, dir: &Dir, relative: &str) -> Result<(), String> {
    let rel = validate_relative(relative)?;
    if !is_html(relative) {
        return Err("HTML以外の検索結果は開けません".into());
    }
    #[cfg(windows)]
    {
        let guard =
            windows::guard_path(&root.join(rel)).map_err(|error| windows::error_message(&error))?;
        windows::ensure_local(guard.info()).map_err(|error| windows::error_message(&error))?;
        windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))?;
        if guard.info().is_dir()
            || !guard
                .canonical_path()
                .map_err(|error| windows::error_message(&error))?
                .starts_with(root)
        {
            return Err("検索結果のファイルが変更されました".into());
        }
        guard
            .revalidate()
            .map_err(|error| windows::error_message(&error))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let (_, current) = open_root(root)?;
        if !same_directory(dir, &current)? {
            return Err("knowledgeフォルダが置き換えられました。再走査してください".into());
        }
        resolve(root, relative)?;
        let metadata = fs::symlink_metadata(root.join(rel))
            .map_err(|_| "検索結果のファイルが見つかりません")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("検索結果のファイルが変更されました".into());
        }
        Ok(())
    }
}

/// Folder path actions share the resident Cloud Files read boundary, without
/// granting write access or weakening ordinary-only mutation preflight.
#[cfg(windows)]
pub(crate) struct ReadOnlyDirectoryGuard(windows::PathGuard);

#[cfg(unix)]
pub(crate) struct ReadOnlyDirectoryGuard {
    chain: Vec<Dir>,
    relative: String,
}

#[cfg(unix)]
impl ReadOnlyDirectoryGuard {
    pub(crate) fn open(root: &Path, dir: &Dir, relative: &str) -> Result<Self, String> {
        validate_relative(relative)?;
        Self::open_parent(root, dir, relative)
    }

    // Only an internally resolved leaf parent may denote the selected root.
    fn open_parent(root: &Path, dir: &Dir, relative: &str) -> Result<Self, String> {
        if !relative.is_empty() {
            validate_relative(relative)?;
        }
        let (_, current) = open_root(root)?;
        if !same_directory(dir, &current)? {
            return Err("knowledgeフォルダーが置き換えられました".into());
        }
        let mut chain = vec![dir.try_clone().map_err(|_| "フォルダーを開けません")?];
        for part in relative.split('/').filter(|part| !part.is_empty()) {
            // Reuse the handle-relative, read-only NOFOLLOW open. Mutation name
            // rules would reject existing Unix folders that document reads allow.
            let file = crate::write_fs::open_at(chain.last().unwrap(), part, true, false, false)
                .map_err(|_| "フォルダーを開けません。リンクやアクセス権を確認してください")?;
            chain.push(Dir::from_std_file(file));
        }
        Ok(Self {
            chain,
            relative: relative.into(),
        })
    }

    pub(crate) fn revalidate(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        let fresh = Self::open_parent(root, dir, &self.relative)?;
        // Compare every retained ancestor, including root, even if the final
        // directory was moved back beneath a replacement ancestor.
        for (old, new) in self.chain.iter().zip(&fresh.chain) {
            if !same_directory(old, new)? {
                return Err("フォルダーが変更されました。再走査してください".into());
            }
        }
        Ok(())
    }
}

/// Retains the explicit selected root through dispatch without accepting an
/// empty document-relative path. Windows also protects every root ancestor.
#[cfg(windows)]
pub(crate) struct RootReferenceGuard(windows::PathGuard);

#[cfg(unix)]
pub(crate) struct RootReferenceGuard(Dir);

impl RootReferenceGuard {
    pub(crate) fn open(root: &Path, dir: &Dir) -> Result<Self, String> {
        Self::open_inner(root, dir, false)
    }

    pub(crate) fn open_profile_write(root: &Path, dir: &Dir) -> Result<Self, String> {
        Self::open_inner(root, dir, true)
    }

    fn open_inner(root: &Path, dir: &Dir, ordinary_profile: bool) -> Result<Self, String> {
        let (current_root, current) = open_root(root)?;
        if current_root != root || !same_directory(dir, &current)? {
            return Err("knowledgeフォルダーが置き換えられました。再選択してください".into());
        }
        #[cfg(windows)]
        {
            let guard = if ordinary_profile {
                windows::guard_profile_directory(root)
            } else {
                windows::guard_path(root)
            }
            .map_err(|error| windows::error_message(&error))?;
            windows::ensure_local(guard.info()).map_err(|error| windows::error_message(&error))?;
            windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))?;
            if !guard.info().is_dir()
                || guard
                    .canonical_path()
                    .map_err(|error| windows::error_message(&error))?
                    != root
            {
                return Err("knowledgeフォルダーが変更されました。再選択してください".into());
            }
            Ok(Self(guard))
        }
        #[cfg(unix)]
        {
            let _ = ordinary_profile;
            Ok(Self(
                current.try_clone().map_err(|_| "ルートを確認できません")?,
            ))
        }
    }

    pub(crate) fn revalidate(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        let fresh = Self::open(root, dir)?;
        #[cfg(windows)]
        {
            let _ = fresh;
            self.0
                .revalidate()
                .map_err(|error| windows::error_message(&error))
        }
        #[cfg(unix)]
        {
            if !same_directory(&self.0, &fresh.0)? {
                return Err("knowledgeフォルダーが変更されました。再選択してください".into());
            }
            Ok(())
        }
    }
}

/// Retains the selected leaf and every ancestor until a path-reference dispatch
/// completes. Windows handles deny delete sharing and never read contents.
#[cfg(windows)]
pub(crate) struct PathReferenceGuard(windows::PathGuard);

#[cfg(unix)]
pub(crate) struct PathReferenceGuard {
    parent: ReadOnlyDirectoryGuard,
    leaf: fs::File,
    relative: String,
    folder: bool,
}

impl PathReferenceGuard {
    pub(crate) fn open(
        root: &Path,
        dir: &Dir,
        relative: &str,
        folder: bool,
    ) -> Result<Self, String> {
        let path = validate_relative(relative)?;
        #[cfg(windows)]
        {
            let target = root.join(path);
            let mut guard = if folder {
                windows::guard_path(&target)
            } else {
                windows::guard_reference_file(&target)
            }
            .map_err(|error| windows::error_message(&error))?;
            windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))?;
            windows::ensure_local(guard.info()).map_err(|error| windows::error_message(&error))?;
            if guard.info().is_dir() != folder
                || !guard
                    .canonical_path()
                    .map_err(|error| windows::error_message(&error))?
                    .starts_with(root)
            {
                return Err("対象が変更されました。再走査してください".into());
            }
            if !folder {
                guard
                    .retain_reference_file()
                    .map_err(|error| windows::error_message(&error))?;
            }
            Ok(Self(guard))
        }
        #[cfg(unix)]
        {
            let _ = path;
            let (parent, name) = crate::tree_mutations::split(relative);
            let parent = ReadOnlyDirectoryGuard::open_parent(root, dir, parent)?;
            let leaf =
                crate::write_fs::open_at(parent.chain.last().unwrap(), name, folder, false, false)
                    .map_err(|_| "対象を確認できません。リンクやアクセス権を確認してください")?;
            Ok(Self {
                parent,
                leaf,
                relative: relative.into(),
                folder,
            })
        }
    }

    pub(crate) fn revalidate(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.0
                .revalidate()
                .map_err(|error| windows::error_message(&error))?;
            windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))
        }
        #[cfg(unix)]
        {
            self.parent.revalidate(root, dir)?;
            let fresh = Self::open(root, dir, &self.relative, self.folder)?;
            if crate::write_fs::identity(&self.leaf).map_err(|_| "対象を確認できません")?
                != crate::write_fs::identity(&fresh.leaf).map_err(|_| "対象を確認できません")?
            {
                return Err("対象が変更されました。再走査してください".into());
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
impl ReadOnlyDirectoryGuard {
    pub(crate) fn open(root: &Path, dir: &Dir, relative: &str) -> Result<Self, String> {
        let relative = validate_relative(relative)?;
        let guard = windows::guard_path(&root.join(relative))
            .map_err(|error| windows::error_message(&error))?;
        windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))?;
        windows::ensure_local(guard.info()).map_err(|error| windows::error_message(&error))?;
        if !guard.info().is_dir()
            || !guard
                .canonical_path()
                .map_err(|error| windows::error_message(&error))?
                .starts_with(root)
        {
            return Err("フォルダーが変更されました。再走査してください".into());
        }
        Ok(Self(guard))
    }

    pub(crate) fn revalidate(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        // Retain no-delete-sharing handles through OS dispatch, not merely the
        // metadata inspection that preceded it. Unknown tags/recall stay denied.
        self.0
            .revalidate()
            .map_err(|error| windows::error_message(&error))?;
        windows::verify_root(root, dir).map_err(|error| windows::error_message(&error))
    }
}

pub const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;

impl ReadOnlyDirectoryGuard {
    pub(crate) fn storage_identity(&self) -> io::Result<String> {
        #[cfg(unix)]
        {
            storage_root_identity(self.chain.last().unwrap())
        }
        #[cfg(windows)]
        {
            // Use the retained read guard's supported local/provider boundary;
            // display navigation grants no ordinary-only writer authority.
            let dir = windows::open_root_dir(&self.0)?;
            storage_root_identity(&dir)
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadError {
    ResourceBusy,
    Failed(String),
}
impl From<String> for ReadError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}
impl From<&str> for ReadError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_owned())
    }
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ResourceBusy => formatter.write_str("ResourceBusy"),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

pub fn read(root: &Path, dir: &Dir, relative: &str) -> Result<Vec<u8>, String> {
    read_source(root, dir, relative).map(|source| source.data)
}

// Bytes and metadata use the same capability file handle while the Windows
// placeholder exposure/no-recall/path identity guards remain alive throughout.
pub fn read_source(root: &Path, dir: &Dir, relative: &str) -> Result<SourceRead, String> {
    source(root, dir, relative, true, false, &mut |_| Ok(())).map_err(|error| error.to_string())
}

pub fn read_source_with_identity(
    root: &Path,
    dir: &Dir,
    relative: &str,
) -> Result<SourceRead, String> {
    source(root, dir, relative, true, true, &mut |_| Ok(())).map_err(|error| error.to_string())
}

/// Reserve old plus new allocation capacities before each allocation, then
/// report the retained capacity after the old buffer has been freed.
pub fn read_source_budgeted(
    root: &Path,
    dir: &Dir,
    relative: &str,
    identity: bool,
    mut reserve_capacity: impl FnMut(usize) -> Result<(), ReadError>,
) -> Result<SourceRead, ReadError> {
    source(root, dir, relative, true, identity, &mut reserve_capacity)
}

/// The same guarded open as document reads, without reading document contents.
pub fn storage_identity(root: &Path, dir: &Dir, relative: &str) -> Result<String, String> {
    source(root, dir, relative, false, true, &mut |_| Ok(()))
        .map_err(|error| error.to_string())?
        .storage_identity
        .ok_or_else(|| "StorageIdentityUnavailable".into())
}

/// Root-independent object proof, used only to associate retained legacy rows.
/// Document grants continue to use the existing root-bound physical identity.
pub(crate) fn object_identity(root: &Path, dir: &Dir, relative: &str) -> Result<String, String> {
    let relative_path = validate_relative(relative)?;
    // LockedDir takes canonical API paths, not Windows PathBuf separators.
    let parent_relative = relative.rsplit_once('/').map_or("", |(parent, _)| parent);
    let parent = crate::write_fs::LockedDir::open(dir, parent_relative)?;
    parent.revalidate(
        root,
        &std::sync::Arc::new(dir.try_clone().map_err(|_| "StorageUnavailable")?),
    )?;
    let file = crate::write_fs::open_subtree_entry(
        parent.dir(),
        relative_path
            .file_name()
            .ok_or("StorageUnavailable")?
            .to_str()
            .ok_or("StorageUnavailable")?,
        false,
    )
    .map_err(|_| "StorageUnavailable")?;
    #[cfg(all(target_os = "macos", feature = "macos-persistent-storage"))]
    let identity = persistent_identity::root(
        persistent_identity::opened_object(&file).map_err(|_| "StorageUnavailable")?,
    )
    .map_err(|_| "StorageUnavailable")?;
    #[cfg(not(all(target_os = "macos", feature = "macos-persistent-storage")))]
    let identity = legacy_identity_hash(
        b"mogledge-file-object-v1",
        &[legacy_identity_parts(&file).map_err(|_| "StorageUnavailable")?],
    );
    Ok(identity)
}

fn source(
    root: &Path,
    dir: &Dir,
    relative: &str,
    read_body: bool,
    identity: bool,
    reserve_capacity: &mut impl FnMut(usize) -> Result<(), ReadError>,
) -> Result<SourceRead, ReadError> {
    // Preserve retained-tab root identity checks. open_root uses the same
    // no-recall guards on Windows; the handles, rather than path names, compare.
    let (_, current) = open_root(root)?;
    if !same_directory(dir, &current)? {
        return Err("knowledgeフォルダが置き換えられました。再走査してください".into());
    }
    #[cfg(windows)]
    let rel = validate_relative(relative)?;
    #[cfg(windows)]
    let _guard = windows::guard_path(&root.join(&rel)).map_err(|e| windows::error_message(&e))?;
    #[cfg(windows)]
    windows::ensure_local(_guard.info()).map_err(|e| windows::error_message(&e))?;
    #[cfg(windows)]
    if !_guard
        .canonical_path()
        .map_err(|e| windows::error_message(&e))?
        .starts_with(root)
    {
        return Err("knowledge外にはアクセスできません".into());
    }
    #[cfg(not(windows))]
    let rel = resolve(root, relative)?;
    // A metadata-only identity request must not wait for a FIFO writer either.
    // NONBLOCK also covers replacement after this preflight; the opened handle
    // below must still prove it is a regular file before any content read.
    #[cfg(unix)]
    if !dir.symlink_metadata(&rel).map_err(read_error)?.is_file() {
        return Err("通常のファイルのみ読み取れます".into());
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOFOLLOW).bits() as i32,
        );
    }
    #[cfg(windows)]
    windows::configure_read(&mut options);
    let mut file = dir.open_with(&rel, &options).map_err(read_error)?;
    #[cfg(windows)]
    windows::verify_read(root, dir, &file, &_guard).map_err(|e| windows::error_message(&e))?;
    let metadata = file
        .metadata()
        .map_err(|_| "ファイル情報を読み取れません".to_owned())?;
    if !metadata.is_file() {
        return Err("通常のファイルのみ読み取れます".into());
    }
    let data = if read_body {
        read_bounded(&mut file, metadata.len(), reserve_capacity)?
    } else {
        Vec::new()
    };
    #[cfg(windows)]
    windows::verify_read(root, dir, &file, &_guard).map_err(|e| windows::error_message(&e))?;
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string());
    let storage_identity = if identity {
        let file = file.into_std();
        document_identity(dir, &file).ok()
    } else {
        None
    };
    Ok(SourceRead {
        data,
        modified_ns,
        storage_identity,
    })
}

// Metadata is only an allocation hint. Probe one extra byte from the same
// guarded handle, rejecting growth before extending the Vec past 32 MiB.
// Exact growth also avoids read_to_end's geometric over-allocation at the cap.
fn read_bounded(
    mut reader: impl std::io::Read,
    hint: u64,
    reserve_capacity: &mut impl FnMut(usize) -> Result<(), ReadError>,
) -> Result<Vec<u8>, ReadError> {
    let initial_capacity = hint.min(MAX_SOURCE_BYTES as u64) as usize;
    reserve_capacity(initial_capacity)?;
    let mut data = Vec::with_capacity(initial_capacity);
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let remaining = MAX_SOURCE_BYTES - data.len();
        let length = chunk.len().min(remaining + 1);
        let count = match reader.read(&mut chunk[..length]) {
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(read_error(error).into()),
        };
        if count == 0 {
            return Ok(data);
        }
        if count > remaining {
            return Err("ファイルは32MB以下にしてください".into());
        }
        if data.capacity() - data.len() < count {
            let capacity = data
                .capacity()
                .max(chunk.len())
                .saturating_mul(2)
                .max(data.len() + count)
                .min(MAX_SOURCE_BYTES);
            // Allocate explicitly: budget includes old+new even when a system
            // realloc could grow in place. Never wait while retaining a buffer.
            reserve_capacity(data.capacity() + capacity)?;
            let mut expanded = Vec::with_capacity(capacity);
            expanded.extend_from_slice(&data);
            drop(data);
            data = expanded;
            reserve_capacity(data.capacity())?;
        }
        data.extend_from_slice(&chunk[..count]);
    }
}

pub(crate) fn document_identity(dir: &Dir, file: &fs::File) -> io::Result<String> {
    #[cfg(all(target_os = "macos", feature = "macos-persistent-storage"))]
    {
        let root = dir.try_clone()?.into_std_file();
        persistent_identity::document(
            persistent_identity::opened_object(&root)?,
            persistent_identity::opened_object(file)?,
        )
    }
    #[cfg(not(all(target_os = "macos", feature = "macos-persistent-storage")))]
    {
        let root = dir.try_clone()?.into_std_file();
        Ok(legacy_identity_hash(
            b"my-knowledge-document-state-v1",
            &[legacy_identity_parts(&root)?, legacy_identity_parts(file)?],
        ))
    }
}
pub fn storage_root_identity(dir: &Dir) -> io::Result<String> {
    #[cfg(all(target_os = "macos", feature = "macos-persistent-storage"))]
    {
        let root = dir.try_clone()?.into_std_file();
        persistent_identity::root(persistent_identity::opened_object(&root)?)
    }
    #[cfg(not(all(target_os = "macos", feature = "macos-persistent-storage")))]
    {
        let root = dir.try_clone()?.into_std_file();
        Ok(legacy_identity_hash(
            b"my-knowledge-state-root-v1",
            &[legacy_identity_parts(&root)?],
        ))
    }
}
#[cfg(not(all(target_os = "macos", feature = "macos-persistent-storage")))]
fn legacy_identity_parts(handle: &fs::File) -> io::Result<(u64, u128, u128)> {
    let (volume, id) = crate::write_fs::identity(handle)?;
    // No birth-time fallback: re-used inode/FileIDs must not inherit state.
    let created = handle
        .metadata()?
        .created()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok((volume, id, created))
}

#[cfg(any(
    test,
    not(all(target_os = "macos", feature = "macos-persistent-storage"))
))]
fn legacy_identity_hash(domain: &[u8], objects: &[(u64, u128, u128)]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(domain);
    for (volume, id, created) in objects {
        hash.update(volume.to_le_bytes());
        hash.update(id.to_le_bytes());
        hash.update(created.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn read_error(error: io::Error) -> String {
    #[cfg(windows)]
    return windows::error_message(&error);
    #[cfg(not(windows))]
    match error.kind() {
        io::ErrorKind::PermissionDenied => "ファイルを読み取る権限がありません".into(),
        io::ErrorKind::NotFound => "ファイルが見つかりません".into(),
        _ => "ファイルを開けないか、読み取れません".into(),
    }
}

pub fn is_html(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm")
    )
}

pub fn mime(path: &str) -> Option<&'static str> {
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

pub fn scan(root: &Path) -> Result<Vec<TreeNode>, String> {
    fn walk(root: &Path, current: &Path) -> io::Result<Vec<TreeNode>> {
        // Guard directory enumeration against replacement and never read file bodies.
        #[cfg(windows)]
        let _guard = windows::guard_path(current)?;
        #[cfg(windows)]
        windows::ensure_local(_guard.info())?;
        let mut nodes = Vec::new();
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let (blocked, is_dir, is_file) = match inspect_entry(&path) {
                Ok(meta) => meta,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if blocked {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .components()
                .map(|v| v.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if is_dir {
                nodes.push(TreeNode {
                    relative_path: relative,
                    name: name.into(),
                    kind: "folder",
                    children: walk(root, &path)?,
                });
            } else if is_file && is_html(name) {
                nodes.push(TreeNode {
                    relative_path: relative,
                    name: name.into(),
                    kind: "html",
                    children: Vec::new(),
                });
            }
        }
        nodes.sort_by(|a, b| {
            (a.kind != "folder")
                .cmp(&(b.kind != "folder"))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });
        #[cfg(windows)]
        _guard.revalidate()?;
        Ok(nodes)
    }
    walk(root, root).map_err(|error| {
        #[cfg(windows)]
        return windows::error_message(&error);
        #[cfg(not(windows))]
        {
            let _ = error;
            "knowledgeの走査に失敗しました。権限やフォルダの存在を確認してください".into()
        }
    })
}

pub fn contains(nodes: &[TreeNode], path: &str) -> bool {
    nodes.iter().any(|node| {
        (node.kind == "html" && node.relative_path == path) || contains(&node.children, path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_read_probes_growth_and_caps_capacity_even_with_stale_metadata() {
        use std::io::Read;
        let data = read_bounded(
            std::io::repeat(7).take(MAX_SOURCE_BYTES as u64),
            1,
            &mut |_| Ok(()),
        )
        .unwrap();
        assert_eq!(data.len(), MAX_SOURCE_BYTES);
        assert_eq!(data.capacity(), MAX_SOURCE_BYTES);
        drop(data);
        assert_eq!(
            read_bounded(
                std::io::repeat(7).take(MAX_SOURCE_BYTES as u64 + 1),
                0,
                &mut |_| Ok(())
            )
            .unwrap_err(),
            ReadError::Failed("ファイルは32MB以下にしてください".into())
        );
        let data = read_bounded(std::io::Cursor::new(b"small"), u64::MAX, &mut |_| Ok(())).unwrap();
        assert_eq!(data, b"small");
        assert_eq!(data.capacity(), MAX_SOURCE_BYTES);
    }
    #[test]
    fn bounded_read_reserves_overlap_and_stops_before_unbudgeted_growth() {
        use std::io::Read;
        let mut reservations = Vec::new();
        let data = read_bounded(
            std::io::repeat(7).take(192 * 1024),
            64 * 1024,
            &mut |capacity| {
                reservations.push(capacity);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(data.len(), 192 * 1024);
        assert_eq!(
            reservations,
            [64 * 1024, 192 * 1024, 128 * 1024, 384 * 1024, 256 * 1024]
        );

        let mut reader = std::io::Cursor::new(vec![7; 192 * 1024]);
        let error = read_bounded(&mut reader, 64 * 1024, &mut |capacity| {
            if capacity > 128 * 1024 {
                Err(ReadError::ResourceBusy)
            } else {
                Ok(())
            }
        })
        .unwrap_err();
        assert_eq!(error, ReadError::ResourceBusy);
        // Only the existing buffer and next scratch chunk were read; growth
        // needing old+new capacity fails before allocation or further I/O.
        assert_eq!(reader.position(), 128 * 1024);
        let mut reader = std::io::Cursor::new(b"small");
        assert_eq!(
            read_bounded(&mut reader, 5, &mut |_| Err(ReadError::ResourceBusy)),
            Err(ReadError::ResourceBusy)
        );
        assert_eq!(reader.position(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn source_identity_and_read_reject_fifo_without_reserving_body() {
        let root = tempfile::tempdir().unwrap();
        crate::test_fixtures::create_fifo(&root.path().join("pipe.html"), 0o600).unwrap();
        let (root_path, dir) = open_root(root.path()).unwrap();
        let started = std::time::Instant::now();
        assert!(storage_identity(&root_path, &dir, "pipe.html").is_err());
        let mut reserved = false;
        assert!(
            read_source_budgeted(&root_path, &dir, "pipe.html", false, |_| {
                reserved = true;
                Ok(())
            })
            .is_err()
        );
        assert!(!reserved);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn traversal_is_rejected() {
        for path in [
            "../secret.html",
            "/secret.html",
            "x/../a.html",
            "C:/a.html",
            "a\\b.html",
            ".git/config",
            "a//b.html",
        ] {
            assert!(validate_relative(path).is_err(), "{path}");
        }
        assert!(validate_relative("日本語の資料/with space.HTML").is_ok());
    }
    #[test]
    fn tree_is_filtered_and_sorted() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("Folder")).unwrap();
        fs::create_dir(tmp.path().join(".hidden")).unwrap();
        fs::write(tmp.path().join("z.HTML"), "").unwrap();
        fs::write(tmp.path().join("a.htm"), "").unwrap();
        fs::write(tmp.path().join("style.css"), "").unwrap();
        let nodes = scan(tmp.path()).unwrap();
        assert_eq!(
            nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
            ["Folder", "a.htm", "z.HTML"]
        );
    }
    #[test]
    fn capability_reads_relative_assets_and_rejects_directories_and_large_files() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("資料")).unwrap();
        fs::write(tmp.path().join("資料/index.html"), "<h1>資料</h1>").unwrap();
        fs::write(tmp.path().join("資料/data.json"), "{\"value\":1}").unwrap();
        let (root, dir) = open_root(tmp.path()).unwrap();
        assert_eq!(
            read(&root, &dir, "資料/data.json").unwrap(),
            b"{\"value\":1}"
        );
        assert!(read(&root, &dir, "資料").is_err());
        assert!(read(&root, &dir, "missing.html").is_err());
        let large = fs::File::create(tmp.path().join("large.html")).unwrap();
        large.set_len(32 * 1024 * 1024 + 1).unwrap();
        // Windows guarded reads exclude concurrent write handles. Finish the
        // fixture write before checking the independent source-size limit.
        drop(large);
        assert_eq!(
            read(&root, &dir, "large.html").unwrap_err(),
            "ファイルは32MB以下にしてください"
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_are_rejected_at_root_scan_resolve_and_read() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("index.html"), "inside").unwrap();
        fs::write(outside.path().join("secret.html"), "outside").unwrap();
        symlink(outside.path(), tmp.path().join("linked")).unwrap();
        symlink(tmp.path().join("index.html"), tmp.path().join("alias.html")).unwrap();
        symlink(
            outside.path().join("secret.html"),
            tmp.path().join("secret.html"),
        )
        .unwrap();
        assert!(open_root(&tmp.path().join("linked")).is_err());
        let (root, dir) = open_root(tmp.path()).unwrap();
        let nodes = scan(&root).unwrap();
        assert_eq!(
            nodes.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(),
            ["index.html"]
        );
        for path in ["linked/secret.html", "alias.html", "secret.html"] {
            assert!(resolve(&root, path).is_err());
            assert!(read(&root, &dir, path).is_err());
        }
        // Replacing a formerly ordinary directory must not expose the outside target.
        fs::create_dir(tmp.path().join("replace")).unwrap();
        fs::write(tmp.path().join("replace/page.html"), "safe").unwrap();
        assert!(read(&root, &dir, "replace/page.html").is_ok());
        fs::remove_dir_all(tmp.path().join("replace")).unwrap();
        symlink(outside.path(), tmp.path().join("replace")).unwrap();
        assert!(read(&root, &dir, "replace/secret.html").is_err());
    }

    #[test]
    fn read_only_directory_guard_validates_target_kind_root_and_relative_path() {
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir(fixture.path().join("folder")).unwrap();
        fs::write(fixture.path().join("page.html"), "fixture").unwrap();
        let (root, dir) = open_root(fixture.path()).unwrap();
        let guard = ReadOnlyDirectoryGuard::open(&root, &dir, "folder").unwrap();
        guard.revalidate(&root, &dir).unwrap();
        for relative in [
            "",
            "/folder",
            "../folder",
            "folder/../folder",
            "folder//child",
            "folder\\child",
            "C:/folder",
            ".hidden",
            "missing",
            "page.html",
        ] {
            assert!(ReadOnlyDirectoryGuard::open(&root, &dir, relative).is_err());
        }
        let unrelated = tempfile::tempdir().unwrap();
        let (_, unrelated_dir) = open_root(unrelated.path()).unwrap();
        assert!(ReadOnlyDirectoryGuard::open(&root, &unrelated_dir, "folder").is_err());
        assert!(guard.revalidate(&root, &unrelated_dir).is_err());
        assert_eq!(fs::read(root.join("page.html")).unwrap(), b"fixture");
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_guard_rejects_links_and_replaced_ancestors() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir_all(fixture.path().join("Q?/child.")).unwrap();
        let (root, dir) = open_root(fixture.path()).unwrap();
        let guard = ReadOnlyDirectoryGuard::open(&root, &dir, "Q?/child.").unwrap();
        guard.revalidate(&root, &dir).unwrap();

        // The target retains its identity, but replacing its ancestor must fail.
        fs::rename(root.join("Q?"), root.join("original")).unwrap();
        fs::create_dir(root.join("Q?")).unwrap();
        fs::rename(root.join("original/child."), root.join("Q?/child.")).unwrap();
        assert!(guard.revalidate(&root, &dir).is_err());
        let target_guard = ReadOnlyDirectoryGuard::open(&root, &dir, "Q?/child.").unwrap();
        fs::rename(root.join("Q?/child."), root.join("original/child.")).unwrap();
        fs::create_dir(root.join("Q?/child.")).unwrap();
        assert!(target_guard.revalidate(&root, &dir).is_err());

        fs::remove_dir(root.join("Q?/child.")).unwrap();
        symlink(root.join("original/child."), root.join("Q?/child.")).unwrap();
        assert!(ReadOnlyDirectoryGuard::open(&root, &dir, "Q?/child.").is_err());
        assert!(target_guard.revalidate(&root, &dir).is_err());
        fs::remove_file(root.join("Q?/child.")).unwrap();
        fs::remove_dir(root.join("Q?")).unwrap();
        symlink(root.join("original"), root.join("Q?")).unwrap();
        assert!(ReadOnlyDirectoryGuard::open(&root, &dir, "Q?/child.").is_err());

        let moved = fixture.path().with_extension("original");
        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(guard.revalidate(&root, &dir).is_err());
        fs::remove_dir_all(moved).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_aliases_are_not_relative_file_names() {
        for path in [
            "NUL.html",
            "CON",
            "COM1.json",
            "LPT9.css",
            "aux/file.html",
            "x./index.html",
            "x /index.html",
        ] {
            assert!(validate_relative(path).is_err(), "{path}");
        }
        assert!(validate_relative("console/compact.html").is_ok());
    }
}
