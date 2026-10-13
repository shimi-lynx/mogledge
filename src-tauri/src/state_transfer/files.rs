//! Explicit local portable files. Never overwrite, follow aliases, or read the DB
//! through another raw fd while the shared offline SQLite lock is held.
use super::{failure, TransferError};
use crate::{identifier_migration, knowledge, write_fs};
use cap_std::fs::Dir;
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub(crate) struct Location {
    path: PathBuf,
    parent: Arc<Dir>,
    guard: write_fs::RetainedDir,
    name: String,
}

impl Location {
    pub fn open(path: &Path, profile: &Dir) -> Result<Self, TransferError> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        {
            return Err(failure("unsafe_transfer_path"));
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| failure("unsafe_transfer_path"))?;
        crate::tree_mutations::valid_name(name).map_err(|_| failure("unsafe_transfer_path"))?;
        let parent_path = path
            .parent()
            .ok_or_else(|| failure("unsafe_transfer_path"))?;
        let parent = Arc::new(
            identifier_migration::directory(parent_path, false)
                .map_err(|_| failure("unsafe_transfer_path"))?
                .ok_or_else(|| failure("transfer_file_unavailable"))?,
        );
        // Compare physical ancestors as well as path syntax; Windows case aliases
        // must not let an input open/close SQLite's inode or pollute the profile.
        for ancestor in parent_path.ancestors() {
            let dir = identifier_migration::directory(ancestor, false)
                .map_err(|_| failure("unsafe_transfer_path"))?
                .ok_or_else(|| failure("unsafe_transfer_path"))?;
            if knowledge::same_directory(&dir, profile)
                .map_err(|_| failure("unsafe_transfer_path"))?
            {
                return Err(failure("profile_file_forbidden"));
            }
        }
        let guard =
            write_fs::LockedDir::open(&parent, "").map_err(|_| failure("unsafe_transfer_path"))?;
        guard
            .revalidate(parent_path, &parent)
            .map_err(|_| failure("transfer_file_changed"))?;
        Ok(Self {
            path: parent_path.to_owned(),
            parent,
            guard: guard.into_retained(),
            name: name.to_owned(),
        })
    }

    pub fn verify(&self) -> Result<(), TransferError> {
        self.scoped().map(|_| ())
    }

    fn scoped(&self) -> Result<write_fs::ScopedDir<'_>, TransferError> {
        let guard = self
            .guard
            .scoped()
            .map_err(|_| failure("unsafe_transfer_path"))?;
        guard
            .revalidate(&self.path, &self.parent)
            .map_err(|_| failure("transfer_file_changed"))?;
        Ok(guard)
    }

    pub fn absent(&self) -> Result<(), TransferError> {
        let guard = self.scoped()?;
        match guard.dir().symlink_metadata(&self.name) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(failure("transfer_file_exists")),
        }
    }

    pub fn read(
        &self,
        retained: &mut Vec<std::fs::File>,
    ) -> Result<(Vec<u8>, (u64, u128)), TransferError> {
        self.read_after_preflight(retained, || {})
    }

    pub(super) fn read_after_preflight(
        &self,
        retained: &mut Vec<std::fs::File>,
        after_preflight: impl FnOnce(),
    ) -> Result<(Vec<u8>, (u64, u128)), TransferError> {
        let guard = self.scoped()?;
        if retained.len() >= 128 {
            return Err(failure("file_handle_limit"));
        }
        #[cfg(unix)]
        {
            use cap_std::fs::MetadataExt;
            let metadata = guard
                .dir()
                .symlink_metadata(&self.name)
                .map_err(|_| failure("unsafe_transfer_file"))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1 {
                return Err(failure("unsafe_transfer_file"));
            }
        }
        after_preflight();
        #[cfg(unix)]
        let file = {
            use rustix::fs::{openat, Mode, OFlags};
            std::fs::File::from(
                openat(
                    guard.dir(),
                    self.name.as_str(),
                    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                    Mode::empty(),
                )
                .map_err(|_| failure("unsafe_transfer_file"))?,
            )
        };
        #[cfg(windows)]
        let file = identifier_migration::read_file(guard.dir(), &self.name, false)
            .map_err(|_| failure("unsafe_transfer_file"))?;
        retained.push(file);
        let file = retained.last_mut().unwrap();
        let identity = write_fs::identity(file).map_err(|_| failure("unsafe_transfer_file"))?;
        let before = file
            .metadata()
            .map_err(|_| failure("transfer_file_unavailable"))?;
        if write_fs::rejected_link(&before) || !before.is_file() {
            return Err(failure("unsafe_transfer_file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if before.nlink() != 1 {
                return Err(failure("unsafe_transfer_file"));
            }
        }
        if before.len() > super::format::maximum_transfer_bytes() as u64 {
            return Err(failure("transfer_limit"));
        }
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut buffer)
                .map_err(|_| failure("transfer_file_unavailable"))?;
            if n == 0 {
                break;
            }
            if bytes
                .len()
                .checked_add(n)
                .is_none_or(|v| v > super::format::maximum_transfer_bytes())
            {
                return Err(failure("transfer_limit"));
            }
            bytes
                .try_reserve(n)
                .map_err(|_| failure("resource_unavailable"))?;
            bytes.extend_from_slice(&buffer[..n]);
        }
        let after = file
            .metadata()
            .map_err(|_| failure("transfer_file_unavailable"))?;
        if bytes.len() > super::format::maximum_transfer_bytes() {
            return Err(failure("transfer_limit"));
        }
        if before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
            || after.len() != bytes.len() as u64
        {
            return Err(failure("transfer_file_changed"));
        }
        #[cfg(unix)]
        {
            use cap_std::fs::MetadataExt;
            let current = guard
                .dir()
                .symlink_metadata(&self.name)
                .map_err(|_| failure("transfer_file_changed"))?;
            if current.file_type().is_symlink()
                || !current.is_file()
                || current.nlink() != 1
                || (current.dev(), u128::from(current.ino())) != identity
            {
                return Err(failure("transfer_file_changed"));
            }
        }
        #[cfg(windows)]
        {
            let current = identifier_migration::read_file(guard.dir(), &self.name, false)
                .map_err(|_| failure("transfer_file_changed"))?;
            if write_fs::identity(&current).map_err(|_| failure("transfer_file_changed"))?
                != identity
            {
                return Err(failure("transfer_file_changed"));
            }
        }
        guard
            .revalidate(&self.path, &self.parent)
            .map_err(|_| failure("transfer_file_changed"))?;
        Ok((bytes, identity))
    }

    /// Only an explicitly confirmed export/backup invokes this method. The
    /// temporary belongs to us; failure cleanup never deletes an existing file.
    pub fn write_new(
        &self,
        bytes: &[u8],
        before_publish: impl FnOnce() -> Result<(), TransferError>,
    ) -> Result<(), TransferError> {
        self.write_new_tracked(bytes, before_publish, &mut false)
    }

    // A failure after rename (notably directory flush) still leaves a published
    // file. Live reconciliation must report it and never claim it was absent.
    pub fn write_new_tracked(
        &self,
        bytes: &[u8],
        before_publish: impl FnOnce() -> Result<(), TransferError>,
        published: &mut bool,
    ) -> Result<(), TransferError> {
        self.write_new_with_flush(bytes, before_publish, published, |dir| {
            #[cfg(unix)]
            dir.try_clone()
                .and_then(|d| d.into_std_file().sync_all())
                .map_err(|_| failure("transfer_file_sync_failed"))?;
            #[cfg(not(unix))]
            let _ = dir;
            Ok(())
        })
    }

    fn write_new_with_flush(
        &self,
        bytes: &[u8],
        before_publish: impl FnOnce() -> Result<(), TransferError>,
        published: &mut bool,
        flush_directory: impl FnOnce(&Dir) -> Result<(), TransferError>,
    ) -> Result<(), TransferError> {
        let guard = self.scoped()?;
        self.absent()?;
        if bytes.len() > super::format::maximum_transfer_bytes() {
            return Err(failure("transfer_limit"));
        }
        let (name, mut file) = write_fs::create_temporary(guard.dir())
            .map_err(|_| failure("transfer_file_write_failed"))?;
        let result = (|| {
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| failure("transfer_file_write_failed"))?;
            guard
                .revalidate(&self.path, &self.parent)
                .map_err(|_| failure("transfer_file_changed"))?;
            before_publish()?;
            write_fs::rename_noreplace(guard.dir(), &name, guard.dir(), &self.name, &file)
                .map_err(|_| failure("transfer_file_publish_failed"))?;
            *published = true;
            flush_directory(guard.dir())?;
            // Windows flushes the payload but directory/rename crash durability
            // remains Native QA; no overwrite/copy-delete fallback is used.
            Ok(())
        })();
        // Windows cleanup deletes through the retained handle, which follows a
        // successful rename. A flush failure must preserve the published output.
        if result.is_err() && !*published {
            let _ = write_fs::remove_temporary(guard.dir(), &name, &file);
        }
        result
    }
}

