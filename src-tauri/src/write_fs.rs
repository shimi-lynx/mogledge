//! Handle-relative writes. Document publication never overwrites or falls back
//! to copy/delete; profile settings explicitly replace a reserved internal leaf.
use cap_std::fs::Dir;
use std::{fs::File, io, path::Path, sync::Arc};

pub struct LockedDir {
    pub chain: Vec<Dir>,
    pub relative: String,
    #[cfg(windows)]
    _metadata_scope: crate::knowledge::LocalMetadataScope,
}

/// Persistent handles may cross threads; thread-local metadata visibility may not.
/// Directory access is available only through an operation-local scope.
pub(crate) struct RetainedDir {
    chain: Vec<Dir>,
    relative: String,
}

pub(crate) struct ScopedDir<'a> {
    retained: &'a RetainedDir,
    #[cfg(windows)]
    _metadata_scope: crate::knowledge::LocalMetadataScope,
}

impl RetainedDir {
    pub(crate) fn scoped(&self) -> Result<ScopedDir<'_>, String> {
        Ok(ScopedDir {
            retained: self,
            #[cfg(windows)]
            _metadata_scope: crate::knowledge::local_metadata_scope()
                .map_err(|_| "通常のローカルフォルダー情報を取得できません")?,
        })
    }
}

impl ScopedDir<'_> {
    pub(crate) fn dir(&self) -> &Dir {
        self.retained.chain.last().unwrap()
    }

    pub(crate) fn revalidate(&self, root: &Path, original: &Arc<Dir>) -> Result<(), String> {
        revalidate_chain(
            &self.retained.chain,
            &self.retained.relative,
            root,
            original,
        )
    }
}

impl LockedDir {
    pub fn dir(&self) -> &Dir {
        self.chain.last().unwrap()
    }
    pub fn open(root: &Dir, relative: &str) -> Result<Self, String> {
        if !relative.is_empty() {
            crate::knowledge::validate_relative(relative)?;
        }
        #[cfg(windows)]
        let metadata_scope = crate::knowledge::local_metadata_scope()
            .map_err(|_| "通常のローカルフォルダー情報を取得できません")?;
        let mut chain = vec![Dir::from_std_file(
            lock_root(root).map_err(|_| "親フォルダーを開けません")?,
        )];
        if !relative.is_empty() {
            for part in relative.split('/') {
                crate::tree_mutations::valid_name(part)?;
                let file =
                    open_at(chain.last().unwrap(), part, true, false, false).map_err(|_| {
                        "親フォルダーを開けません。リンクやアクセス権を確認してください"
                    })?;
                chain.push(Dir::from_std_file(file));
            }
        }
        Ok(Self {
            chain,
            relative: relative.into(),
            #[cfg(windows)]
            _metadata_scope: metadata_scope,
        })
    }
    pub fn revalidate(&self, root: &Path, original: &Arc<Dir>) -> Result<(), String> {
        revalidate_chain(&self.chain, &self.relative, root, original)
    }

    pub(crate) fn into_retained(self) -> RetainedDir {
        let Self {
            chain,
            relative,
            #[cfg(windows)]
            _metadata_scope,
        } = self;
        // End visibility on its originating thread, without closing or reopening
        // any handle. Windows no-delete sharing protection remains continuous.
        #[cfg(windows)]
        drop(_metadata_scope);
        RetainedDir { chain, relative }
    }
}

fn revalidate_chain(
    chain: &[Dir],
    relative: &str,
    root: &Path,
    original: &Arc<Dir>,
) -> Result<(), String> {
    let (_, current) = crate::knowledge::open_root(root)?;
    if !crate::knowledge::same_directory(original, &current)? {
        return Err("knowledgeフォルダーが置き換えられました".into());
    }
    let fresh = LockedDir::open(original, relative)?;
    for (old, new) in chain.iter().zip(&fresh.chain) {
        if !crate::knowledge::same_directory(old, new)? {
            return Err("親フォルダーが変更されました。再走査してください".into());
        }
    }
    Ok(())
}

