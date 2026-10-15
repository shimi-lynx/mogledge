//! Small guarded profile records. Callers serialize mutations under Core::gate.
use crate::{knowledge, write_fs};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{io, io::Write, path::Path};

fn ensure_directory(directory: &Path, remaining: usize) -> Result<(), String> {
    match std::fs::symlink_metadata(directory) {
        Ok(_) => {
            knowledge::open_root(directory)?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && remaining > 0 => {
            let parent = directory.parent().ok_or("設定の保存先が無効です")?;
            ensure_directory(parent, remaining - 1)?;
            let (path, dir) = knowledge::open_root(parent)?;
            let locked = write_fs::LockedDir::open(&dir, "")?;
            let leaf = directory
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("設定の保存先が無効です")?;
            write_fs::mkdir_internal(locked.dir(), leaf)
                .or_else(|error| {
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map_err(|_| "設定の保存先を作成できません")?;
            locked.revalidate(&path, &dir)?;
            knowledge::open_root(directory)?;
            Ok(())
        }
        Err(_) => Err("設定の保存先を安全に確認できません".into()),
    }
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn backup_document(directory: &Path, bytes: &[u8]) -> Result<String, String> {
    let (path, dir) = knowledge::open_root(directory)?;
    let guard = knowledge::RootReferenceGuard::open_profile_write(&path, &dir)?;
    let leaf = format!(
        "document-identity-backup-{}.html",
        crate::core::random_token()
    );
    let (temporary, mut staged) =
        write_fs::create_temporary(&dir).map_err(|_| "HTMLの退避を作成できません")?;
    let result = (|| {
        staged
            .write_all(bytes)
            .and_then(|_| staged.sync_all())
            .map_err(|_| "HTMLの退避を保存できません")?;
        guard.revalidate(&path, &dir)?;
        write_fs::rename_noreplace(&dir, &temporary, &dir, &leaf, &staged)
            .map_err(|_| "HTMLの退避を保存できません".to_owned())
    })();
    if result.is_err() {
        let _ = write_fs::remove_temporary(&dir, &temporary, &staged);
    }
    result?;
    Ok(leaf)
}
pub(crate) fn read<T: DeserializeOwned + Default>(
    directory: &Path,
    leaf: &str,
) -> Result<(T, Option<String>), String> {
    if matches!(std::fs::symlink_metadata(directory),Err(error) if error.kind()==io::ErrorKind::NotFound)
    {
        return Ok((T::default(), None));
    }
    let (path, dir) = knowledge::open_root(directory)?;
    let guard = knowledge::RootReferenceGuard::open_profile_write(&path, &dir)?;
    let bytes = match write_fs::read_regular(&dir, leaf, 4 * 1024 * 1024) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((T::default(), None)),
        Err(_) => return Err("保存記録を安全に読み取れません。既存内容を保持します".into()),
    };
    guard.revalidate(&path, &dir)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|_| "保存記録が破損しています。既存内容を保持します")?;
    Ok((value, Some(digest(&bytes))))
}
pub(crate) fn write<T: Serialize>(
    directory: &Path,
    leaf: &str,
    expected: Option<&str>,
    value: &T,
) -> Result<(), String> {
    ensure_directory(directory, 32)?;
    let (path, dir) = knowledge::open_root(directory)?;
    let guard = knowledge::RootReferenceGuard::open_profile_write(&path, &dir)?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "保存記録を作成できません")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("保存記録の上限に達しました".into());
    }
    if expected == Some(digest(&bytes).as_str()) {
        let current = write_fs::read_regular(&dir, leaf, 4 * 1024 * 1024)
            .map_err(|_| "保存記録が変更されました")?;
        guard.revalidate(&path, &dir)?;
        if digest(&current).as_str() == expected.unwrap() {
            return Ok(());
        }
        return Err("保存記録が外部で変更されました。上書きしません".into());
    }
    let (temporary, mut staged) =
        write_fs::create_temporary(&dir).map_err(|_| "保存記録を保存できません")?;
    let result = (|| {
        staged
            .write_all(&bytes)
            .and_then(|_| staged.sync_all())
            .map_err(|_| "保存記録を保存できません")?;
        guard.revalidate(&path, &dir)?;
        write_fs::replace_checked(&dir, &temporary, &staged, leaf, expected, 4 * 1024 * 1024)
            .map_err(|_| "保存先が変更されたか書き込めません。既存内容を保持します".to_owned())
    })();
    if result.is_err() {
        let _ = write_fs::remove_temporary(&dir, &temporary, &staged);
    }
    result
}