#[cfg(test)]
#[test]
fn selected_location_can_publish_and_read_on_another_thread() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let output = temp.path().join("output");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&output).unwrap();
    let profile = identifier_migration::directory(&profile, false)
        .unwrap()
        .unwrap();
    let path = output.join("portable.json");
    let location = Location::open(&path, &profile).unwrap();
    std::thread::spawn(move || {
        location.verify().unwrap();
        assert!(location
            .write_new(b"unpublished", || Err(failure("cancelled")))
            .is_err());
        location.absent().unwrap();
        location.write_new(b"{}", || Ok(())).unwrap();
        let mut retained = Vec::new();
        assert_eq!(location.read(&mut retained).unwrap().0, b"{}");
        assert_eq!(retained.len(), 1);
        assert!(location.write_new(b"replacement", || Ok(())).is_err());
    })
    .join()
    .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"{}");
    assert_eq!(std::fs::read_dir(&output).unwrap().count(), 1);
}

#[cfg(test)]
#[test]
fn published_file_survives_and_is_reported_after_directory_flush_failure() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("profile");
    let output = temp.path().join("output");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&output).unwrap();
    let profile = identifier_migration::directory(&profile, false)
        .unwrap()
        .unwrap();
    let path = output.join("portable.json");
    let location = Location::open(&path, &profile).unwrap();
    let mut published = false;
    let error = location
        .write_new_with_flush(
            b"{}",
            || Ok(()),
            &mut published,
            |_| Err(failure("transfer_file_sync_failed")),
        )
        .unwrap_err();
    assert_eq!(error.code, "transfer_file_sync_failed");
    assert!(published);
    assert_eq!(std::fs::read(&path).unwrap(), b"{}");
    assert_eq!(location.absent().unwrap_err().code, "transfer_file_exists");
}