fn lock_root(root: &Dir) -> io::Result<File> {
    #[cfg(unix)]
    {
        open_at(root, ".", true, false, false)
    }
    #[cfg(windows)]
    {
        let _scope = crate::knowledge::local_metadata_scope()?;
        crate::knowledge::ordinary_directory_path(root)?;
        // knowledge::open_root_dir already opens this capability with read/list
        // access, no-recall/reparse flags, and without FILE_SHARE_DELETE. A
        // duplicate retains that same file object and its replacement lock;
        // reopening it adds no protection and can fail on ordinary directories.
        let file = root.try_clone()?.into_std_file();
        let meta = file.metadata()?;
        if rejected_link(&meta) || !meta.is_dir() {
            return Err(io::Error::other("root reparse point"));
        }
        Ok(file)
    }
}

pub fn rejected_link(meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Writes reject every reparse point, including resident Cloud Files,
        // plus offline/recall-on-data entries. RECALL_ON_OPEN is checked by
        // exposed enumeration preflight; its handle-metadata bit aliases EA.
        meta.file_attributes() & (0x400 | 0x1000 | 0x400000) != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Ordinary-only inspection before deciding whether to open or enumerate an
/// entry. On Windows the preflight never recalls placeholder content.
pub fn entry_is_directory(parent: &Dir, name: impl AsRef<Path>) -> io::Result<bool> {
    let name = name.as_ref();
    if name.components().count() != 1
        || !matches!(
            name.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid entry name",
        ));
    }
    #[cfg(windows)]
    {
        crate::knowledge::ordinary_entry_is_directory(parent, name)
    }
    #[cfg(not(windows))]
    {
        let metadata = parent.symlink_metadata(name)?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(io::Error::other("unsupported file type"));
        }
        Ok(metadata.is_dir())
    }
}

pub fn identity(file: &File) -> io::Result<(u64, u128)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        Ok((meta.dev(), u128::from(meta.ino())))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
        };
        let mut info = FILE_ID_INFO::default();
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileIdInfo,
                (&mut info as *mut FILE_ID_INFO).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        }
        .map_err(io::Error::other)?;
        Ok((
            info.VolumeSerialNumber,
            u128::from_le_bytes(info.FileId.Identifier),
        ))
    }
}

/// Recursive preflight may inspect dotfiles, but cannot open an arbitrary path.
/// Public mutation sources still use open_at and validate_relative.
pub fn open_subtree_entry(parent: &Dir, name: &str, directory: bool) -> io::Result<File> {
    let leaf = Path::new(name);
    if leaf.components().count() != 1
        || !matches!(
            leaf.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid subtree leaf",
        ));
    }
    #[cfg(windows)]
    {
        open_leaf_at(parent, name, directory, false, false, true)
    }
    #[cfg(unix)]
    {
        open_at(parent, name, directory, false, false)
    }
}

#[cfg(unix)]
pub fn open_at(
    parent: &Dir,
    name: &str,
    directory: bool,
    create: bool,
    rename: bool,
) -> io::Result<File> {
    use rustix::fs::{openat, Mode, OFlags};
    let _ = rename;
    let mut flags = OFlags::NOFOLLOW
        | OFlags::CLOEXEC
        | OFlags::NONBLOCK
        | if directory {
            OFlags::RDONLY | OFlags::DIRECTORY
        } else if create {
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL
        } else {
            OFlags::RDONLY
        };
    #[cfg(target_os = "linux")]
    if !directory && !create {
        flags |= OFlags::PATH;
    }
    let file = File::from(openat(
        parent,
        name,
        flags,
        Mode::from_bits_truncate(0o600),
    )?);
    let meta = file.metadata()?;
    if rejected_link(&meta) || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(io::Error::other("unsupported file type"));
    }
    Ok(file)
}

#[cfg(windows)]
pub fn open_at(
    parent: &Dir,
    name: &str,
    directory: bool,
    create: bool,
    rename: bool,
) -> io::Result<File> {
    crate::knowledge::validate_relative(name)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid entry name"))?;
    open_leaf_at(parent, name, directory, create, rename, true)
}

