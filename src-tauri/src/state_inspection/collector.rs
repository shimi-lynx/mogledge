//! Conservative metadata-only observations from an explicitly connected root.
use crate::{knowledge, write_fs::LockedDir};
use cap_std::fs::Dir;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 32;
const SCAN_SECONDS: u64 = 2;
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Availability {
    SameIdentity,
    RelocatedIdentity,
    DifferentIdentityAtPath,
    NotFoundInCompleteScan,
    Unavailable,
}

pub(crate) struct ConnectedRoot {
    path: PathBuf,
    dir: Arc<Dir>,
    pub identity: String,
}

pub(crate) struct Observation {
    pub root_identity: String,
    identities: BTreeMap<String, String>,
    path_identities: BTreeMap<String, String>,
    pub complete: bool,
    metadata_bytes: usize,
}

impl ConnectedRoot {
    pub fn open(path: &Path, profile: &Path) -> Result<Self, ()> {
        if !path.is_absolute()
            || path
                .ancestors()
                .any(|part| part.file_name().is_some_and(|name| name == ".."))
        {
            return Err(());
        }
        let (path, dir) = knowledge::open_root(path).map_err(|_| ())?;
        // State/profile files must never become source scan inputs.
        if profile.starts_with(&path) || path.starts_with(profile) {
            return Err(());
        }
        let guard = LockedDir::open(&dir, "").map_err(|_| ())?;
        guard.revalidate(&path, &dir).map_err(|_| ())?;
        let identity = knowledge::storage_root_identity(&dir).map_err(|_| ())?;
        Ok(Self {
            path,
            dir,
            identity,
        })
    }

    pub fn verify(&self) -> Result<(), ()> {
        let (_, fresh) = knowledge::open_root(&self.path).map_err(|_| ())?;
        if !knowledge::same_directory(&self.dir, &fresh).map_err(|_| ())?
            || knowledge::storage_root_identity(&fresh).map_err(|_| ())? != self.identity
        {
            return Err(());
        }
        Ok(())
    }

    /// Resolves the identity without reading source bytes, retaining/rechecking
    /// all ordinary ancestors. Cloud/reparse uncertainty is an unavailable result.
    pub fn identity_at(&self, relative: &str) -> Result<String, ()> {
        let relative_path = knowledge::validate_relative(relative).map_err(|_| ())?;
        let parent = relative_path.parent().and_then(|p| p.to_str()).ok_or(())?;
        let guard = LockedDir::open(&self.dir, parent).map_err(|_| ())?;
        let leaf = relative_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(())?;
        let file =
            crate::write_fs::open_at(guard.dir(), leaf, false, false, false).map_err(|_| ())?;
        let identity = knowledge::document_identity(&self.dir, &file).map_err(|_| ())?;
        guard.revalidate(&self.path, &self.dir).map_err(|_| ())?;
        self.verify()?;
        Ok(identity)
    }

    pub fn scan(&self) -> Observation {
        let mut result = Observation {
            root_identity: self.identity.clone(),
            identities: BTreeMap::new(),
            path_identities: BTreeMap::new(),
            complete: true,
            metadata_bytes: 0,
        };
        let start = Instant::now();
        let mut count = 0;
        self.scan_directory("", 0, start, &mut count, &mut result);
        if self.verify().is_err() {
            result.complete = false;
        }
        result
    }

    fn scan_directory(
        &self,
        relative: &str,
        depth: usize,
        start: Instant,
        count: &mut usize,
        result: &mut Observation,
    ) {
        if depth > MAX_DEPTH || start.elapsed().as_secs() >= SCAN_SECONDS {
            result.complete = false;
            return;
        }
        let Ok(guard) = LockedDir::open(&self.dir, relative) else {
            result.complete = false;
            return;
        };
        let before = guard
            .dir()
            .dir_metadata()
            .ok()
            .and_then(|m| m.modified().ok());
        if before.is_none() {
            result.complete = false;
            return;
        }
        let Ok(entries) = guard.dir().entries() else {
            result.complete = false;
            return;
        };
        for entry in entries {
            *count += 1;
            if *count > MAX_ENTRIES || start.elapsed().as_secs() >= SCAN_SECONDS {
                result.complete = false;
                break;
            }
            let Ok(entry) = entry else {
                result.complete = false;
                continue;
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                result.complete = false;
                continue;
            };
            let path = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            if path.len() > 4096 || knowledge::validate_relative(&path).is_err() {
                result.complete = false;
                continue;
            }
            // Ordinary metadata preflight never follows links or recalls Cloud
            // placeholders. Refusal invalidates completeness instead of skipping.
            match crate::write_fs::entry_is_directory(guard.dir(), name) {
                Ok(true) => self.scan_directory(&path, depth + 1, start, count, result),
                Ok(false) => match self.identity_at(&path) {
                    Ok(identity) => {
                        let additional = 2 * (identity.len() + path.len());
                        if result
                            .metadata_bytes
                            .checked_add(additional)
                            .is_none_or(|bytes| bytes > MAX_METADATA_BYTES)
                        {
                            result.complete = false;
                            return;
                        }
                        result.metadata_bytes += additional;
                        result
                            .identities
                            .entry(identity.clone())
                            .or_insert_with(|| path.clone());
                        result.path_identities.insert(path, identity);
                    }
                    Err(()) => result.complete = false,
                },
                Err(_) => result.complete = false,
            }
        }
        if guard.revalidate(&self.path, &self.dir).is_err() {
            result.complete = false;
        }
        if guard
            .dir()
            .dir_metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            != before
        {
            result.complete = false;
        }
    }

    pub fn locate(
        &self,
        observation: &Observation,
        id: &str,
        recorded_path: &str,
    ) -> (Availability, Option<String>) {
        if self.verify().is_err() || observation.root_identity != self.identity {
            return (Availability::Unavailable, None);
        }
        if let Some(path) = observation.identities.get(id) {
            if self.identity_at(path).is_ok_and(|current| current == id) {
                return (
                    if path == recorded_path {
                        Availability::SameIdentity
                    } else {
                        Availability::RelocatedIdentity
                    },
                    Some(path.clone()),
                );
            }
            return (Availability::Unavailable, None);
        }
        if observation.path_identities.contains_key(recorded_path) {
            return (Availability::DifferentIdentityAtPath, None);
        }
        (
            if observation.complete {
                Availability::NotFoundInCompleteScan
            } else {
                Availability::Unavailable
            },
            None,
        )
    }
}
