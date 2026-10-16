//! Limited namespace writes below a verified resident synchronized root.
//! No shared cache/profile writer policy or persistent guard is changed here.
use super::{
    denied, ensure_local, enumeration_info, error_message, final_path, handle_identity,
    handle_info, verify_root, FILE_TYPE_DISK,
};
use cap_std::fs::Dir;
use std::{
    fs::File,
    io,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Path, PathBuf},
};

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum CloudWriteOutcome {
    Verified,
    // The namespace may have changed. Preserve items; never retry or clean up.
    Unknown,
}

#[link(name = "cldapi")]
unsafe extern "system" {
    fn CfGetPlaceholderStateFromAttributeTag(attributes: u32, tag: u32) -> u32;
}

fn resident_state(state: u32) -> bool {
    // CF_PLACEHOLDER_STATE_PARTIAL / PARTIALLY_ON_DISK and INVALID. Metadata
    // does not establish a permanent provider lock or absence of callbacks.
    state != u32::MAX && state & 0x30 == 0
}

fn resident_item(
    handle: std::os::windows::io::RawHandle,
    directory: bool,
) -> io::Result<super::PathInfo> {
    let info = handle_info(handle)?;
    ensure_local(info)?;
    if !info.allowed() || info.is_dir() != directory {
        return Err(denied(super::UNSUPPORTED));
    }
    let mut raw = super::AttributeTagInfo {
        attributes: 0,
        reparse_tag: 0,
    };
    // SAFETY: only metadata is queried on a live handle. The documented buffer
    // layout is shared with handle_info; the operation owns placeholder visibility.
    let ok = unsafe {
        super::GetFileInformationByHandleEx(
            handle,
            super::FILE_ATTRIBUTE_TAG_INFO,
            (&mut raw as *mut super::AttributeTagInfo).cast(),
            std::mem::size_of_val(&raw) as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let current = super::PathInfo::from_attributes(raw.attributes, raw.reparse_tag);
    if !current.allowed() || current.is_dir() != directory {
        return Err(denied(super::UNSUPPORTED));
    }
    ensure_local(current)?;
    // SAFETY: this pure OS classifier consumes attribute/tag values, no file handle.
    let state = unsafe { CfGetPlaceholderStateFromAttributeTag(raw.attributes, raw.reparse_tag) };
    if !resident_state(state) || (current.is_cloud() && state & 1 == 0) {
        return Err(denied(super::UNAVAILABLE));
    }
    Ok(current)
}

fn resident_directory(handle: std::os::windows::io::RawHandle) -> io::Result<super::PathInfo> {
    resident_item(handle, true)
}

// Relative native rename opens its target parent with write access internally.
// This writer's guards therefore share READ+WRITE, while denying DELETE to pin
// the namespace. They do not replace the stricter shared reader/profile guards
// or claim to freeze provider metadata; every transition is revalidated.
struct ResidentWriteGuard {
    handles: Vec<File>,
    paths: Vec<PathBuf>,
    _visibility: super::PlaceholderVisibility,
}
impl ResidentWriteGuard {
    fn open(path: &Path) -> io::Result<Self> {
        let visibility = super::PlaceholderVisibility::expose()?;
        super::validate_local_path(path)?;
        let mut guard = Self {
            handles: Vec::new(),
            paths: Vec::new(),
            _visibility: visibility,
        };
        for ancestor in path
            .ancestors()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .filter(|path| path.has_root())
        {
            let inspected = super::metadata_handle(ancestor)?;
            resident_directory(inspected.as_raw_handle())?;
            check_entry(ancestor)?;
            let directory = super::directory_handle(ancestor, true)?;
            resident_directory(directory.as_raw_handle())?;
            if handle_identity(inspected.as_raw_handle())?
                != handle_identity(directory.as_raw_handle())?
            {
                return Err(denied(super::UNSUPPORTED));
            }
            guard.paths.push(ancestor.to_path_buf());
            guard.handles.push(directory);
            guard.revalidate()?;
        }
        if guard.handles.is_empty() {
            return Err(denied(super::UNSUPPORTED));
        }
        Ok(guard)
    }
    fn revalidate(&self) -> io::Result<()> {
        for (path, file) in self.paths.iter().zip(&self.handles) {
            resident_directory(file.as_raw_handle())?;
            check_entry(path)?;
            let named = super::metadata_handle(path)?;
            resident_directory(named.as_raw_handle())?;
            if handle_identity(named.as_raw_handle())? != handle_identity(file.as_raw_handle())? {
                return Err(denied(super::UNSUPPORTED));
            }
        }
        Ok(())
    }
    fn verify_identity(&self, handle: std::os::windows::io::RawHandle) -> io::Result<()> {
        if handle_identity(
            self.handles
                .last()
                .ok_or_else(|| denied(super::UNSUPPORTED))?
                .as_raw_handle(),
        )? != handle_identity(handle)?
        {
            return Err(denied(super::UNSUPPORTED));
        }
        Ok(())
    }
}
fn check_entry(path: &Path) -> io::Result<()> {
    if let Some(info) = enumeration_info(path)? {
        if !info.allowed() || !info.is_dir() {
            return Err(denied(super::UNSUPPORTED));
        }
        ensure_local(info)?;
    }
    Ok(())
}

// Guards remain operation-local: retaining their thread-bound visibility in Core
// would break its Send/Sync contract. The selected root and every parent are
// pinned independently; validating a nested parent never substitutes for root ID.
struct CloudParent<'a> {
    root: &'a Path,
    selected: &'a Dir,
    // Visibility scopes must drop in reverse acquisition order, even when the
    // caller has no outer metadata scope (for example a direct Native probe).
    guard: ResidentWriteGuard,
    root_guard: ResidentWriteGuard,
    path: PathBuf,
    dir: Dir,
}
impl<'a> CloudParent<'a> {
    fn open(root: &'a Path, selected: &'a Dir, relative: &str) -> io::Result<Self> {
        if !relative.is_empty() {
            super::super::validate_relative(relative).map_err(io::Error::other)?;
        }
        let root_guard = ResidentWriteGuard::open(root)?;
        let path = root.join(relative);
        let guard = ResidentWriteGuard::open(&path)?;
        let dir = Dir::from_std_file(
            guard
                .handles
                .last()
                .ok_or_else(|| denied(super::UNSUPPORTED))?
                .try_clone()?,
        );
        let parent = Self {
            root,
            selected,
            root_guard,
            guard,
            path,
            dir,
        };
        parent.revalidate()?;
        Ok(parent)
    }
    fn revalidate(&self) -> io::Result<()> {
        self.root_guard.revalidate()?;
        self.root_guard
            .verify_identity(self.selected.as_raw_handle())?;
        verify_root(self.root, self.selected)?;
        self.guard.revalidate()?;
        self.guard.verify_identity(self.dir.as_raw_handle())?;
        let mut cloud = false;
        for file in &self.guard.handles {
            cloud |= resident_directory(file.as_raw_handle())?.is_cloud();
        }
        if !cloud
            || handle_identity(self.dir.as_raw_handle())?.volume_serial
                != handle_identity(self.selected.as_raw_handle())?.volume_serial
        {
            return Err(denied("保持済みクラウドフォルダー内だけに作成できます"));
        }
        Ok(())
    }
    fn no_collision(&self, name: &str) -> Result<(), String> {
        for entry in self
            .dir
            .entries()
            .map_err(|_| "親フォルダーを読み取れません")?
        {
            if entry
                .map_err(|_| "親フォルダーを読み取れません")?
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                == name.to_lowercase()
            {
                return Err("同じ名前の項目があります（大文字・小文字を区別しません）".into());
            }
        }
        Ok(())
    }
    fn named(&self, name: &str, directory: bool) -> io::Result<File> {
        let path = self.path.join(name);
        let entry = enumeration_info(&path)?.ok_or_else(|| denied(super::UNSUPPORTED))?;
        if !entry.allowed() || entry.is_dir() != directory {
            return Err(denied(super::UNSUPPORTED));
        }
        ensure_local(entry)?;
        // Attribute-only observation can coexist with our DELETE-capable source.
        // The source handle, not this observation, pins the object throughout rename.
        let file = std::fs::OpenOptions::new()
            .access_mode(super::FILE_READ_ATTRIBUTES)
            .share_mode(
                super::FILE_SHARE_READ
                    | super::FILE_SHARE_WRITE
                    | windows::Win32::Storage::FileSystem::FILE_SHARE_DELETE.0,
            )
            .custom_flags(
                super::FILE_FLAG_OPEN_REPARSE_POINT
                    | super::FILE_FLAG_BACKUP_SEMANTICS
                    | super::FILE_FLAG_OPEN_NO_RECALL,
            )
            .open(&path)?;
        resident_item(file.as_raw_handle(), directory)?;
        Ok(file)
    }
    fn verify_leaf(
        &self,
        name: &str,
        file: &File,
        identity: &super::FileIdInfo,
        directory: bool,
    ) -> io::Result<()> {
        self.revalidate()?;
        resident_item(file.as_raw_handle(), directory)?;
        // SAFETY: this only queries the held object's device kind.
        if unsafe { super::GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK
            || final_path(file.as_raw_handle())? != self.path.join(name)
            || handle_identity(file.as_raw_handle())? != *identity
            || handle_identity(self.named(name, directory)?.as_raw_handle())? != *identity
        {
            return Err(denied(super::UNSUPPORTED));
        }
        self.revalidate()
    }
}

// None means a potentially changed namespace. Never retry or remove that leaf.
fn open_leaf(
    parent: &Dir,
    name: &str,
    directory: bool,
    create: bool,
    rename: bool,
) -> Result<Option<File>, String> {
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
                DELETE, FILE_ATTRIBUTE_NORMAL, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, SYNCHRONIZE,
            },
            System::IO::IO_STATUS_BLOCK,
        },
    };
    let wide = name.encode_utf16().collect::<Vec<_>>();
    let length = (wide.len() * 2) as u16;
    let object_name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: PWSTR(wide.as_ptr() as *mut _),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: HANDLE(parent.as_raw_handle()),
        ObjectName: &object_name,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    let mut status = IO_STATUS_BLOCK::default();
    let access = FILE_READ_ATTRIBUTES
        | SYNCHRONIZE
        | if directory {
            FILE_LIST_DIRECTORY | FILE_TRAVERSE
        } else {
            Default::default()
        }
        | if rename { DELETE } else { Default::default() };
    // NO_RECALL is incompatible with DIRECTORY_FILE. Directory operations instead
    // retain resident list guards; opening existing files explicitly requests NO_RECALL.
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_NO_RECALL
        };
    // SAFETY: bounded single-leaf buffers and parent handle live through synchronous dispatch.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &attributes,
            &mut status,
            None,
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            if create { FILE_CREATE } else { FILE_OPEN },
            options,
            None,
            0,
        )
    };
    #[cfg(test)]
    eprintln!(
        "cloud leaf {name}: status={:08x}, information={}",
        result.0 as u32, status.Information
    );
    if result.0 < 0 {
        if result.0 as u32 == 0xc0000035 {
            return Err("同じ名前の項目があります（大文字・小文字を区別しません）".into());
        }
        if create {
            return Ok(None);
        }
        return Err("操作対象を開けません。アクセス権・リンク・ロックを確認してください".into());
    }
    if handle.is_invalid() {
        return Ok(None);
    }
    // SAFETY: the returned handle's ownership is transferred exactly once.
    let file = unsafe { File::from_raw_handle(handle.0) };
    if result.0 != 0 || status.Information != if create { 2 } else { 1 } {
        return Ok(None);
    }
    Ok(Some(file))
}