/// Reserved writer artifacts are never settings or migration authority.
pub(crate) fn unpublished_staging_name(name: &str) -> bool {
    name.strip_prefix(".my-knowledge-")
        .and_then(|value| value.strip_suffix(".tmp"))
        .is_some_and(|token| {
            token.len() == 64
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}

/// Creates an internal, hidden staging file. Callers cannot supply its name;
/// user paths still go through the public relative-path validator.
pub fn create_temporary(parent: &Dir) -> io::Result<(String, File)> {
    let name = format!(".my-knowledge-{}.tmp", crate::core::random_token());
    #[cfg(windows)]
    let file = open_leaf_at(parent, &name, false, true, true, true)?;
    #[cfg(unix)]
    let file = open_at(parent, &name, false, true, true)?;
    Ok((name, file))
}

/// Keep the newly created DB pinned without DELETE access: SQLite opens it
/// with read/write sharing, so a retained DELETE-access handle would conflict.
/// The handle still denies delete sharing and pins the original file identity.
pub(crate) fn create_database_guard(parent: &Dir) -> io::Result<File> {
    #[cfg(windows)]
    {
        open_leaf_at(parent, "state.sqlite", false, true, false, false)
    }
    #[cfg(unix)]
    {
        open_at(parent, "state.sqlite", false, true, false)
    }
}

// Windows staging files bypass only the user-facing hidden-name restriction.
// Single-leaf, ordinary-path, exclusive-create and handle checks stay shared.
#[cfg(windows)]
fn open_leaf_at(
    parent: &Dir,
    name: &str,
    directory: bool,
    create: bool,
    rename: bool,
    delete_on_create: bool,
) -> io::Result<File> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows::{
        core::PWSTR,
        Wdk::{
            Foundation::OBJECT_ATTRIBUTES,
            Storage::FileSystem::{
                NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
                FILE_OPEN_NO_RECALL, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
            },
        },
        Win32::{
            Foundation::{HANDLE, OBJ_CASE_INSENSITIVE, UNICODE_STRING},
            Storage::FileSystem::{
                DELETE, FILE_ACCESS_RIGHTS, FILE_ATTRIBUTE_NORMAL, FILE_LIST_DIRECTORY,
                FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
                FILE_WRITE_DATA, SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let _scope = crate::knowledge::local_metadata_scope()?;
    let parent_path = crate::knowledge::ordinary_directory_path(parent)?;
    let leaf = Path::new(name);
    if leaf.components().count() != 1
        || !matches!(
            leaf.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid entry name",
        ));
    }
    // Missing leaves are allowed only for exclusive create; all existing
    // components, including an existing create destination, must be ordinary.
    crate::knowledge::validate_cache_path(&parent_path.join(leaf))?;
    if !create && crate::knowledge::ordinary_entry_is_directory(parent, leaf)? != directory {
        return Err(io::Error::other("unsupported file type"));
    }
    let wide: Vec<u16> = name.encode_utf16().collect();
    let length = u16::try_from(wide.len() * 2).map_err(|_| io::Error::other("name too long"))?;
    let object_name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: PWSTR(wide.as_ptr() as *mut _),
    };
    let parent = parent.try_clone()?.into_std_file();
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: HANDLE(parent.as_raw_handle()),
        ObjectName: &object_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    let mut access = FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    if directory {
        access |= FILE_TRAVERSE | FILE_LIST_DIRECTORY;
    }
    if create && !directory {
        access |= FILE_WRITE_DATA;
    }
    if rename || (create && !directory && delete_on_create) {
        access |= DELETE;
    }
    let mut create_options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    // NtCreateFile rejects NO_RECALL with DIRECTORY_FILE, even for FILE_OPEN.
    // Directory opens retain exposed ordinary-path preflight, the metadata
    // visibility scope and OPEN_REPARSE_POINT. FILE_CREATE never opens an existing
    // leaf; retain NO_RECALL only when opening an existing non-directory file.
    if !directory && !create {
        create_options |= FILE_OPEN_NO_RECALL;
    }
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_ACCESS_RIGHTS(access.0),
            &attributes,
            &mut status,
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            if create { FILE_CREATE } else { FILE_OPEN },
            create_options,
            None,
            0,
        )
    };
    if result.0 < 0 {
        return Err(io::Error::other("handle-relative open failed"));
    }
    let file = unsafe { File::from_raw_handle(handle.0) };
    let meta = file.metadata()?;
    if rejected_link(&meta) || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err(io::Error::other("unsupported file type"));
    }
    Ok(file)
}

pub fn mkdir(parent: &Dir, name: &str) -> io::Result<()> {
    #[cfg(unix)]
    {
        rustix::fs::mkdirat(parent, name, rustix::fs::Mode::from_bits_truncate(0o700))?;
    }
    #[cfg(windows)]
    {
        let _ = open_at(parent, name, true, true, false)?;
    }
    Ok(())
}

