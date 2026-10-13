use crate::knowledge::RootOpenFailure;
use serde::Serialize;
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
};

/// Selection must not replace unreadable or unrecognized saved settings. Only
/// a genuinely absent leaf is first launch; bounded no-follow reads fail closed.
pub(crate) fn read_settings_value(path: &Path) -> Result<Option<serde_json::Value>, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("StorageUnavailable".into()),
        Ok(metadata) if !metadata.is_file() || crate::write_fs::rejected_link(&metadata) => {
            return Err("StorageUnavailable".into())
        }
        Ok(_) => (),
    }
    let parent = path.parent().ok_or("StorageUnavailable")?;
    let (root, dir) = crate::knowledge::open_root(parent).map_err(|_| "StorageUnavailable")?;
    let guard = crate::knowledge::RootReferenceGuard::open(&root, &dir)
        .map_err(|_| "StorageUnavailable")?;
    let file = crate::identifier_migration::read_file(&dir, "settings.json", false)
        .map_err(|_| "StorageUnavailable")?;
    const MAXIMUM: u64 = 1024 * 1024;
    if file.metadata().map_err(|_| "StorageUnavailable")?.len() > MAXIMUM {
        return Err("StorageCorrupt".into());
    }
    let mut data = Vec::new();
    file.take(MAXIMUM + 1)
        .read_to_end(&mut data)
        .map_err(|_| "StorageUnavailable")?;
    if data.len() as u64 > MAXIMUM {
        return Err("StorageCorrupt".into());
    }
    guard
        .revalidate(&root, &dir)
        .map_err(|_| "StorageUnavailable")?;
    let value: serde_json::Value = serde_json::from_slice(&data).map_err(|_| "StorageCorrupt")?;
    if !value.is_object() {
        return Err("StorageCorrupt".into());
    }
    Ok(Some(value))
}

#[derive(Clone)]
pub(crate) struct SavedRoot {
    pub path: PathBuf,
    pub identity: Option<String>,
    pub scheme: Option<String>,
}
pub(crate) fn valid_identity(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|identity| {
        identity.len() == 64
            && identity
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
impl SavedRoot {
    pub(crate) fn parse(value: &serde_json::Value) -> Result<Self, String> {
        let path = value
            .get("knowledgeRoot")
            .and_then(|value| value.as_str())
            .filter(|path| !path.is_empty())
            .ok_or("設定のknowledgeRootが無効です")?;
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("設定のknowledgeRootが無効です".into());
        }
        let identity = match value.get("knowledgeRootIdentity") {
            Some(identity) if valid_identity(identity) => Some(identity.as_str().unwrap().into()),
            Some(_) => return Err("設定のknowledgeRootIdentityが無効です".into()),
            None => None,
        };
        let scheme = match value.get("knowledgeRootIdentityScheme") {
            None => None,
            Some(value) if value.as_str() == Some(crate::storage_identity_transition::SCHEME) => {
                Some(crate::storage_identity_transition::SCHEME.to_owned())
            }
            Some(_) => return Err("設定のknowledgeRootIdentitySchemeが未対応です".into()),
        };
        Ok(Self {
            path,
            identity,
            scheme,
        })
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    ConfirmationRequired,
    StorageIdentityConfirmationRequired,
    PathUnavailable,
    PermissionDenied,
    SyncUnavailable,
    UnsupportedRoot,
    IdentityChanged,
    Unavailable,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecovery {
    pub reason: RecoveryReason,
    pub can_retry: bool,
}
pub(crate) fn open_reason(failure: &RootOpenFailure) -> RecoveryReason {
    let RootOpenFailure::Io(error, _) = failure else {
        return RecoveryReason::UnsupportedRoot;
    };
    #[cfg(windows)]
    match error.raw_os_error() {
        Some(362 | 377 | 386 | 387 | 388 | 389 | 393 | 398 | 404 | 426 | 475 | 4350) => {
            return RecoveryReason::SyncUnavailable
        }
        Some(5 | 395) => return RecoveryReason::PermissionDenied,
        _ => (),
    }
    match error.kind() {
        io::ErrorKind::NotFound => RecoveryReason::PathUnavailable,
        io::ErrorKind::PermissionDenied => RecoveryReason::PermissionDenied,
        _ => RecoveryReason::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn io_classification_does_not_guess_unknown_offline_failures_are_missing() {
        for (kind, expected) in [
            (io::ErrorKind::NotFound, RecoveryReason::PathUnavailable),
            (
                io::ErrorKind::PermissionDenied,
                RecoveryReason::PermissionDenied,
            ),
            (io::ErrorKind::TimedOut, RecoveryReason::Unavailable),
            (io::ErrorKind::NotConnected, RecoveryReason::Unavailable),
            (io::ErrorKind::Other, RecoveryReason::Unavailable),
        ] {
            assert_eq!(
                open_reason(&RootOpenFailure::Io(io::Error::from(kind), String::new())),
                expected
            );
        }
        assert_eq!(
            open_reason(&RootOpenFailure::Unsupported),
            RecoveryReason::UnsupportedRoot
        );
    }
    #[cfg(windows)]
    #[test]
    fn known_windows_cloud_and_access_codes_are_classified_without_placeholder_acquisition() {
        for code in [362, 386, 388, 426, 4350] {
            assert_eq!(
                open_reason(&RootOpenFailure::Io(
                    io::Error::from_raw_os_error(code),
                    String::new()
                )),
                RecoveryReason::SyncUnavailable
            );
        }
        assert_eq!(
            open_reason(&RootOpenFailure::Io(
                io::Error::from_raw_os_error(395),
                String::new()
            )),
            RecoveryReason::PermissionDenied
        );
    }
}

#[cfg(test)]
#[path = "root_recovery_tests.rs"]
mod recovery_tests;