fn rename_leaf(target: &Dir, destination: &str, source: &File) -> io::Result<()> {
    use windows::{
        Wdk::Storage::FileSystem::{
            FileRenameInformation, NtSetInformationFile, FILE_RENAME_INFORMATION,
        },
        Win32::{Foundation::HANDLE, System::IO::IO_STATUS_BLOCK},
    };
    let wide = destination.encode_utf16().collect::<Vec<_>>();
    let offset = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
    let length = std::mem::size_of::<FILE_RENAME_INFORMATION>() + wide.len() * 2;
    let mut buffer = vec![0u64; length.div_ceil(8)];
    let info = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut status = IO_STATUS_BLOCK::default();
    // SAFETY: aligned native buffer, held source/target and bounded relative leaf.
    let result = unsafe {
        (*info).Anonymous.ReplaceIfExists = false;
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
    if result.0 != 0 {
        #[cfg(test)]
        eprintln!("cloud rename status={:08x}", result.0 as u32);
        return Err(io::Error::other("rename completion is unverified"));
    }
    Ok(())
}

#[cfg(test)]
pub(in crate::knowledge) fn create_root_folder(
    root: &Path,
    dir: &Dir,
    name: &str,
    before: impl FnOnce() -> Result<(), String>,
) -> Result<CloudWriteOutcome, String> {
    create_folder_with(root, dir, "", name, before, || Ok(()))
}
#[cfg(test)]
fn create_root_folder_with(
    root: &Path,
    dir: &Dir,
    name: &str,
    before: impl FnOnce() -> Result<(), String>,
    after: impl FnOnce() -> io::Result<()>,
) -> Result<CloudWriteOutcome, String> {
    create_folder_with(root, dir, "", name, before, after)
}
pub(crate) fn create_folder(
    root: &Path,
    dir: &Dir,
    parent: &str,
    name: &str,
    before: impl FnOnce() -> Result<(), String>,
) -> Result<CloudWriteOutcome, String> {
    create_folder_with(root, dir, parent, name, before, || Ok(()))
}
fn create_folder_with(
    root: &Path,
    dir: &Dir,
    relative: &str,
    name: &str,
    before: impl FnOnce() -> Result<(), String>,
    after: impl FnOnce() -> io::Result<()>,
) -> Result<CloudWriteOutcome, String> {
    crate::tree_mutations::valid_name(name)?;
    let parent = CloudParent::open(root, dir, relative).map_err(|e| error_message(&e))?;
    parent.no_collision(name)?;
    before()?;
    parent.revalidate().map_err(|e| error_message(&e))?;
    parent.no_collision(name)?;
    let Some(child) = open_leaf(&parent.dir, name, true, true, false)? else {
        return Ok(CloudWriteOutcome::Unknown);
    };
    let verified = (|| {
        let identity = handle_identity(child.as_raw_handle())?;
        after()?;
        parent.verify_leaf(name, &child, &identity, true)
    })();
    Ok(if verified.is_ok() {
        CloudWriteOutcome::Verified
    } else {
        CloudWriteOutcome::Unknown
    })
}

pub(crate) fn move_leaf(
    root: &Path,
    dir: &Dir,
    source: &str,
    destination: &str,
    directory: bool,
    before: impl FnOnce() -> Result<(), String>,
) -> Result<CloudWriteOutcome, String> {
    super::super::validate_relative(source)?;
    super::super::validate_relative(destination)?;
    let (old_parent, old_name) = crate::tree_mutations::split(source);
    let (new_parent, name) = crate::tree_mutations::split(destination);
    crate::tree_mutations::valid_name(old_name)?;
    crate::tree_mutations::valid_name(name)?;
    let old = CloudParent::open(root, dir, old_parent).map_err(|e| error_message(&e))?;
    let new = CloudParent::open(root, dir, new_parent).map_err(|e| error_message(&e))?;
    let original = old
        .named(old_name, directory)
        .map_err(|e| error_message(&e))?;
    let identity = handle_identity(original.as_raw_handle()).map_err(|e| error_message(&e))?;
    drop(original);
    let file = open_leaf(&old.dir, old_name, directory, false, source != destination)?
        .ok_or("操作対象を確認できません")?;
    old.verify_leaf(old_name, &file, &identity, directory)
        .map_err(|e| error_message(&e))?;
    if source == destination {
        before()?;
        old.verify_leaf(old_name, &file, &identity, directory)
            .map_err(|e| error_message(&e))?;
        return Ok(CloudWriteOutcome::Verified);
    }
    let empty = || -> io::Result<()> {
        if directory
            && Dir::from_std_file(file.try_clone()?)
                .entries()?
                .next()
                .is_some()
        {
            return Err(denied("同期フォルダー内では空フォルダーだけを移動できます"));
        }
        Ok(())
    };
    empty().map_err(|e| error_message(&e))?;
    new.no_collision(name)?;
    before()?;
    old.verify_leaf(old_name, &file, &identity, directory)
        .map_err(|e| error_message(&e))?;
    new.revalidate().map_err(|e| error_message(&e))?;
    empty().map_err(|e| error_message(&e))?;
    new.no_collision(name)?;
    let verified = (|| -> io::Result<()> {
        rename_leaf(&new.dir, name, &file)?;
        old.revalidate()?;
        new.verify_leaf(name, &file, &identity, directory)?;
        empty()?;
        // Namespace absence is inspected only under the held old parent.
        if old.dir.entries()?.any(|entry| {
            entry.map_or(true, |entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(old_name)
            })
        }) {
            return Err(denied(super::UNSUPPORTED));
        }
        Ok(())
    })();
    Ok(if verified.is_ok() {
        CloudWriteOutcome::Verified
    } else {
        CloudWriteOutcome::Unknown
    })
}
#[cfg(test)]
mod tests {
    use super::super::{guard_path, metadata_handle};
    use super::*;