pub fn rename_noreplace(
    parent: &Dir,
    name: &str,
    target: &Dir,
    destination: &str,
    source: &File,
) -> io::Result<()> {
    crate::tree_mutations::valid_name(destination)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid destination name"))?;
    #[cfg(unix)]
    {
        let current = open_at(parent, name, source.metadata()?.is_dir(), false, false)?;
        if identity(&current)? != identity(source)? {
            return Err(io::Error::other("source changed"));
        }
        rustix::fs::renameat_with(
            parent,
            name,
            target,
            destination,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
    }
    #[cfg(windows)]
    {
        let _ = (parent, name);
        rename_windows(target, destination, source, false)?;
    }
    Ok(())
}

/// Atomic publication to the reserved profile settings leaf. Preserve the
/// directory guards and rename the retained staging handle; reopening a
/// guarded Windows directory for write access causes a sharing violation.
pub(crate) fn replace_profile_settings(
    parent: &Dir,
    temporary: &str,
    source: &File,
) -> io::Result<()> {
    replace_profile_file(parent, temporary, source, "settings.json")
}

pub(crate) fn replace_resident_preferences(
    parent: &Dir,
    temporary: &str,
    source: &File,
) -> io::Result<()> {
    replace_profile_file(parent, temporary, source, "resident.json")
}

/// Publish a workspace sidecar, confined to its ordinary application directory.
/// Replacement operates on the retained staging handle and never follows the
/// destination entry. An alias inserted at the destination cannot modify the
/// referenced file's contents; observed aliases are rejected before dispatch.
#[cfg(windows)]
pub(crate) fn replace_workspace_preferences(
    parent: &LockedDir,
    temporary: &str,
    source: &File,
    destination: &str,
) -> io::Result<()> {
    replace_hashed_sidecar(
        parent,
        "workspace-settings",
        64,
        temporary,
        source,
        destination,
    )
}

#[cfg(windows)]
pub(crate) fn replace_tree_order(
    parent: &LockedDir,
    temporary: &str,
    source: &File,
    destination: &str,
) -> io::Result<()> {
    replace_hashed_sidecar(parent, "tree-order", 16, temporary, source, destination)
}

#[cfg(windows)]
fn replace_hashed_sidecar(
    parent: &LockedDir,
    expected_parent: &str,
    digits: usize,
    temporary: &str,
    source: &File,
    destination: &str,
) -> io::Result<()> {
    let stem = destination.strip_suffix(".json").unwrap_or_default();
    if parent.relative != expected_parent
        || stem.len() != digits
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !temporary.starts_with(".my-knowledge-")
        || !temporary.ends_with(".tmp")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid sidecar publication",
        ));
    }
    let staged = open_leaf_at(parent.dir(), temporary, false, false, false, false)?;
    if identity(&staged)? != identity(source)? {
        return Err(io::Error::other("staging file changed"));
    }
    require_single_link(source)?;
    match open_at(parent.dir(), destination, false, false, false) {
        Ok(current) => require_single_link(&current)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // The staging handle stays live through dispatch. On any dispatch or
    // postcheck failure callers preserve it: there is no pathname cleanup.
    replace_profile_file(parent.dir(), temporary, source, destination)?;
    let published = open_at(parent.dir(), destination, false, false, false)?;
    if identity(&published)? != identity(source)? {
        return Err(io::Error::other("published sidecar changed"));
    }
    require_single_link(&published)
}

#[cfg(windows)]
fn require_single_link(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
    };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: a live ordinary file handle and the documented output structure.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }?;
    if information.nNumberOfLinks != 1 {
        return Err(io::Error::other("sidecar alias"));
    }
    Ok(())
}

// Only reserved settings leaves and validated application sidecars can replace.
fn replace_profile_file(
    parent: &Dir,
    temporary: &str,
    source: &File,
    destination: &str,
) -> io::Result<()> {
    #[cfg(unix)]
    {
        let current = open_at(parent, temporary, false, false, false)?;
        if identity(&current)? != identity(source)? {
            return Err(io::Error::other("source changed"));
        }
        parent.rename(temporary, parent, destination)?;
    }
    #[cfg(windows)]
    {
        let _ = temporary;
        rename_windows(parent, destination, source, true)?;
    }
    Ok(())
}

