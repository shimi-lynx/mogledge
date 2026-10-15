//! Logical storage identity comes only from inert source metadata. Physical
//! identity remains a separate grant boundary and is rechecked on every request.
use crate::{core::Core, knowledge, profile_store, write_fs};
use cap_std::fs::Dir;
use html5ever::{
    tendril::StrTendril,
    tokenizer::{
        states::RawKind, BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

const CATALOG: &str = "document-identities.json";
pub(crate) const META: &str = "mogledge-document-id";
pub(crate) fn normalize_uuid(value: &str) -> Option<String> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        || value.bytes().all(|b| b == b'0' || b == b'-')
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}
pub(crate) fn new_uuid() -> String {
    let token = crate::core::random_token();
    format!(
        "{}-{}-4{}-a{}-{}",
        &token[..8],
        &token[8..12],
        &token[13..16],
        &token[17..20],
        &token[20..32]
    )
}
pub(crate) fn storage_key(uuid: &str) -> String {
    profile_store::digest(format!("mogledge-document-uuid-v1\0{uuid}").as_bytes())
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Metadata {
    Missing,
    Invalid,
    Uuid(String),
}
#[derive(Default)]
struct Parsed {
    count: usize,
    uuid: Option<String>,
    template: usize,
}
struct Sink(RefCell<Parsed>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        if let Token::TagToken(tag) = token {
            let mut state = self.0.borrow_mut();
            let name = tag.name.as_ref();
            let start = tag.kind == TagKind::StartTag;
            if name == "template" {
                if start {
                    state.template += 1;
                } else {
                    state.template = state.template.saturating_sub(1);
                }
            }
            if start {
                match name {
                    "script" => return TokenSinkResult::RawData(RawKind::ScriptData),
                    "title" | "textarea" => return TokenSinkResult::RawData(RawKind::Rcdata),
                    "style" | "xmp" | "iframe" | "noembed" | "noframes" => {
                        return TokenSinkResult::RawData(RawKind::Rawtext)
                    }
                    "plaintext" => return TokenSinkResult::Plaintext,
                    _ => (),
                }
            }
            if start
                && name == "meta"
                && state.template == 0
                && tag
                    .attrs
                    .iter()
                    .any(|a| a.name.local.as_ref() == "name" && a.value.eq_ignore_ascii_case(META))
            {
                state.count = state.count.saturating_add(1);
                state.uuid = tag
                    .attrs
                    .iter()
                    .find(|a| a.name.local.as_ref() == "content")
                    .and_then(|a| normalize_uuid(&a.value));
            }
        }
        TokenSinkResult::Continue
    }
}
pub(crate) fn parse(source: &str) -> Metadata {
    let tokenizer = Tokenizer::new(Sink(RefCell::new(Parsed::default())), Default::default());
    let input = BufferQueue::default();
    let mut remaining = source;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(16_384);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        input.push_back(StrTendril::from_slice(&remaining[..end]));
        let _ = tokenizer.feed(&input);
        remaining = &remaining[end..];
    }
    tokenizer.end();
    let state = tokenizer.sink.0.into_inner();
    match (state.count, state.uuid) {
        (0, _) => Metadata::Missing,
        (1, Some(id)) => Metadata::Uuid(id),
        _ => Metadata::Invalid,
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    uuid: String,
    object: String,
    physical: String,
    root: PathBuf,
    path: String,
    shared: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyProof {
    object: String,
    source: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    version: u8,
    bindings: Vec<Binding>,
    legacy: Vec<LegacyProof>,
    #[serde(default)]
    resolved_legacy: Vec<String>,
}
fn profile(core: &Core) -> Result<&Path, String> {
    core.settings_path
        .get()
        .and_then(|p| p.parent())
        .ok_or_else(|| "StorageUnavailable".into())
}
fn catalog(core: &Core) -> Result<(Catalog, Option<String>), String> {
    let (mut value, hash): (Catalog, _) = profile_store::read(profile(core)?, CATALOG)?;
    if hash.is_none() {
        value.version = 1;
    }
    if value.version != 1
        || value.bindings.len() > 4096
        || value.legacy.len() > 4096
        || value.resolved_legacy.len() > 4096
        || value.bindings.iter().any(|b| {
            normalize_uuid(&b.uuid).as_deref() != Some(&b.uuid)
                || !b.root.is_absolute()
                || knowledge::validate_relative(&b.path).is_err()
        })
    {
        return Err("StorageCorrupt".into());
    }
    Ok((value, hash))
}
#[derive(Clone)]
pub(crate) struct LegacyRow {
    pub id: String,
    pub root: String,
    pub path: String,
    pub revision: i64,
    pub app_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    id: String,
    revision: i64,
    app_count: usize,
    path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    status: &'static str,
    uuid: Option<String>,
    can_assign: bool,
    can_share: bool,
    legacy_candidates: Vec<Candidate>,
}
fn candidates(
    core: &Core,
    root: &str,
    path: &str,
    value: &Catalog,
) -> Result<Vec<LegacyRow>, String> {
    let rows = core
        .document_state
        .get()
        .ok_or("StorageUnavailable")?
        .identity_rows()?;
    let mut rows = unresolved_rows(rows, value);
    // Locations rank the review list but never authorize data inheritance.
    rows.sort_by_key(|row| (row.root != root || row.path != path, row.path != path));
    Ok(rows)
}
fn unresolved_rows(rows: Vec<LegacyRow>, value: &Catalog) -> Vec<LegacyRow> {
    let keys: std::collections::HashSet<_> = value
        .bindings
        .iter()
        .map(|b| storage_key(&b.uuid))
        .collect();
    rows.into_iter()
        .filter(|row| !keys.contains(&row.id) && !value.resolved_legacy.contains(&row.id))
        .collect()
}
fn has_legacy_at_path(rows: &[LegacyRow], root: &str, path: &str) -> bool {
    // A matching location warrants review, never automatic inheritance. A valid
    // new UUID elsewhere must not be held by unrelated profile-wide records.
    rows.iter().any(|row| row.root == root && row.path == path)
}
fn duplicate(core: &Core, value: &Catalog, uuid: &str, object: &str) -> Result<bool, String> {
    if value
        .bindings
        .iter()
        .any(|b| b.uuid == uuid && b.object == object && b.shared)
    {
        return Ok(false);
    }
    let mut others = value
        .bindings
        .iter()
        .filter(|b| b.uuid == uuid && b.object != object)
        .peekable();
    // Root verification is needed only when another object claims this UUID.
    if others.peek().is_none() {
        return Ok(false);
    }
    let registered = crate::managed_folders::registered_paths(core)?;
    let mut conflict = false;
    let mut shared_lineage = false;
    for binding in others {
        if !registered.contains(&binding.root) {
            conflict = true;
            continue;
        }
        if let Ok((root, dir)) = knowledge::open_root(&binding.root) {
            if knowledge::object_identity(&root, &dir, &binding.path)
                .ok()
                .as_deref()
                == Some(object)
            {
                shared_lineage |= binding.shared;
                continue;
            }
            if let Ok(source) = knowledge::read(&root, &dir, &binding.path) {
                if std::str::from_utf8(&source).ok().map(parse) == Some(Metadata::Uuid(uuid.into()))
                {
                    conflict = true;
                }
            }
        }
    }
    Ok(conflict && !shared_lineage)
}
pub(crate) fn capture_legacy(core: &Core, root: &Path, dir: &Arc<Dir>) -> Result<(), String> {
    let Some(store) = core.document_state.get() else {
        return Err("StorageUnavailable".into());
    };
    let root_id = knowledge::storage_root_identity(dir).map_err(|_| "StorageUnavailable")?;
    let (mut value, digest) = catalog(core)?;
    let mut changed = false;
    for row in store
        .identity_rows()?
        .into_iter()
        .filter(|row| row.root == root_id)
    {
        if knowledge::storage_identity(root, dir, &row.path)
            .ok()
            .as_deref()
            == Some(&row.id)
        {
            let object = knowledge::object_identity(root, dir, &row.path)?;
            if !value
                .legacy
                .iter()
                .any(|p| p.object == object && p.source == row.id)
            {
                value.legacy.push(LegacyProof {
                    object,
                    source: row.id,
                });
                changed = true;
            }
        }
    }
    if changed {
        profile_store::write(profile(core)?, CATALOG, digest.as_deref(), &value)?;
    }
    Ok(())
}

/// Called inside Core::gate with source and physical identity from admission.
pub(crate) fn admit(
    core: &Core,
    root: &Path,
    dir: &Arc<Dir>,
    path: &str,
    source: &str,
    physical: &str,
) -> Result<String, String> {
    let uuid = match parse(source) {
        Metadata::Missing => return Err("DocumentIdentityMissing".into()),
        Metadata::Invalid => return Err("DocumentIdentityInvalid".into()),
        Metadata::Uuid(id) => id,
    };
    let object = knowledge::object_identity(root, dir, path)?;
    let (mut value, digest) = catalog(core)?;
    if duplicate(core, &value, &uuid, &object)? {
        return Err("DocumentIdentityDuplicate".into());
    }
    let root_id = knowledge::storage_root_identity(dir).map_err(|_| "StorageUnavailable")?;
    let store = core.document_state.get().ok_or("StorageUnavailable")?;
    let key = storage_key(&uuid);
    if !store.has_identity(&key)? {
        let proven: std::collections::HashSet<_> = value
            .legacy
            .iter()
            .filter(|p| p.object == object)
            .map(|p| p.source.clone())
            .chain(std::iter::once(physical.into()))
            .collect();
        // Proof and unresolved-location checks share one validated snapshot;
        // rereading it would parse every saved payload a second time.
        let rows = store.identity_rows()?;
        let exact: Vec<_> = rows.iter().filter(|r| proven.contains(&r.id)).collect();
        if exact.len() > 1 {
            return Err("DocumentLegacyConflict".into());
        }
        if let Some(row) = exact.first() {
            store.copy_identity(&row.id, row.revision, &key, &root_id, path)?;
            value.resolved_legacy.push(row.id.clone());
        } else if has_legacy_at_path(&unresolved_rows(rows, &value), &root_id, path) {
            return Err("DocumentLegacyConflict".into());
        }
    }
    if let Some(binding) = value
        .bindings
        .iter_mut()
        .find(|b| b.uuid == uuid && b.object == object)
    {
        binding.root = root.into();
        binding.path = path.into();
        binding.physical = physical.into();
    } else {
        if value.bindings.len() >= 4096 {
            return Err("CapacityExceeded".into());
        }
        value.bindings.push(Binding {
            uuid,
            object,
            physical: physical.into(),
            root: root.into(),
            path: path.into(),
            shared: false,
        });
    }
    profile_store::write(profile(core)?, CATALOG, digest.as_deref(), &value)?;
    store.authorize_uuid(&key);
    Ok(key)
}

/// Main-host transfer already requires a separate explicit preview/confirmation.
/// Resolve source metadata without locking SQLite (the caller may hold it), and
/// retain duplicate refusal and the physical guarded read.
pub(crate) fn key_at(
    core: &Core,
    root: &Path,
    dir: &Arc<Dir>,
    path: &str,
) -> Result<String, String> {
    let read = knowledge::read_source_budgeted(root, dir, path, true, |_| Ok(()))
        .map_err(|e| e.to_string())?;
    let physical = read.storage_identity.ok_or("StorageUnavailable")?;
    if crate::managed_folders::marker_for_dir(root, dir)?.is_some() {
        let uuid = match parse(std::str::from_utf8(&read.data).map_err(|_| "StorageUnavailable")?) {
            Metadata::Uuid(uuid) => uuid,
            Metadata::Missing => return Err("DocumentIdentityMissing".into()),
            Metadata::Invalid => return Err("DocumentIdentityInvalid".into()),
        };
        let (value, _) = catalog(core)?;
        if duplicate(
            core,
            &value,
            &uuid,
            &knowledge::object_identity(root, dir, path)?,
        )? {
            return Err("DocumentIdentityDuplicate".into());
        }
        let key = storage_key(&uuid);
        core.document_state
            .get()
            .ok_or("StorageUnavailable")?
            .authorize_uuid(&key);
        Ok(key)
    } else {
        Ok(physical)
    }
}
fn current(
    core: &Core,
    workspace: &str,
    view: &str,
    path: &str,
) -> Result<(PathBuf, Arc<Dir>, Vec<u8>, String), String> {
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        Core::check_view(&state, workspace, view)?;
        if !knowledge::contains(&state.snapshot.nodes, path) {
            return Err("HTMLが見つかりません".into());
        }
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    if crate::managed_folders::marker_for_dir(&root, &dir)?.is_none() {
        return Err("専用フォルダーを登録してください".into());
    }
    let read = knowledge::read_source_budgeted(&root, &dir, path, true, |_| Ok(()))
        .map_err(|e| e.to_string())?;
    Ok((
        root,
        dir,
        read.data,
        read.storage_identity.ok_or("StorageUnavailable")?,
    ))
}
pub fn status(core: &Core, workspace: &str, view: &str, path: &str) -> Result<Status, String> {
    let _gate = core.gate.lock().unwrap();
    let (root, dir, data, physical) = current(core, workspace, view, path)?;
    let metadata = parse(std::str::from_utf8(&data).map_err(|_| "UTF-8で保存してください")?);
    let (value, _) = catalog(core)?;
    let root_id = knowledge::storage_root_identity(&dir).map_err(|_| "StorageUnavailable")?;
    let rows = candidates(core, &root_id, path, &value)?;
    let related_legacy = has_legacy_at_path(&rows, &root_id, path);
    let legacy_candidates: Vec<_> = rows
        .into_iter()
        .map(|row| Candidate {
            id: format!("{}:{}", row.id, row.revision),
            revision: row.revision,
            app_count: row.app_count,
            path: row.path,
        })
        .collect();
    let (status, uuid, can_assign, can_share) = match metadata {
        Metadata::Missing => {
            let object = knowledge::object_identity(&root, &dir, path)?;
            let proven = core
                .document_state
                .get()
                .ok_or("StorageUnavailable")?
                .identity_rows()?
                .iter()
                .any(|row| {
                    row.id == physical
                        || value
                            .legacy
                            .iter()
                            .any(|p| p.object == object && p.source == row.id)
                });
            (
                if !proven && !legacy_candidates.is_empty() {
                    "legacyConflict"
                } else {
                    "missing"
                },
                None,
                true,
                false,
            )
        }
        Metadata::Invalid => ("invalid", None, false, false),
        Metadata::Uuid(uuid) => {
            let duplicated = duplicate(
                core,
                &value,
                &uuid,
                &knowledge::object_identity(&root, &dir, path)?,
            )?;
            let has_state = core
                .document_state
                .get()
                .ok_or("StorageUnavailable")?
                .has_identity(&storage_key(&uuid))?;
            let legacy_conflict = !has_state && related_legacy;
            (
                if duplicated {
                    "duplicate"
                } else if legacy_conflict {
                    "legacyConflict"
                } else {
                    "ready"
                },
                Some(uuid),
                duplicated || legacy_conflict,
                duplicated,
            )
        }
    };
    Ok(Status {
        status,
        uuid,
        can_assign,
        can_share,
        legacy_candidates,
    })
}

fn edited_source(source: &str, uuid: &str, replace: bool) -> Result<String, String> {
    let tag = format!("<meta name=\"{META}\" content=\"{uuid}\">");
    if !replace {
        // A leading doctype is retained in its original position to preserve
        // standards mode. An explicit head is preferable when one is present.
        let lower = source.to_ascii_lowercase();
        let position = lower
            .find("<head")
            .filter(|i| {
                lower
                    .as_bytes()
                    .get(i + 5)
                    .is_some_and(|b| b.is_ascii_whitespace() || *b == b'>')
            })
            .and_then(|i| source[i..].find('>').map(|end| i + end + 1))
            .or_else(|| {
                lower
                    .find("<!doctype")
                    .and_then(|i| source[i..].find('>').map(|end| i + end + 1))
            })
            .unwrap_or(0);
        let result = format!("{}\n{tag}\n{}", &source[..position], &source[position..]);
        if parse(&result) == Metadata::Uuid(uuid.into()) {
            return Ok(result);
        }
    } else {
        // Candidate ranges are quote-aware; full inert parsing of the result
        // proves that only the actual static metadata was replaced. Decoys in
        // scripts/comments/templates cannot satisfy this postcondition.
        let lower = source.to_ascii_lowercase();
        for (start, _) in lower.match_indices("<meta").take(512) {
            let mut quote = None;
            for (offset, byte) in source.as_bytes()[start..].iter().copied().enumerate() {
                if let Some(q) = quote {
                    if byte == q {
                        quote = None;
                    }
                } else if byte == b'\'' || byte == b'"' {
                    quote = Some(byte);
                } else if byte == b'>' {
                    let end = start + offset + 1;
                    if matches!(parse(&source[start..end]), Metadata::Uuid(_)) {
                        let result = format!("{}{tag}{}", &source[..start], &source[end..]);
                        if parse(&result) == Metadata::Uuid(uuid.into()) {
                            return Ok(result);
                        }
                    }
                    break;
                }
            }
        }
    }
    Err("HTMLを安全に変更できません。制作ガイドに従ってIDを編集してください".into())
}
pub fn configure(
    core: &Core,
    workspace: &str,
    view: &str,
    path: &str,
    action: &str,
    source_identity: Option<&str>,
) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let (root, dir, data, physical) = current(core, workspace, view, path)?;
    let source = std::str::from_utf8(&data).map_err(|_| "UTF-8で保存してください")?;
    let metadata = parse(source);
    let object = knowledge::object_identity(&root, &dir, path)?;
    let (mut value, digest) = catalog(core)?;
    let root_id = knowledge::storage_root_identity(&dir).map_err(|_| "StorageUnavailable")?;
    let store = core.document_state.get().ok_or("StorageUnavailable")?;
    let uuid = match (&metadata, action) {
        (Metadata::Missing, "add" | "recover" | "new") => new_uuid(),
        (Metadata::Uuid(uuid), "share") if duplicate(core, &value, uuid, &object)? => uuid.clone(),
        (Metadata::Uuid(uuid), "new")
            if duplicate(core, &value, uuid, &object)?
                || (!store.has_identity(&storage_key(uuid))?
                    && has_legacy_at_path(
                        &candidates(core, &root_id, path, &value)?,
                        &root_id,
                        path,
                    )) =>
        {
            new_uuid()
        }
        (Metadata::Uuid(uuid), "recover") => uuid.clone(),
        _ => return Err("文書の状態が変更されたか、この操作は利用できません".into()),
    };
    let key = storage_key(&uuid);
    if action == "recover" {
        let token = source_identity.ok_or("復旧する記録を選択してください")?;
        let row = candidates(core, &root_id, path, &value)?
            .into_iter()
            .find(|r| format!("{}:{}", r.id, r.revision) == token)
            .ok_or("復旧候補が変更されました。確認し直してください")?;
        store.copy_identity(&row.id, row.revision, &key, &root_id, path)?;
        value.resolved_legacy.push(row.id);
    } else if action == "add" {
        let proofs: std::collections::HashSet<_> = value
            .legacy
            .iter()
            .filter(|p| p.object == object)
            .map(|p| p.source.clone())
            .chain(std::iter::once(physical.clone()))
            .collect();
        let rows: Vec<_> = store
            .identity_rows()?
            .into_iter()
            .filter(|r| proofs.contains(&r.id))
            .collect();
        if rows.len() > 1
            || (rows.is_empty() && !candidates(core, &root_id, path, &value)?.is_empty())
        {
            return Err("旧保存データがあります。復旧する記録を明示的に選択してください".into());
        }
        if let Some(row) = rows.first() {
            store.copy_identity(&row.id, row.revision, &key, &root_id, path)?;
            value.resolved_legacy.push(row.id.clone());
        }
    }
    if action == "new" {
        store.initialize_identity(&key, &root_id, path)?;
    }
    if action == "add" || action == "new" || (action == "recover" && metadata == Metadata::Missing)
    {
        let output = edited_source(source, &uuid, matches!(metadata, Metadata::Uuid(_)))?;
        let relative = knowledge::validate_relative(path)?;
        let parent_relative = path.rsplit_once('/').map_or("", |(parent, _)| parent);
        let parent = write_fs::LockedDir::open(&dir, parent_relative)?;
        let leaf = relative
            .file_name()
            .unwrap()
            .to_str()
            .ok_or("HTML名を確認してください")?;
        // An immutable source copy is durable before replacement. DB source rows
        // are never deleted; a crash at either side of publication is recoverable.
        let backup = profile_store::backup_document(profile(core)?, &data)?;
        profile_store::write(
            profile(core)?,
            &format!("{backup}.json"),
            None,
            &serde_json::json!({"version":1,"uuid":uuid,"sourceHash":profile_store::digest(&data),"path":path}),
        )?;
        let (temporary, mut staged) =
            write_fs::create_temporary(parent.dir()).map_err(|_| "HTMLを書き込めません")?;
        let result = (|| {
            staged
                .write_all(output.as_bytes())
                .and_then(|_| staged.sync_all())
                .map_err(|_| "HTMLを書き込めません")?;
            parent.revalidate(&root, &dir)?;
            if knowledge::storage_identity(&root, &dir, path)? != physical {
                return Err("HTMLが変更されました。上書きしません".into());
            }
            write_fs::replace_checked(
                parent.dir(),
                &temporary,
                &staged,
                leaf,
                Some(&profile_store::digest(&data)),
                knowledge::MAX_SOURCE_BYTES,
            )
            .map_err(|_| {
                "HTMLが変更されたか書き込めません。元データと退避を保持しました".to_owned()
            })
        })();
        if result.is_err() {
            let _ = write_fs::remove_temporary(parent.dir(), &temporary, &staged);
        }
        result?;
    }
    let next_object = knowledge::object_identity(&root, &dir, path)?;
    let next_physical = knowledge::storage_identity(&root, &dir, path)?;
    value
        .bindings
        .retain(|b| !(b.uuid == uuid && b.object == next_object));
    if action == "share" {
        for binding in value.bindings.iter_mut().filter(|b| b.uuid == uuid) {
            binding.shared = true;
        }
    }
    value.bindings.push(Binding {
        uuid,
        object: next_object,
        physical: next_physical,
        root,
        path: path.into(),
        shared: action == "share",
    });
    profile_store::write(profile(core)?, CATALOG, digest.as_deref(), &value)?;
    store.authorize_uuid(&key);
    // Configuration grants no iframe authority; all old document grants revoke.
    let mut state = core.workspace.lock().unwrap();
    for tab in state.tabs.values_mut().filter(|tab| tab.entry == path) {
        tab.session = None;
        tab.revocation += 1;
        tab.expected_identity = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_state::{self, DocumentState, Operation, StateRequest};
    use serde_json::json;
    const ID: &str = "ac3f9180-126f-4019-8a5d-9fb6e08c8091";
    fn html(id: &str) -> String {
        format!("<!doctype html><html><head><meta name=\"{META}\" content=\"{id}\"></head><body><input value=\"original\"></body></html>")
    }
    struct Fixture {
        roots: tempfile::TempDir,
        profile: tempfile::TempDir,
        core: Arc<Core>,
    }
    impl Fixture {
        fn new() -> Self {
            let roots = tempfile::tempdir().unwrap();
            let profile = tempfile::tempdir().unwrap();
            let core = Core::new(19270);
            core.settings_path
                .set(profile.path().join("settings.json"))
                .unwrap();
            core.document_state
                .set(DocumentState::new(profile.path().join("document-state")).unwrap())
                .ok()
                .unwrap();
            Self {
                roots,
                profile,
                core,
            }
        }
        fn folder(&self, name: &str) -> PathBuf {
            let path = self.roots.path().join(name);
            std::fs::create_dir(&path).unwrap();
            path
        }
        fn register(&self, path: &Path) {
            let current = crate::managed_folders::list(&self.core).unwrap();
            crate::managed_folders::register(&self.core, path, None, &current.revision).unwrap();
        }
        fn select(&self, path: &Path) -> crate::core::Snapshot {
            let snapshot = self.core.select(path, false).unwrap();
            self.core.watcher.lock().unwrap().take();
            snapshot
        }
        fn open(&self, snapshot: &crate::core::Snapshot, path: &str) -> String {
            let ws = snapshot.workspace_id.as_deref().unwrap();
            let tab = self.core.create_tab(ws, &snapshot.view_id, path).unwrap();
            self.core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
            self.core.workspace.lock().unwrap().tabs[&tab]
                .session
                .as_ref()
                .unwrap()
                .token
                .clone()
        }
        fn read(&self, token: &str) -> Result<serde_json::Value, document_state::StateError> {
            document_state::operate(
                &self.core,
                token,
                StateRequest {
                    version: 1,
                    op: Operation::Read,
                    key: "app".into(),
                    value: None,
                },
            )
            .map(|r| r.value)
        }
        fn write(&self, token: &str) {
            document_state::operate(
                &self.core,
                token,
                StateRequest {
                    version: 1,
                    op: Operation::Write,
                    key: "app".into(),
                    value: Some(json!({"name":"retained"})),
                },
            )
            .unwrap();
        }
    }
    #[test]
    fn duplicate_opens_registered_roots_only_for_another_object_with_the_same_uuid() {
        let core = Core::new(19271);
        // No profile is configured: a registry read would fail. Unrelated UUIDs
        // and this object's existing binding do not require that I/O.
        let mut value = Catalog::default();
        assert!(!duplicate(&core, &value, ID, "current-object").unwrap());
        value.bindings.push(Binding {
            uuid: new_uuid(),
            object: "other-object".into(),
            physical: "synthetic".into(),
            root: std::env::temp_dir(),
            path: "synthetic.html".into(),
            shared: false,
        });
        assert!(!duplicate(&core, &value, ID, "current-object").unwrap());
        value.bindings[0].uuid = ID.into();
        value.bindings[0].object = "current-object".into();
        assert!(!duplicate(&core, &value, ID, "current-object").unwrap());
        value.bindings[0].object = "other-object".into();
        assert!(duplicate(&core, &value, ID, "current-object").is_err());
    }
    #[test]
    #[cfg(windows)]
    fn nested_windows_object_proof_and_uuid_admission() {
        let f = Fixture::new();
        let root = f.folder("synthetic-documents");
        std::fs::create_dir_all(root.join("資料/二階層")).unwrap();
        let paths = [
            "direct.html",
            "資料/control.html",
            "資料/二階層/calculator.html",
        ];
        for path in paths {
            std::fs::write(root.join(path), html(&new_uuid())).unwrap();
        }
        f.register(&root);
        let (root, dir) = knowledge::open_root(&root).unwrap();
        let _gate = f.core.gate.lock().unwrap();
        for path in paths {
            knowledge::object_identity(&root, &dir, path).unwrap();
            let physical = knowledge::storage_identity(&root, &dir, path).unwrap();
            let source = std::fs::read_to_string(root.join(path)).unwrap();
            admit(&f.core, &root, &dir, path, &source, &physical).unwrap();
        }
    }
    #[test]
    fn nested_metadata_add_retains_original_html_backup_and_allows_storage() {
        let f = Fixture::new();
        let root = f.folder("synthetic-documents");
        let relative = "資料/二階層/tool.html";
        std::fs::create_dir_all(root.join(relative).parent().unwrap()).unwrap();
        let original =
            "<!doctype html><html><head><title>人工文書</title></head><body><input></body></html>";
        std::fs::write(root.join(relative), original).unwrap();
        f.register(&root);
        let snapshot = f.select(&root);
        configure(
            &f.core,
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            relative,
            "add",
            None,
        )
        .unwrap();
        let edited = std::fs::read_to_string(root.join(relative)).unwrap();
        assert!(matches!(parse(&edited), Metadata::Uuid(_)));
        let token = f.open(&snapshot, relative);
        f.write(&token);
        assert_eq!(f.read(&token).unwrap(), json!({"name":"retained"}));
        let backups: Vec<_> = std::fs::read_dir(f.profile.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".html"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            original
        );
    }
    #[test]
    #[cfg(windows)]
    fn external_backslashes_and_escape_paths_stay_rejected() {
        let root = tempfile::tempdir().unwrap();
        let (path, dir) = knowledge::open_root(root.path()).unwrap();
        for relative in [
            "資料\\二階層\\tool.html",
            "../tool.html",
            "/tool.html",
            "C:/tool.html",
            "資料/.hidden/tool.html",
        ] {
            assert!(knowledge::validate_relative(relative).is_err());
            assert!(knowledge::object_identity(&path, &dir, relative).is_err());
        }
    }
    #[test]
    fn uuid_parser_ignores_inert_content_and_rejects_bad_or_multiple_ids() {
        let inert = format!(
            "<!--{}--><script>const x='{}'</script><template>{}</template>",
            html(ID),
            html(ID),
            html(ID)
        );
        assert_eq!(parse(&inert), Metadata::Missing);
        assert_eq!(parse(&html(&ID.to_uppercase())), Metadata::Uuid(ID.into()));
        assert_eq!(
            parse(&format!("{}{}", html(ID), html(ID))),
            Metadata::Invalid
        );
        for invalid in [
            "00000000-0000-0000-0000-000000000000",
            "REPLACE_WITH_NEW_UUID",
            "not-a-uuid",
        ] {
            assert_eq!(parse(&html(invalid)), Metadata::Invalid);
        }
        let custom = "ac3f9180-126f-f019-fa5d-9fb6e08c8091";
        assert_eq!(parse(&html(custom)), Metadata::Uuid(custom.into()));
    }
    #[test]
    fn unrelated_legacy_does_not_hold_fresh_uuids_but_missing_ids_require_explicit_recovery() {
        for same_root in [false, true] {
            let f = Fixture::new();
            let root = f.folder("docs");
            let (canonical, dir) = knowledge::open_root(&root).unwrap();
            let root_id = knowledge::storage_root_identity(&dir).unwrap();
            drop((canonical, dir));
            std::fs::write(
                root.join("uncertain.html"),
                "<!doctype html><head></head><input>",
            )
            .unwrap();
            std::fs::write(root.join("fresh.html"), html(ID)).unwrap();
            let database =
                rusqlite::Connection::open(f.profile.path().join("document-state/state.sqlite"))
                    .unwrap();
            let old = "e".repeat(64);
            let data = "{\"app\":{\"name\":\"old uncertain\"}}";
            database
                .execute(
                    "INSERT INTO documents VALUES(?1,?2,?3,4,?4,?5,1)",
                    rusqlite::params![
                        old,
                        data,
                        data.len() as i64,
                        if same_root { root_id } else { "d".repeat(64) },
                        if same_root {
                            "unrelated-old-name.html"
                        } else {
                            "fresh.html"
                        }
                    ],
                )
                .unwrap();
            database
                .execute(
                    "UPDATE quota SET bytes=?1,documents=1,generation=1",
                    [data.len() as i64],
                )
                .unwrap();
            drop(database);
            f.register(&root);
            let snapshot = f.select(&root);
            let ws = snapshot.workspace_id.as_deref().unwrap();
            let current = status(&f.core, ws, &snapshot.view_id, "uncertain.html").unwrap();
            assert_eq!(current.status, "legacyConflict");
            assert!(current.uuid.is_none());
            assert_eq!(current.legacy_candidates.len(), 1);
            assert!(configure(
                &f.core,
                ws,
                &snapshot.view_id,
                "uncertain.html",
                "add",
                None
            )
            .is_err());
            let fresh_status = status(&f.core, ws, &snapshot.view_id, "fresh.html").unwrap();
            assert_eq!(fresh_status.status, "ready");
            assert_eq!(fresh_status.uuid.as_deref(), Some(ID));
            assert!(!fresh_status.can_assign);
            assert!(configure(&f.core, ws, &snapshot.view_id, "fresh.html", "new", None).is_err());
            let fresh = f.open(&snapshot, "fresh.html");
            assert_eq!(f.read(&fresh).unwrap(), serde_json::Value::Null);
            f.write(&fresh);
            let reloaded = f.open(&snapshot, "fresh.html");
            assert_eq!(f.read(&reloaded).unwrap(), json!({"name":"retained"}));
            assert_eq!(
                std::fs::read_to_string(root.join("fresh.html")).unwrap(),
                html(ID)
            );
            assert_eq!(
                status(&f.core, ws, &snapshot.view_id, "fresh.html")
                    .unwrap()
                    .status,
                "ready"
            );
            assert!(configure(
                &f.core,
                ws,
                &snapshot.view_id,
                "uncertain.html",
                "recover",
                Some(&format!("{old}:3"))
            )
            .is_err());
            configure(
                &f.core,
                ws,
                &snapshot.view_id,
                "uncertain.html",
                "recover",
                Some(&current.legacy_candidates[0].id),
            )
            .unwrap();
            let recovered = f.open(&snapshot, "uncertain.html");
            assert_eq!(f.read(&recovered).unwrap(), json!({"name":"old uncertain"}));
            assert!(f
                .core
                .document_state
                .get()
                .unwrap()
                .has_identity(&old)
                .unwrap());
            let key = f
                .core
                .session_for_token(&fresh)
                .unwrap()
                .logical_storage_identity
                .unwrap();
            assert!(f
                .core
                .document_state
                .get()
                .unwrap()
                .copy_identity(&old, 4, &key, "f", "fresh.html")
                .is_err());
            assert_eq!(f.read(&reloaded).unwrap(), json!({"name":"retained"}));
        }
    }
    #[test]
    fn same_path_unproven_legacy_requires_review_and_retains_original_on_explicit_new() {
        let f = Fixture::new();
        let root = f.folder("docs");
        let source = html(ID);
        std::fs::write(root.join("held.html"), &source).unwrap();
        let (canonical, dir) = knowledge::open_root(&root).unwrap();
        let root_id = knowledge::storage_root_identity(&dir).unwrap();
        let old = "e".repeat(64);
        assert_ne!(
            knowledge::storage_identity(&canonical, &dir, "held.html").unwrap(),
            old
        );
        drop((canonical, dir));
        let database =
            rusqlite::Connection::open(f.profile.path().join("document-state/state.sqlite"))
                .unwrap();
        let data = "{\"app\":{\"name\":\"old uncertain\"}}";
        database
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,4,?4,'held.html',1)",
                rusqlite::params![old, data, data.len() as i64, root_id],
            )
            .unwrap();
        database
            .execute(
                "UPDATE quota SET bytes=?1,documents=1,generation=1",
                [data.len() as i64],
            )
            .unwrap();
        drop(database);
        f.register(&root);
        let snapshot = f.select(&root);
        let ws = snapshot.workspace_id.as_deref().unwrap();
        assert_eq!(
            status(&f.core, ws, &snapshot.view_id, "held.html")
                .unwrap()
                .status,
            "legacyConflict"
        );
        let held = f.open(&snapshot, "held.html");
        assert!(f.read(&held).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("held.html")).unwrap(),
            source
        );
        assert!(!f
            .core
            .document_state
            .get()
            .unwrap()
            .has_identity(&storage_key(ID))
            .unwrap());
        configure(&f.core, ws, &snapshot.view_id, "held.html", "new", None).unwrap();
        let fresh = f.open(&snapshot, "held.html");
        assert_eq!(f.read(&fresh).unwrap(), serde_json::Value::Null);
        assert_ne!(
            parse(&std::fs::read_to_string(root.join("held.html")).unwrap()),
            Metadata::Uuid(ID.into())
        );
        let database =
            rusqlite::Connection::open(f.profile.path().join("document-state/state.sqlite"))
                .unwrap();
        let retained: (String, i64) = database
            .query_row(
                "SELECT data,revision FROM documents WHERE id=?1",
                [&old],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(retained, (data.into(), 4));
    }
    #[cfg(windows)]
    #[test]
    fn locked_metadata_write_retains_original_html_and_durable_backup() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let root = f.folder("docs");
        let source = "<!doctype html><head></head><input value=\"keep\">";
        std::fs::write(root.join("a.html"), source).unwrap();
        f.register(&root);
        let snapshot = f.select(&root);
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.join("a.html"))
            .unwrap();
        assert!(configure(
            &f.core,
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            "a.html",
            "add",
            None
        )
        .is_err());
        drop(lock);
        assert_eq!(
            std::fs::read_to_string(root.join("a.html")).unwrap(),
            source
        );
        assert!(std::fs::read_dir(f.profile.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("document-identity-backup-")
                && entry.path().extension().is_some_and(|e| e == "html")));
    }
    #[test]
    fn uuid_state_survives_rename_cross_folder_move_replacement_and_restart() {
        let f = Fixture::new();
        let one = f.folder("one");
        let two = f.folder("two");
        std::fs::write(one.join("a.html"), html(ID)).unwrap();
        f.register(&one);
        f.register(&two);
        let first = f.select(&one);
        let old_token = f.open(&first, "a.html");
        f.write(&old_token);
        std::fs::create_dir(two.join("nested")).unwrap();
        std::fs::rename(one.join("a.html"), two.join("nested/renamed.html")).unwrap();
        let moved = f.select(&two);
        let token = f.open(&moved, "nested/renamed.html");
        assert_eq!(f.read(&token).unwrap(), json!({"name":"retained"}));
        assert!(f.read(&old_token).is_err());
        std::fs::write(
            two.join("nested/replacement.tmp"),
            html(ID).replace("original", "replaced"),
        )
        .unwrap();
        std::fs::remove_file(two.join("nested/renamed.html")).unwrap();
        std::fs::rename(
            two.join("nested/replacement.tmp"),
            two.join("nested/renamed.html"),
        )
        .unwrap();
        assert!(f.read(&token).is_err());
        let token = f.open(&moved, "nested/renamed.html");
        assert_eq!(f.read(&token).unwrap(), json!({"name":"retained"}));
        // A new Core with the same DB and catalog exercises startup binding,
        // rather than relying on process-local UUID admissions.
        let profile = f.profile.path().to_owned();
        drop(f.core);
        let core = Core::new(19271);
        core.settings_path
            .set(profile.join("settings.json"))
            .unwrap();
        core.document_state
            .set(DocumentState::new(profile.join("document-state")).unwrap())
            .ok()
            .unwrap();
        let snapshot = core.select(&two, false).unwrap();
        core.watcher.lock().unwrap().take();
        let ws = snapshot.workspace_id.as_deref().unwrap();
        let tab = core
            .create_tab(ws, &snapshot.view_id, "nested/renamed.html")
            .unwrap();
        core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
        let token = core.workspace.lock().unwrap().tabs[&tab]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone();
        assert_eq!(
            document_state::operate(
                &core,
                &token,
                StateRequest {
                    version: 1,
                    op: Operation::Read,
                    key: "app".into(),
                    value: None
                }
            )
            .unwrap()
            .value,
            json!({"name":"retained"})
        );
    }
    #[test]
    fn copied_uuid_requires_share_or_new_and_metadata_edits_revoke_old_grants() {
        let f = Fixture::new();
        let root = f.folder("docs");
        std::fs::write(root.join("a.html"), html(ID)).unwrap();
        std::fs::write(root.join("b.html"), html(ID)).unwrap();
        f.register(&root);
        let snapshot = f.select(&root);
        let ws = snapshot.workspace_id.as_deref().unwrap();
        let a = f.open(&snapshot, "a.html");
        f.write(&a);
        let b = f.open(&snapshot, "b.html");
        assert!(f.read(&b).is_err());
        assert_eq!(
            status(&f.core, ws, &snapshot.view_id, "b.html")
                .unwrap()
                .status,
            "duplicate"
        );
        configure(&f.core, ws, &snapshot.view_id, "b.html", "share", None).unwrap();
        assert!(f.read(&b).is_err());
        let shared = f.open(&snapshot, "b.html");
        assert_eq!(f.read(&shared).unwrap(), json!({"name":"retained"}));
        let a = f.open(&snapshot, "a.html");
        assert!(f.read(&a).is_ok());
        std::fs::write(root.join("c.html"), html(ID)).unwrap();
        f.core.apply_change(ws, vec!["c.html".into()], true, None);
        configure(&f.core, ws, &snapshot.view_id, "c.html", "new", None).unwrap();
        let fresh = f.open(&snapshot, "c.html");
        assert_eq!(f.read(&fresh).unwrap(), serde_json::Value::Null);
        std::fs::write(root.join("b.html"), html(&new_uuid())).unwrap();
        assert!(f.read(&shared).is_err());
        assert_eq!(f.read(&a).unwrap(), json!({"name":"retained"}));
    }
    #[test]
    fn explicit_add_migrates_proven_legacy_data_and_retains_original_row_and_html_backup() {
        let f = Fixture::new();
        let one = f.folder("one");
        let two = f.folder("two");
        let original =
            "<!doctype html><html><head><title>旧文書</title></head><body><input></body></html>";
        std::fs::write(one.join("legacy.html"), original).unwrap();
        let (canonical, dir) = knowledge::open_root(&one).unwrap();
        let old = knowledge::storage_identity(&canonical, &dir, "legacy.html").unwrap();
        let root_id = knowledge::storage_root_identity(&dir).unwrap();
        drop(dir);
        let database =
            rusqlite::Connection::open(f.profile.path().join("document-state/state.sqlite"))
                .unwrap();
        let data = "{\"app\":{\"name\":\"retained\"}}";
        database
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,1,?4,'legacy.html',1)",
                rusqlite::params![old, data, data.len() as i64, root_id],
            )
            .unwrap();
        database
            .execute(
                "UPDATE quota SET bytes=?1,documents=1,generation=1",
                [data.len() as i64],
            )
            .unwrap();
        drop(database);
        f.register(&one);
        f.register(&two);
        std::fs::rename(one.join("legacy.html"), two.join("legacy.html")).unwrap();
        let snapshot = f.select(&two);
        let ws = snapshot.workspace_id.as_deref().unwrap();
        let denied = f.open(&snapshot, "legacy.html");
        assert!(f.read(&denied).is_err());
        configure(&f.core, ws, &snapshot.view_id, "legacy.html", "add", None).unwrap();
        let token = f.open(&snapshot, "legacy.html");
        assert_eq!(f.read(&token).unwrap(), json!({"name":"retained"}));
        assert!(f
            .core
            .document_state
            .get()
            .unwrap()
            .has_identity(&old)
            .unwrap());
        let backups: Vec<_> = std::fs::read_dir(f.profile.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".html"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            std::fs::read_to_string(backups[0].path()).unwrap(),
            original
        );
    }
}
