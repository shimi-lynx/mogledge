//! Guarded finite reads for media; document source limits remain independent.
use super::{open_root, read_error, same_directory, ReadError};
use cap_std::fs::{Dir, File};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_WINDOW_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub start: u64,
    pub length: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Info {
    pub length: u64,
    identity: (u64, u128),
    modified: Option<std::time::SystemTime>,
}

fn info(file: &File) -> Result<Info, ReadError> {
    let metadata = file.metadata().map_err(read_error)?;
    if !metadata.is_file() {
        return Err("通常のファイルのみ読み取れます".into());
    }
    let standard = file.try_clone().map_err(read_error)?.into_std();
    Ok(Info {
        length: metadata.len(),
        identity: crate::write_fs::identity(&standard).map_err(read_error)?,
        modified: metadata.modified().ok().map(|time| time.into_std()),
    })
}

fn guarded<T>(
    root: &Path,
    dir: &Dir,
    relative: &str,
    operation: impl FnOnce(&mut File, &Info) -> Result<T, ReadError>,
) -> Result<T, ReadError> {
    let (_, current) = open_root(root)?;
    if !same_directory(dir, &current)? {
        return Err("ルートが置き換えられました".into());
    }
    #[cfg(windows)]
    let rel = super::validate_relative(relative)?;
    #[cfg(windows)]
    let guard = super::windows::guard_path(&root.join(&rel))
        .map_err(|error| super::windows::error_message(&error))?;
    #[cfg(windows)]
    super::windows::ensure_local(guard.info())
        .map_err(|error| super::windows::error_message(&error))?;
    #[cfg(windows)]
    if !guard
        .canonical_path()
        .map_err(|error| super::windows::error_message(&error))?
        .starts_with(root)
    {
        return Err("ルート外にはアクセスできません".into());
    }
    #[cfg(not(windows))]
    let rel = super::resolve(root, relative)?;
    // A FIFO/device can block in open before file metadata or cancellation.
    // Reject known special files first; NONBLOCK/NOFOLLOW also close the
    // metadata-to-open replacement race, including the final revalidation open.
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
    super::windows::configure_read(&mut options);
    let mut file = dir.open_with(&rel, &options).map_err(read_error)?;
    #[cfg(windows)]
    super::windows::verify_read(root, dir, &file, &guard)
        .map_err(|error| super::windows::error_message(&error))?;
    let before = info(&file)?;
    let result = operation(&mut file, &before)?;
    if info(&file)? != before {
        return Err("再生中にファイルが変更されました".into());
    }
    #[cfg(windows)]
    super::windows::verify_read(root, dir, &file, &guard)
        .map_err(|error| super::windows::error_message(&error))?;
    let (_, current) = open_root(root)?;
    if !same_directory(dir, &current)? {
        return Err("ルートが置き換えられました".into());
    }
    // Reopen the relative name to reject replacement during an admitted read.
    #[cfg(not(windows))]
    super::resolve(root, relative)?;
    let current = dir.open_with(&rel, &options).map_err(read_error)?;
    #[cfg(windows)]
    super::windows::verify_read(root, dir, &current, &guard)
        .map_err(|error| super::windows::error_message(&error))?;
    if info(&current)? != before {
        return Err("再生中にファイルが置き換えられました".into());
    }
    Ok(result)
}

pub fn inspect(root: &Path, dir: &Dir, relative: &str) -> Result<Info, ReadError> {
    guarded(root, dir, relative, |_, info| {
        Ok(Info {
            length: info.length,
            identity: info.identity,
            modified: info.modified,
        })
    })
}

pub fn read_window(
    root: &Path,
    dir: &Dir,
    relative: &str,
    expected: &Info,
    window: Window,
    mut reserve: impl FnMut(usize) -> Result<(), ReadError>,
    mut active: impl FnMut() -> bool,
) -> Result<Vec<u8>, ReadError> {
    let Window { start, length } = window;
    if expected.length > MAX_MEDIA_BYTES
        || length > MAX_WINDOW_BYTES
        || start
            .checked_add(length as u64)
            .is_none_or(|end| end > expected.length)
    {
        return Err("再生範囲が上限を超えています".into());
    }
    guarded(root, dir, relative, |file, info| {
        if info != expected || !active() {
            return Err("再生の許可またはファイルが変更されました".into());
        }
        reserve(length)?;
        let mut bytes = vec![0; length];
        file.seek(SeekFrom::Start(start)).map_err(read_error)?;
        for chunk in bytes.chunks_mut(64 * 1024) {
            if !active() {
                return Err("再生の許可が失効しました".into());
            }
            file.read_exact(chunk).map_err(read_error)?;
        }
        if !active() {
            return Err("再生の許可が失効しました".into());
        }
        Ok(bytes)
    })
}