#[cfg(windows)]
fn rename_windows(target: &Dir, destination: &str, source: &File, replace: bool) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::{
        Wdk::Storage::FileSystem::{
            FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
        },
        Win32::{
            Foundation::{RtlNtStatusToDosError, HANDLE},
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let target = target.try_clone()?.into_std_file();
    let wide: Vec<u16> = destination.encode_utf16().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
    let length = std::mem::size_of::<FILE_RENAME_INFORMATION>() + wide.len() * 2;
    // u64 storage supplies the native structure's alignment, including its handle.
    let mut buffer = vec![0u64; length.div_ceil(8)];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status = IO_STATUS_BLOCK::default();
    // Use the native rename contract for a target directory handle plus a
    // single relative leaf. No process-CWD or absolute-path fallback.
    // The source was opened synchronously with DELETE access by open_at or
    // create_temporary; both handles and the aligned buffer stay live here.
    let result = unsafe {
        (*info).Anonymous.ReplaceIfExists = replace;
        (*info).RootDirectory = HANDLE(target.as_raw_handle());
        (*info).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            wide.as_ptr(),
            buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
            wide.len(),
        );
        NtSetInformationFile(
            HANDLE(source.as_raw_handle()),
            &mut status,
            info.cast(),
            length as u32,
            FileRenameInformation,
        )
    };
    if result.0 < 0 {
        // Preserve the OS reason (collision, sharing, permissions, etc.).
        return Err(io::Error::from_raw_os_error(unsafe {
            RtlNtStatusToDosError(result) as i32
        }));
    }
    if result.0 != 0 {
        return Err(io::Error::other("rename did not complete synchronously"));
    }
    Ok(())
}

pub fn remove_temporary(parent: &Dir, name: &str, source: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        if let Ok(current) = open_at(parent, name, false, false, false) {
            if identity(&current)? == identity(source)? {
                parent.remove_file(name)?;
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            },
        };
        let _ = (parent, name);
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(source.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
        .map_err(io::Error::other)?;
    }
    Ok(())
}

// Reserved application output only. Public mutation paths retain their hidden-
// component validator; callers pass fixed kit/profile leaves, never IPC paths.
pub(crate) fn mkdir_internal(parent: &Dir, name: &str) -> io::Result<()> {
    let leaf = Path::new(name);
    if leaf.components().count() != 1
        || !matches!(
            leaf.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid internal leaf",
        ));
    }
    #[cfg(unix)]
    rustix::fs::mkdirat(parent, name, rustix::fs::Mode::from_bits_truncate(0o700))?;
    #[cfg(windows)]
    let _ = open_leaf_at(parent, name, true, true, false, true)?;
    Ok(())
}