    #[test]
    fn partial_or_invalid_provider_state_is_never_resident() {
        for state in [0x10, 0x11, 0x20, 0x31, u32::MAX] {
            assert!(!resident_state(state));
        }
        for state in [0, 1, 0x0b, 0x0d] {
            assert!(resident_state(state));
        }
    }

    #[test]
    fn ordinary_roots_and_invalid_names_cannot_enter_cloud_writer() {
        let tmp = tempfile::tempdir().unwrap();
        let (root, dir) = super::super::super::open_root(tmp.path()).unwrap();
        for name in ["test", "../escape", "A/B", "CON", "stream:name"] {
            let called = std::cell::Cell::new(false);
            assert!(create_root_folder(&root, &dir, name, || {
                called.set(true);
                Ok(())
            })
            .is_err());
            assert!(!called.get());
        }
        let called = std::cell::Cell::new(false);
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        std::fs::write(tmp.path().join("source.html"), b"preserved").unwrap();
        assert!(
            move_leaf(&root, &dir, "source.html", "target.html", false, || {
                called.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!called.get());
        assert_eq!(
            std::fs::read(tmp.path().join("source.html")).unwrap(),
            b"preserved"
        );
        assert!(!tmp.path().join("target.html").exists());
    }

    #[test]
    fn nested_cloud_parent_refusal_restores_calling_thread_mode() {
        let set_mode = super::super::placeholder_mode_function().unwrap();
        // SAFETY: valid thread mode, with unconditional RAII restoration.
        let original = unsafe { set_mode(1) };
        assert!(original >= 0);
        let _restore = super::super::PlaceholderVisibility {
            set_mode,
            previous: original,
            _thread_bound: std::marker::PhantomData,
        };
        let tmp = tempfile::tempdir().unwrap();
        let (root, dir) = super::super::super::open_root(tmp.path()).unwrap();
        assert!(CloudParent::open(&root, &dir, "").is_err());
        // SAFETY: setting the same mode probes restoration of both parent scopes.
        assert_eq!(unsafe { set_mode(1) }, 1);
    }

    #[test]
    #[ignore = "mutates only an explicitly approved disposable OneDrive probe fixture"]
    fn disposable_onedrive_exclusive_creation_and_unknown_outcome() {
        let fixture = std::path::PathBuf::from(
            std::env::var_os("MOGLEDGE_ONEDRIVE_PROBE_FIXTURE")
                .expect("approved disposable fixture required"),
        );
        assert!(fixture
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Mogledge-OneDrive-QA-072-"));
        let (root, dir) = super::super::super::open_root(&fixture).unwrap();
        assert!(
            guard_path(&root).unwrap().info().is_cloud(),
            "provider conversion required"
        );
        let root_identity = handle_identity(dir.as_raw_handle()).unwrap();
        let refused = format!("refused-{:016x}", rand::random::<u64>());
        assert!(create_root_folder(&root, &dir, &refused, || Err(
            "injected pre-create refusal".into()
        ))
        .is_err());
        assert!(!root.join(&refused).exists());
        let name = format!("writer-{:016x}-日本語", rand::random::<u64>());
        assert_eq!(
            create_root_folder(&root, &dir, &name, || Ok(())).unwrap(),
            CloudWriteOutcome::Verified
        );
        let leaf = root.join(&name);
        let original = metadata_handle(&leaf).unwrap();
        let identity = handle_identity(original.as_raw_handle()).unwrap();
        assert!(create_root_folder(&root, &dir, &name, || Ok(())).is_err());
        assert!(create_root_folder(&root, &dir, &name.to_uppercase(), || Ok(())).is_err());
        assert!(
            handle_identity(metadata_handle(&leaf).unwrap().as_raw_handle()).unwrap() == identity
        );
        let unknown = format!("unknown-{:016x}", rand::random::<u64>());
        assert_eq!(
            create_root_folder_with(
                &root,
                &dir,
                &unknown,
                || Ok(()),
                || Err(io::Error::other("injected post-create observation failure"))
            )
            .unwrap(),
            CloudWriteOutcome::Unknown
        );
        let preserved = metadata_handle(&root.join(&unknown))
            .expect("unknown outcomes preserve the created item");
        assert!(handle_info(preserved.as_raw_handle()).unwrap().is_dir());
        assert!(create_root_folder(&root, &dir, &unknown, || Ok(())).is_err());
        assert!(handle_identity(dir.as_raw_handle()).unwrap() == root_identity);
        guard_path(&root).unwrap().revalidate().unwrap();
        // No cleanup: preserve both newly owned empty leaves for later observation.
        println!("verified exclusive Unicode/case collision, retained identity, unknown preservation; leaves {name} and {unknown}");
    }
}