pub(crate) fn read_regular(parent: &Dir, name: &str, limit: usize) -> io::Result<Vec<u8>> {
    use std::io::Read;
    // Inspect ordinary metadata before opening content, especially Cloud Files.
    if entry_is_directory(parent, name)? {
        return Err(io::Error::other("expected regular file"));
    }
    #[cfg(unix)]
    let file = {
        use rustix::fs::{openat, Mode, OFlags};
        File::from(openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )?)
    };
    #[cfg(windows)]
    let file = {
        use cap_std::fs::OpenOptionsExt;
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000 | 0x00100000);
        parent.open_with(name, &options)?.into_std()
    };
    let metadata = file.metadata()?;
    if rejected_link(&metadata) || !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(io::Error::other("unsupported or oversized file"));
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("oversized file"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn scoped_sidecars_reject_aliases_and_keep_staging_on_publication_failure() {
        use std::{io::Write, os::windows::fs::OpenOptionsExt};
        let fixture = tempfile::tempdir().unwrap();
        let (root_path, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        std::fs::create_dir(root_path.join("workspace-settings")).unwrap();
        std::fs::create_dir(root_path.join("tree-order")).unwrap();
        let workspace = LockedDir::open(&root, "workspace-settings").unwrap();
        let order = LockedDir::open(&root, "tree-order").unwrap();
        let (first_name, mut first) = create_temporary(order.dir()).unwrap();
        first.write_all(b"first order").unwrap();
        replace_tree_order(&order, &first_name, &first, "bbbbbbbbbbbbbbbb.json").unwrap();
        assert_eq!(
            std::fs::read(root_path.join("tree-order/bbbbbbbbbbbbbbbb.json")).unwrap(),
            b"first order"
        );
        let destination = format!("{}.json", "a".repeat(64));
        let target = root_path.join("workspace-settings").join(&destination);
        let external = root_path.join("retained.json");
        std::fs::write(&external, b"retained external content").unwrap();
        std::fs::hard_link(&external, &target).unwrap();
        let (temporary, mut staged) = create_temporary(workspace.dir()).unwrap();
        staged.write_all(b"new preferences").unwrap();
        staged.sync_all().unwrap();
        assert!(
            replace_workspace_preferences(&workspace, &temporary, &staged, &destination).is_err()
        );
        assert_eq!(
            std::fs::read(&external).unwrap(),
            b"retained external content"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"retained external content"
        );
        assert!(root_path
            .join("workspace-settings")
            .join(&temporary)
            .exists());
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, b"old preferences").unwrap();
        let locked_target = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&target)
            .unwrap();
        assert!(
            replace_workspace_preferences(&workspace, &temporary, &staged, &destination).is_err()
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"old preferences");
        assert!(root_path
            .join("workspace-settings")
            .join(&temporary)
            .exists());
        drop(locked_target);
        assert!(replace_workspace_preferences(&order, &temporary, &staged, &destination).is_err());
        assert!(
            replace_workspace_preferences(&workspace, &temporary, &staged, "settings.json")
                .is_err()
        );
        replace_workspace_preferences(&workspace, &temporary, &staged, &destination).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new preferences");
        assert_eq!(
            identity(&open_at(workspace.dir(), &destination, false, false, false).unwrap())
                .unwrap(),
            identity(&staged).unwrap()
        );
        let (temporary, mut staged_order) = create_temporary(order.dir()).unwrap();
        staged_order.write_all(b"new order").unwrap();
        let alias = root_path.join("staging-alias.json");
        // A retained no-delete handle prevents namespace substitution. An
        // existing extra hardlink, if the filesystem permits creating it, is
        // rejected instead of publishing the aliased staging object.
        assert!(std::fs::rename(root_path.join("tree-order").join(&temporary), &alias).is_err());
        if std::fs::hard_link(root_path.join("tree-order").join(&temporary), &alias).is_ok() {
            assert!(
                replace_tree_order(&order, &temporary, &staged_order, "aaaaaaaaaaaaaaaa.json")
                    .is_err()
            );
            assert_eq!(std::fs::read(&alias).unwrap(), b"new order");
        } else {
            replace_tree_order(&order, &temporary, &staged_order, "aaaaaaaaaaaaaaaa.json").unwrap();
        }
        assert_eq!(
            std::fs::read(&external).unwrap(),
            b"retained external content"
        );
    }
    use super::*;

    #[test]
    fn retained_chain_crosses_threads_without_reopening_or_losing_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().to_owned();
        std::fs::create_dir_all(path.join("source/nested")).unwrap();
        let (_, root) = crate::knowledge::open_root(&path).unwrap();
        let locked = LockedDir::open(&root, "source/nested").unwrap();
        let identities = locked
            .chain
            .iter()
            .map(|dir| identity(&dir.try_clone().unwrap().into_std_file()).unwrap())
            .collect::<Vec<_>>();
        let retained = locked.into_retained();
        let retained = std::thread::spawn(move || {
            {
                let scope = retained.scoped().unwrap();
                scope.revalidate(&path, &root).unwrap();
                assert_eq!(retained.chain.len(), identities.len());
                for (dir, expected) in retained.chain.iter().zip(identities) {
                    assert_eq!(
                        identity(&dir.try_clone().unwrap().into_std_file()).unwrap(),
                        expected
                    );
                }
                #[cfg(windows)]
                {
                    assert!(
                        std::fs::rename(path.join("source"), path.join("replacement")).is_err()
                    );
                    assert!(
                        std::fs::rename(path.join("source/nested"), path.join("nested")).is_err()
                    );
                }
                #[cfg(unix)]
                {
                    std::fs::rename(path.join("source/nested"), path.join("nested")).unwrap();
                    std::fs::create_dir(path.join("source/nested")).unwrap();
                    assert!(scope.revalidate(&path, &root).is_err());
                }
            }
            retained
        })
        .join()
        .unwrap();
        #[cfg(windows)]
        assert!(std::fs::rename(
            fixture.path().join("source/nested"),
            fixture.path().join("nested")
        )
        .is_err());
        drop(retained);
        #[cfg(windows)]
        std::fs::rename(
            fixture.path().join("source/nested"),
            fixture.path().join("nested"),
        )
        .unwrap();
    }

    #[test]
    fn owned_temporary_cleanup_without_rename_leaves_other_files_unchanged() {
        use std::io::Write;

        let fixture = tempfile::tempdir().unwrap();
        let (path, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        std::fs::write(path.join("retained.html"), "retained").unwrap();
        let parent = LockedDir::open(&root, "").unwrap();
        let (temporary, mut file) = create_temporary(parent.dir()).unwrap();
        file.write_all(b"unpublished HTML").unwrap();
        file.sync_all().unwrap();
        remove_temporary(parent.dir(), &temporary, &file).unwrap();
        drop(file);
        assert!(!path.join(&temporary).exists());
        assert_eq!(
            std::fs::read(path.join("retained.html")).unwrap(),
            b"retained"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    }

    #[test]
    fn rename_rejects_nonleaf_hidden_and_reserved_destinations_without_moving_source() {
        let fixture = tempfile::tempdir().unwrap();
        let (path, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        std::fs::create_dir(path.join("target")).unwrap();
        std::fs::write(path.join("source.html"), "retained").unwrap();
        let parent = LockedDir::open(&root, "").unwrap();
        let target = LockedDir::open(&root, "target").unwrap();
        let source = open_at(parent.dir(), "source.html", false, false, true).unwrap();
        for name in [
            "",
            ".hidden",
            "..",
            "../escape",
            "a/b",
            "a\\b",
            "/escape",
            "C:/escape",
            "x:y",
            "CON",
            "COM0.html",
            "LPT0",
            "NUL.html",
            "a\0b",
            "a.",
            "a ",
        ] {
            assert_eq!(
                rename_noreplace(parent.dir(), "source.html", target.dir(), name, &source)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput,
                "{name:?}"
            );
            assert!(path.join("source.html").is_file());
            assert_eq!(std::fs::read_dir(path.join("target")).unwrap().count(), 0);
        }
        drop(source);
        assert_eq!(
            std::fs::read(path.join("source.html")).unwrap(),
            b"retained"
        );
    }

    #[test]
    fn internal_temporary_publish_collision_and_cleanup_preserve_user_path_boundary() {
        use std::io::Write;

        let fixture = tempfile::tempdir().unwrap();
        let (path, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        let parent = LockedDir::open(&root, "").unwrap();
        let (temporary, mut file) = create_temporary(parent.dir()).unwrap();
        assert!(temporary.starts_with(".my-knowledge-"));
        assert!(temporary.ends_with(".tmp"));
        assert!(crate::knowledge::validate_relative(&temporary).is_err());
        assert!(crate::tree_mutations::valid_name(&temporary).is_err());
        assert!(crate::knowledge::read(&path, &root, &temporary).is_err());
        #[cfg(windows)]
        assert!(open_at(parent.dir(), &temporary, false, true, true).is_err());
        file.write_all(b"complete HTML").unwrap();
        file.sync_all().unwrap();
        rename_noreplace(parent.dir(), &temporary, parent.dir(), "page.html", &file).unwrap();
        drop(file);
        assert!(!path.join(&temporary).exists());
        assert_eq!(
            std::fs::read(path.join("page.html")).unwrap(),
            b"complete HTML"
        );

        let (temporary, mut file) = create_temporary(parent.dir()).unwrap();
        file.write_all(b"unpublished").unwrap();
        assert!(
            rename_noreplace(parent.dir(), &temporary, parent.dir(), "page.html", &file).is_err()
        );
        remove_temporary(parent.dir(), &temporary, &file).unwrap();
        drop(file);
        assert!(!path.join(&temporary).exists());
        assert_eq!(
            std::fs::read(path.join("page.html")).unwrap(),
            b"complete HTML"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_existing_directory_chain_and_file_directory_moves_work() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path();
        std::fs::create_dir_all(path.join("source/nested")).unwrap();
        std::fs::write(path.join("source/nested/page.html"), "retained").unwrap();
        let (_, root) = crate::knowledge::open_root(path).unwrap();
        let chain = LockedDir::open(&root, "source/nested").unwrap();
        chain.revalidate(path, &root).unwrap();
        assert!(open_at(chain.dir(), "page.html", true, false, false).is_err());
        assert!(std::fs::rename(path.join("source"), path.join("replacement")).is_err());
        assert!(std::fs::rename(path.join("source/nested"), path.join("nested")).is_err());
        drop(chain);

        let parent = LockedDir::open(&root, "").unwrap();
        assert!(open_at(parent.dir(), "source", false, false, false).is_err());
        let source = open_at(parent.dir(), "source", true, false, true).unwrap();
        rename_noreplace(parent.dir(), "source", parent.dir(), "移動先 📂", &source).unwrap();
        drop(source);
        assert!(!path.join("source").exists());
        assert_eq!(
            std::fs::read(path.join("移動先 📂/nested/page.html")).unwrap(),
            b"retained"
        );

        let nested = LockedDir::open(&root, "移動先 📂/nested").unwrap();
        let source = open_at(nested.dir(), "page.html", false, false, true).unwrap();
        rename_noreplace(
            nested.dir(),
            "page.html",
            parent.dir(),
            "移動済み 📄.html",
            &source,
        )
        .unwrap();
        drop(source);
        assert!(!path.join("移動先 📂/nested/page.html").exists());
        assert_eq!(
            std::fs::read(path.join("移動済み 📄.html")).unwrap(),
            b"retained"
        );
        nested.revalidate(path, &root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_root_duplicate_retains_identity_and_replacement_lock() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("root");
        std::fs::create_dir(&path).unwrap();
        let (_, root) = crate::knowledge::open_root(&path).unwrap();
        let original = root.try_clone().unwrap().into_std_file();
        let file =
            lock_root(&root).expect("ordinary selected root must remain usable for mutations");
        assert_eq!(identity(&file).unwrap(), identity(&original).unwrap());
        drop(original);
        drop(root);

        // The operation's duplicate must retain the no-delete sharing lock even
        // after every selection handle closes. Child creation remains allowed.
        let locked = Dir::from_std_file(file);
        mkdir(&locked, "created").unwrap();
        assert!(path.join("created").is_dir());
        let renamed = fixture.path().join("replacement");
        assert!(std::fs::rename(&path, &renamed).is_err());
        drop(locked);
        std::fs::rename(&path, &renamed).unwrap();
        assert!(renamed.join("created").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn windows_exclusive_create_preserves_existing_files_and_directories() {
        use std::io::Write;

        let fixture = tempfile::tempdir().unwrap();
        let (path, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        let parent = LockedDir::open(&root, "").unwrap();
        mkdir(parent.dir(), "created").unwrap();
        std::fs::write(path.join("created/retained.html"), "retained").unwrap();
        assert!(mkdir(parent.dir(), "created").is_err());
        assert_eq!(
            std::fs::read(path.join("created/retained.html")).unwrap(),
            b"retained"
        );

        let mut file = open_at(parent.dir(), "created.html", false, true, false).unwrap();
        file.write_all(b"created").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert!(open_at(parent.dir(), "created.html", false, true, false).is_err());
        assert_eq!(
            crate::knowledge::read(&path, &root, "created.html").unwrap(),
            b"created"
        );
    }

    #[test]
    fn ordinary_entry_inspection_classifies_only_a_single_existing_entry() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir(fixture.path().join("folder")).unwrap();
        std::fs::write(fixture.path().join("page.html"), "local").unwrap();
        std::fs::write(fixture.path().join(".hidden"), "hidden").unwrap();
        let (_, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        assert!(entry_is_directory(&root, "folder").unwrap());
        assert!(!entry_is_directory(&root, "page.html").unwrap());
        assert!(!entry_is_directory(&root, ".hidden").unwrap());
        assert!(open_subtree_entry(&root, ".hidden", false).is_ok());
        for name in ["..", ".", "folder/page.html"] {
            assert!(open_subtree_entry(&root, name, false).is_err());
        }
        assert_eq!(
            entry_is_directory(&root, "missing").unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        for name in ["..", ".", "folder/page.html"] {
            assert_eq!(
                entry_is_directory(&root, name).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn ordinary_entry_inspection_refuses_symlinks_and_special_files() {
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir(fixture.path().join("folder")).unwrap();
        std::os::unix::fs::symlink("folder", fixture.path().join("link")).unwrap();
        let (_, root) = crate::knowledge::open_root(fixture.path()).unwrap();
        crate::test_fixtures::create_fifo(&fixture.path().join("pipe"), 0o600).unwrap();
        assert!(entry_is_directory(&root, "link").is_err());
        assert!(entry_is_directory(&root, "pipe").is_err());
    }
}
