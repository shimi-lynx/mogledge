//! Small, device-local workspace preferences. Document bodies and input DBs are untouched.
use crate::{
    core::{Core, Workspace},
    knowledge,
    write_fs::LockedDir,
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Read, Write},
    sync::Arc,
    time::{Duration, Instant},
};

pub const LIST_LIMIT: usize = 50;
const MAX_BYTES: usize = 256 * 1024;
const LEGACY_MAX_BYTES: usize = 64 * 1024;
pub const SET_LIMIT: usize = 10;
pub type SetShortcuts = [Option<String>; SET_LIMIT];
pub const SET_ITEM_LIMIT: usize = 30;
const WRITE_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRef {
    pub relative_path: String,
    pub identity: String,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lists {
    pub favorites: Vec<DocumentRef>,
    pub recent: Vec<DocumentRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetItem {
    pub document: DocumentRef,
    pub column: u8,
    pub zoom: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingSet {
    pub id: String,
    pub name: String,
    pub items: Vec<SetItem>,
    pub active: [Option<usize>; 2],
    pub active_column: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHelp {
    pub index: usize,
    pub column: u8,
    pub zoom: f64,
    pub active: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TabSession {
    pub items: Vec<SetItem>,
    pub active: [Option<usize>; 2],
    pub active_column: u8,
    pub split: bool,
    #[serde(default)]
    pub help: Option<SessionHelp>,
}
fn valid_session(session: &TabSession) -> bool {
    session.help.as_ref().is_none_or(|help| {
        help.index <= session.items.len()
            && help.column <= 1
            && help.zoom.is_finite()
            && (50.0..=200.0).contains(&help.zoom)
    }) && session.active_column <= 1
        && (session.split || session.active_column == 0)
        && session.items.iter().all(|item| {
            valid_document(&item.document)
                && item.column <= 1
                && item.zoom.is_finite()
                && (50.0..=200.0).contains(&item.zoom)
        })
        && (0..2).all(|column| match session.active[column] {
            Some(index) => session
                .items
                .get(index)
                .is_some_and(|item| usize::from(item.column) == column),
            None => {
                (!session.split && column == 1)
                    || !session
                        .items
                        .iter()
                        .any(|item| usize::from(item.column) == column)
            }
        })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStored {
    version: u8,
    root_identity: String,
    lists: Lists,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStoredV2 {
    version: u8,
    root_identity: String,
    lists: Lists,
    sets: Vec<WorkingSet>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStoredV3 {
    version: u8,
    root_identity: String,
    lists: Lists,
    sets: Vec<WorkingSet>,
    folder_favorites: Vec<DocumentRef>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    root_identity: String,
    lists: Lists,
    sets: Vec<WorkingSet>,
    folder_favorites: Vec<DocumentRef>,
    #[serde(default)]
    set_shortcuts: SetShortcuts,
    #[serde(default)]
    session: Option<TabSession>,
}

#[derive(Clone, Default)]
pub struct Settings {
    root_identity: String,
    lists: Lists,
    folder_favorites: Vec<DocumentRef>,
    error: Option<String>,
    read_only: bool,
    dirty: bool,
    flush_pending: bool,
    stored_hash: Option<String>,
    sets: Vec<WorkingSet>,
    set_shortcuts: SetShortcuts,
    session: Option<TabSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    #[serde(flatten)]
    pub document: DocumentRef,
    pub status: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSnapshot {
    pub folder_favorites: Vec<ListEntry>,
    pub favorites: Vec<ListEntry>,
    pub recent: Vec<ListEntry>,
    pub error: Option<String>,
    pub read_only: bool,
}

fn valid_identity(identity: &str) -> bool {
    identity.len() == 64
        && identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
pub(crate) fn valid_list(list: &[DocumentRef]) -> bool {
    let mut seen = HashSet::new();
    list.len() <= LIST_LIMIT
        && list
            .iter()
            .all(|entry| valid_document(entry) && seen.insert(&entry.identity))
}
fn valid_reference(entry: &DocumentRef) -> bool {
    knowledge::validate_relative(&entry.relative_path).is_ok()
        && entry.relative_path.len() <= 4096
        && valid_identity(&entry.identity)
}
fn valid_document(entry: &DocumentRef) -> bool {
    valid_reference(entry) && knowledge::is_html(&entry.relative_path)
}
pub(crate) fn valid_favorites(lists: &Lists, folders: &[DocumentRef]) -> bool {
    let mut seen = HashSet::new();
    valid_list(&lists.favorites)
        && lists.favorites.len() + folders.len() <= LIST_LIMIT
        && lists
            .favorites
            .iter()
            .chain(folders)
            .all(|entry| valid_reference(entry) && seen.insert(&entry.identity))
}
fn valid_set(set: &WorkingSet) -> bool {
    let mut seen = HashSet::new();
    valid_identity(&set.id)
        && !set.name.trim().is_empty()
        && set.name == set.name.trim()
        && set.name.len() <= 160
        && !set.name.chars().any(char::is_control)
        && !set.items.is_empty()
        && set.items.len() <= SET_ITEM_LIMIT
        && set.active_column <= 1
        && set.items.iter().all(|item| {
            valid_document(&item.document)
                && item.column <= 1
                && item.zoom.is_finite()
                && (50.0..=200.0).contains(&item.zoom)
                && seen.insert((item.column, &item.document.identity))
        })
        && (0..2).all(|column| {
            let has_items = set
                .items
                .iter()
                .any(|item| usize::from(item.column) == column);
            match set.active[column] {
                Some(index) => set
                    .items
                    .get(index)
                    .is_some_and(|item| usize::from(item.column) == column),
                None => !has_items,
            }
        })
        && set.active[usize::from(set.active_column)].is_some()
}
pub(crate) fn valid_sets(sets: &[WorkingSet]) -> bool {
    let mut seen = HashSet::new();
    sets.len() <= SET_LIMIT
        && sets
            .iter()
            .all(|set| valid_set(set) && seen.insert(&set.id))
}
pub(crate) fn valid_set_shortcuts(shortcuts: &SetShortcuts, sets: &[WorkingSet]) -> bool {
    let mut assigned = HashSet::new();
    shortcuts
        .iter()
        .flatten()
        .all(|id| assigned.insert(id) && sets.iter().any(|set| &set.id == id))
}
fn encoded(settings: &Settings) -> Result<Vec<u8>, String> {
    if !valid_identity(&settings.root_identity)
        || !valid_favorites(&settings.lists, &settings.folder_favorites)
        || !valid_list(&settings.lists.recent)
        || !valid_sets(&settings.sets)
        || !valid_set_shortcuts(&settings.set_shortcuts, &settings.sets)
        || settings
            .session
            .as_ref()
            .is_some_and(|session| !valid_session(session))
    {
        return Err(
            "端末設定の形式が無効です。参照パスはUTF-8で4096bytes以下、お気に入りは合計50件までです".into(),
        );
    }
    let data = serde_json::to_vec(&Stored {
        version: 5,
        root_identity: settings.root_identity.clone(),
        lists: settings.lists.clone(),
        sets: settings.sets.clone(),
        folder_favorites: settings.folder_favorites.clone(),
        set_shortcuts: settings.set_shortcuts.clone(),
        session: settings.session.clone(),
    })
    .map_err(|_| "端末設定を作成できません")?;
    if data.len() > MAX_BYTES {
        return Err("端末設定は256KiB以下にしてください。保存済みの内容は保持します".into());
    }
    Ok(data)
}

// Hold every directory handle through read/atomic replacement. A linked/replaced
// settings directory cannot redirect writes outside the selected app profile.
fn directory(
    core: &Core,
    create: bool,
) -> Result<(std::path::PathBuf, Arc<Dir>, LockedDir), String> {
    let parent = core
        .settings_path
        .get()
        .and_then(|path| path.parent())
        .ok_or("端末設定の保存先が未初期化です")?;
    let (root, dir) = knowledge::open_root(parent)?;
    if create {
        match dir.create_dir("workspace-settings") {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("端末設定フォルダーを作成できません".into()),
        }
    }
    let locked = LockedDir::open(&dir, "workspace-settings")?;
    Ok((root, dir, locked))
}
// Device preference readers need data access; mutation identity handles are
// metadata-only on Windows. Callers validate the opened handle and bound bytes.
pub(crate) fn read_file(dir: &Dir, name: &str) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use rustix::fs::{openat, Mode, OFlags};
        Ok(std::fs::File::from(openat(
            dir,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )?))
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        // Inspect first without recalling placeholders, then reject reparse handles.
        crate::write_fs::entry_is_directory(dir, name)?;
        let mut options = cap_std::fs::OpenOptions::new();
        options
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000 | 0x00100000);
        dir.open_with(name, &options).map(|file| file.into_std())
    }
}
fn content_hash(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(data))
}
type LoadedLists = (
    Lists,
    Vec<DocumentRef>,
    Vec<WorkingSet>,
    SetShortcuts,
    Option<TabSession>,
    Option<String>,
);
fn load_lists(core: &Core, identity: &str) -> Result<LoadedLists, String> {
    let parent = core
        .settings_path
        .get()
        .and_then(|path| path.parent())
        .ok_or("端末設定の保存先が未初期化です")?;
    match std::fs::symlink_metadata(parent.join("workspace-settings")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                Lists::default(),
                vec![],
                vec![],
                Default::default(),
                None,
                None,
            ))
        }
        Err(_) => return Err("端末設定フォルダーを読み取れません".into()),
        Ok(_) => {}
    }
    let (root, original, locked) = directory(core, false)?;
    let file = match read_file(locked.dir(), &format!("{identity}.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                Lists::default(),
                vec![],
                vec![],
                Default::default(),
                None,
                None,
            ))
        }
        Err(_) => return Err("端末設定を読み取れません。保存済みの内容は保持します".into()),
        Ok(file) => file,
    };
    let metadata = file.metadata().map_err(|_| "端末設定を読み取れません")?;
    if crate::write_fs::rejected_link(&metadata) || !metadata.is_file() {
        return Err("端末設定が通常ファイルではありません".into());
    }
    let mut data = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "端末設定を読み取れません")?;
    if data.len() > MAX_BYTES {
        return Err("端末設定が256KiBを超えています".into());
    }
    // Each old version retains its strict topology. Older readers reject v5;
    // malformed/unknown future data is never silently replaced.
    let value: serde_json::Value = serde_json::from_slice(&data)
        .map_err(|_| "端末設定JSONが壊れています。上書きせず保持します")?;
    let stored = match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(1) => {
            if data.len() > LEGACY_MAX_BYTES {
                return Err("旧端末設定が64KiBを超えています。原本を保持します".into());
            }
            let legacy: LegacyStored = serde_json::from_slice(&data)
                .map_err(|_| "旧端末設定の形式が無効です。原本を保持します")?;
            Stored {
                version: legacy.version,
                root_identity: legacy.root_identity,
                lists: legacy.lists,
                sets: vec![],
                folder_favorites: vec![],
                set_shortcuts: Default::default(),
                session: None,
            }
        }
        Some(2) => {
            let legacy: LegacyStoredV2 = serde_json::from_slice(&data)
                .map_err(|_| "端末設定の形式が無効です。原本を保持します")?;
            Stored {
                version: legacy.version,
                root_identity: legacy.root_identity,
                lists: legacy.lists,
                sets: legacy.sets,
                folder_favorites: vec![],
                set_shortcuts: Default::default(),
                session: None,
            }
        }
        Some(3) => {
            let legacy: LegacyStoredV3 = serde_json::from_slice(&data)
                .map_err(|_| "端末設定の形式が無効です。原本を保持します")?;
            Stored {
                version: legacy.version,
                root_identity: legacy.root_identity,
                lists: legacy.lists,
                sets: legacy.sets,
                folder_favorites: legacy.folder_favorites,
                set_shortcuts: Default::default(),
                session: None,
            }
        }
        Some(4) if value.get("session").is_none() => {
            serde_json::from_slice(&data).map_err(|_| "TabSessionInvalid".to_owned())?
        }
        Some(5) => serde_json::from_slice(&data)
            .map_err(|_| "端末設定の形式が無効です。原本を保持します")?,
        _ => return Err("未対応の端末設定です。上書きせず保持します".into()),
    };
    if stored.root_identity != identity
        || !valid_favorites(&stored.lists, &stored.folder_favorites)
        || !valid_list(&stored.lists.recent)
        || !valid_sets(&stored.sets)
        || !valid_set_shortcuts(&stored.set_shortcuts, &stored.sets)
        || stored
            .session
            .as_ref()
            .is_some_and(|session| !valid_session(session))
    {
        return Err("端末設定の形式が無効です。上書きせず保持します".into());
    }
    locked.revalidate(&root, &original)?;
    Ok((
        stored.lists,
        stored.folder_favorites,
        stored.sets,
        stored.set_shortcuts,
        stored.session,
        Some(content_hash(&data)),
    ))
}
pub fn load(core: &Core, dir: &Dir) -> Settings {
    let identity = knowledge::storage_root_identity(dir)
        .map_err(|_| "作業フォルダーの識別情報を取得できません".to_owned());
    let loaded = identity
        .as_ref()
        .map_err(Clone::clone)
        .and_then(|identity| {
            if core.settings_path.get().is_none() {
                Ok((
                    Lists::default(),
                    vec![],
                    vec![],
                    Default::default(),
                    None,
                    None,
                ))
            } else {
                load_lists(core, identity)
            }
        });
    match loaded {
        Ok((lists, folder_favorites, sets, set_shortcuts, session, stored_hash)) => Settings {
            root_identity: identity.unwrap(),
            lists,
            folder_favorites,
            sets,
            set_shortcuts,
            session,
            stored_hash,
            ..Default::default()
        },
        Err(error) => Settings {
            root_identity: identity.unwrap_or_default(),
            error: Some(error),
            read_only: true,
            ..Default::default()
        },
    }
}
pub fn check_switch(core: &Core, loaded: &Settings) -> Result<(), String> {
    let state = core.workspace.lock().unwrap();
    let pending = core.pending_workspace_settings.lock().unwrap();
    if state.settings.dirty
        && state.settings.root_identity != loaded.root_identity
        && pending.len() >= 8
        && !pending.contains_key(&state.settings.root_identity)
        && !pending.contains_key(&loaded.root_identity)
    {
        return Err(
            "保存できない作業フォルダーが8件あります。設定の書き込み先を確認してください".into(),
        );
    }
    Ok(())
}
pub fn switch(core: &Core, loaded: Settings) -> Result<Settings, String> {
    check_switch(core, &loaded)?;
    let state = core.workspace.lock().unwrap();
    let mut pending = core.pending_workspace_settings.lock().unwrap();
    if state.settings.dirty {
        let mut retained = state.settings.clone();
        retained.flush_pending = false;
        pending.insert(state.settings.root_identity.clone(), retained);
    }
    Ok(pending.remove(&loaded.root_identity).unwrap_or(loaded))
}
fn save(core: &Core, settings: &mut Settings) -> Result<(), String> {
    save_with_publication(core, settings, false)
}
fn save_with_publication(
    core: &Core,
    settings: &mut Settings,
    guarded: bool,
) -> Result<(), String> {
    if settings.read_only {
        return Err(settings
            .error
            .clone()
            .unwrap_or_else(|| "端末設定は読み取り専用です".into()));
    }
    let data = encoded(settings)?;
    #[cfg(windows)]
    let _ordinary_parent = if guarded {
        let profile = core
            .settings_path
            .get()
            .and_then(|path| path.parent())
            .ok_or("端末設定の保存先が未初期化です")?;
        let (_, original) = knowledge::open_root(profile)?;
        Some(LockedDir::open(&original, "")?)
    } else {
        None
    };
    let (root, original, locked) = directory(core, true)?;
    let name = format!("{}.json", settings.root_identity);
    let current = match read_file(locked.dir(), &name) {
        Ok(file) => {
            let metadata = file.metadata().map_err(|_| "端末設定を検証できません")?;
            if crate::write_fs::rejected_link(&metadata) || !metadata.is_file() {
                return Err("端末設定の保存先が通常ファイルではありません".into());
            }
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "端末設定を検証できません")?;
            Some(content_hash(&bytes))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("端末設定の保存先を検証できません".into()),
    };
    if current != settings.stored_hash {
        return Err("端末設定が外部で変更されました。上書きせず保持します。保存できない最近の記録はアプリ終了まで保持します".into());
    }
    let (temporary, mut file) =
        crate::write_fs::create_temporary(locked.dir()).map_err(|_| "端末設定を保存できません")?;
    let result = (|| {
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "端末設定を保存できません。元の保存内容は保持します")?;
        #[cfg(windows)]
        if guarded {
            locked.revalidate(&root, &original)?;
            crate::write_fs::replace_workspace_preferences(&locked, &temporary, &file, &name)
                .map_err(|_| {
                    "端末設定の保存を確認できません。ファイルを保持し、自動再試行しません"
                })?;
            locked.revalidate(&root, &original)?;
            return Ok(());
        }
        drop(file);
        locked.revalidate(&root, &original)?;
        locked
            .dir()
            .rename(&temporary, locked.dir(), &name)
            .map_err(|_| "端末設定を保存できません。元の保存内容は保持します")?;
        Ok(())
    })();
    if result.is_err() && !guarded {
        let _ = locked.dir().remove_file(&temporary);
    }
    if result.is_ok() {
        settings.stored_hash = Some(content_hash(&data));
    }
    result
}
/// Only verified Cloud namespace changes use retained-handle publication in
/// the existing ordinary profile directory. Unknown never reaches this entry.
#[cfg(windows)]
pub(crate) fn flush_cloud_move_locked(core: &Core) -> Result<(), String> {
    let mut state = core.workspace.lock().unwrap();
    if !state.settings.dirty {
        return Ok(());
    }
    match save_with_publication(core, &mut state.settings, true) {
        Ok(()) => {
            state.settings.dirty = false;
            state.settings.error = None;
            Ok(())
        }
        Err(error) => {
            // Do not schedule the ordinary delayed writer after an uncertain
            // publication. Keep remapped references available in memory.
            state.settings.flush_pending = false;
            state.settings.error = Some(error.clone());
            state.settings.read_only = true;
            Err(error)
        }
    }
}
pub fn flush_locked(core: &Core) -> Result<(), String> {
    let mut state = core.workspace.lock().unwrap();
    if !state.settings.dirty {
        return Ok(());
    }
    match save(core, &mut state.settings) {
        Ok(()) => {
            state.settings.dirty = false;
            state.settings.error = None;
            Ok(())
        }
        Err(error) => {
            state.settings.error = Some(error.clone());
            Err(error)
        }
    }
}
pub fn flush(core: &Core) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let current = flush_locked(core);
    let mut pending = core.pending_workspace_settings.lock().unwrap();
    let mut error = current.err();
    pending.retain(|_, settings| match save(core, settings) {
        Ok(()) => false,
        Err(message) => {
            error = Some(message);
            true
        }
    });
    error.map_or(Ok(()), Err)
}
fn contains_kind(nodes: &[knowledge::TreeNode], path: &str, kind: &str) -> bool {
    nodes.iter().any(|node| {
        (node.kind == kind && node.relative_path == path)
            || contains_kind(&node.children, path, kind)
    })
}
fn contains(nodes: &[knowledge::TreeNode], path: &str) -> bool {
    contains_kind(nodes, path, "html")
}
fn check_root(state: &Workspace) -> Result<(), String> {
    let root = state.root.as_ref().ok_or("WorkspaceChanged")?;
    let dir = state.dir.as_ref().ok_or("WorkspaceChanged")?;
    let (_, current) = knowledge::open_root(root)?;
    if !knowledge::same_directory(dir, &current)? {
        return Err("作業フォルダーが置き換えられました。再走査してください".into());
    }
    Ok(())
}
// The operation-local LockedDir keeps every ancestor no-follow handle alive
// while reading physical identity and revalidating the selected root/path.
fn folder_identity(state: &Workspace, path: &str) -> Result<String, String> {
    knowledge::validate_relative(path)?;
    let dir = state.dir.as_ref().unwrap();
    let locked = LockedDir::open(dir, path)?;
    let identity = knowledge::storage_root_identity(locked.dir())
        .map_err(|_| "フォルダーの識別情報を取得できません")?;
    locked.revalidate(state.root.as_ref().unwrap(), dir)?;
    Ok(identity)
}
fn reference_status(state: &Workspace, entry: &DocumentRef, folder: bool) -> &'static str {
    let identity = if folder {
        folder_identity(state, &entry.relative_path)
    } else {
        knowledge::storage_identity(
            state.root.as_ref().unwrap(),
            state.dir.as_ref().unwrap(),
            &entry.relative_path,
        )
    };
    match identity {
        Ok(identity) if identity == entry.identity => "available",
        Ok(_) => "replaced",
        Err(_) => match state
            .dir
            .as_ref()
            .unwrap()
            .symlink_metadata(&entry.relative_path)
        {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing",
            _ => "unavailable",
        },
    }
}
fn status(state: &Workspace, entry: &DocumentRef) -> &'static str {
    reference_status(state, entry, false)
}
fn snapshot(state: &Workspace, revalidate: bool) -> ListSnapshot {
    let entries = |list: &[DocumentRef], folder: bool| {
        list.iter()
            .map(|entry| ListEntry {
                document: entry.clone(),
                status: if revalidate {
                    reference_status(state, entry, folder)
                } else if contains_kind(
                    &state.snapshot.nodes,
                    &entry.relative_path,
                    if folder { "folder" } else { "html" },
                ) {
                    "available"
                } else {
                    "unavailable"
                },
            })
            .collect()
    };
    ListSnapshot {
        favorites: entries(&state.settings.lists.favorites, false),
        folder_favorites: entries(&state.settings.folder_favorites, true),
        recent: entries(&state.settings.lists.recent, false),
        error: state.settings.error.clone(),
        read_only: state.settings.read_only,
    }
}
// Only the requested list resolves external moves, by metadata, with an explicit
// time/work bound. No HTML bodies are read and unresolved references are retained.
fn follow_moves(state: &mut Workspace) {
    let started = Instant::now();
    let unresolved: HashSet<_> = state
        .settings
        .lists
        .favorites
        .iter()
        .chain(&state.settings.lists.recent)
        .chain(
            state
                .settings
                .sets
                .iter()
                .flat_map(|set| set.items.iter().map(|item| &item.document)),
        )
        .filter(|entry| status(state, entry) != "available")
        .map(|entry| entry.identity.clone())
        .collect();
    let unresolved_folders: HashSet<_> = state
        .settings
        .folder_favorites
        .iter()
        .filter(|entry| reference_status(state, entry, true) != "available")
        .map(|entry| entry.identity.clone())
        .collect();
    if unresolved.is_empty() && unresolved_folders.is_empty() {
        return;
    }
    let mut candidates = vec![state.snapshot.nodes.iter()];
    let mut inspected = 0;
    let mut found = std::collections::HashMap::new();
    let mut found_folders = std::collections::HashMap::new();
    while !candidates.is_empty() {
        if started.elapsed() > Duration::from_millis(150)
            || inspected >= 10000
            || (found.len() == unresolved.len() && found_folders.len() == unresolved_folders.len())
        {
            break;
        }
        let Some(node) = candidates.last_mut().and_then(Iterator::next) else {
            candidates.pop();
            continue;
        };
        inspected += 1;
        if node.kind != "html" {
            candidates.push(node.children.iter());
            if node.kind == "folder" && !unresolved_folders.is_empty() {
                if let Ok(identity) = folder_identity(state, &node.relative_path) {
                    if unresolved_folders.contains(&identity) {
                        found_folders.insert(identity, node.relative_path.clone());
                    }
                }
            }
            continue;
        }
        if unresolved.is_empty() {
            continue;
        }
        let path = node.relative_path.as_str();
        if let Ok(identity) = knowledge::storage_identity(
            state.root.as_ref().unwrap(),
            state.dir.as_ref().unwrap(),
            path,
        ) {
            if unresolved.contains(&identity) {
                found.insert(identity, path.to_owned());
            }
        }
    }
    for entry in state
        .settings
        .lists
        .favorites
        .iter_mut()
        .chain(&mut state.settings.lists.recent)
        .chain(
            state
                .settings
                .sets
                .iter_mut()
                .flat_map(|set| set.items.iter_mut().map(|item| &mut item.document)),
        )
    {
        if let Some(path) = found.get(&entry.identity) {
            if entry.relative_path != *path {
                entry.relative_path.clone_from(path);
                state.settings.dirty = !state.settings.read_only;
            }
        }
    }
    for entry in &mut state.settings.folder_favorites {
        if let Some(path) = found_folders.get(&entry.identity) {
            if entry.relative_path != *path {
                entry.relative_path.clone_from(path);
                state.settings.dirty = !state.settings.read_only;
            }
        }
    }
}
pub fn get(
    core: &Core,
    workspace: &str,
    view: &str,
    resolve_moves: bool,
) -> Result<ListSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    {
        let mut state = core.workspace.lock().unwrap();
        Core::check_view(&state, workspace, view)?;
        check_root(&state)?;
        if resolve_moves {
            follow_moves(&mut state);
        }
    }
    // A failed move save is visible in the list; never discard its old sidecar.
    if resolve_moves {
        let _ = flush_locked(core);
    }
    Ok(snapshot(&core.workspace.lock().unwrap(), resolve_moves))
}
pub fn favorite(
    core: &Core,
    workspace: &str,
    view: &str,
    path: &str,
    add: bool,
) -> Result<ListSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    let previous = state.settings.lists.clone();
    let previous_folders = state.settings.folder_favorites.clone();
    if add {
        let folder = contains_kind(&state.snapshot.nodes, path, "folder");
        if !folder && !contains(&state.snapshot.nodes, path) {
            return Err("文書・フォルダーが見つかりません".into());
        }
        let identity = if folder {
            folder_identity(&state, path)?
        } else {
            knowledge::storage_identity(
                state.root.as_ref().unwrap(),
                state.dir.as_ref().unwrap(),
                path,
            )?
        };
        if !state
            .settings
            .lists
            .favorites
            .iter()
            .chain(&state.settings.folder_favorites)
            .any(|entry| entry.identity == identity)
        {
            if state.settings.lists.favorites.len() + state.settings.folder_favorites.len()
                >= LIST_LIMIT
            {
                return Err(
                    "お気に入りは文書・フォルダー合計50件までです。先に解除してください".into(),
                );
            }
            let entry = DocumentRef {
                relative_path: path.into(),
                identity,
            };
            if folder {
                state.settings.folder_favorites.push(entry);
            } else {
                state.settings.lists.favorites.push(entry);
            }
        }
    } else {
        state
            .settings
            .lists
            .favorites
            .retain(|entry| entry.relative_path != path);
        state
            .settings
            .folder_favorites
            .retain(|entry| entry.relative_path != path);
    }
    if previous == state.settings.lists && previous_folders == state.settings.folder_favorites {
        return Ok(snapshot(&state, true));
    }
    if let Err(error) = save(core, &mut state.settings) {
        state.settings.lists = previous;
        state.settings.folder_favorites = previous_folders;
        state.settings.error = Some(error.clone());
        return Err(error);
    }
    state.settings.dirty = false;
    state.settings.error = None;
    Ok(snapshot(&state, true))
}
pub fn validate_folder(
    core: &Core,
    workspace: &str,
    view: &str,
    entry: &DocumentRef,
) -> Result<String, String> {
    let _gate = core.gate.lock().unwrap();
    let state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if !state
        .settings
        .folder_favorites
        .iter()
        .any(|saved| saved == entry)
    {
        return Err("一覧が変更されました。もう一度開いてください".into());
    }
    if !contains_kind(&state.snapshot.nodes, &entry.relative_path, "folder")
        || reference_status(&state, entry, true) != "available"
    {
        return Err(
            "フォルダーが欠落・置換されたか、一時的に読み取れません。再走査後に確認してください"
                .into(),
        );
    }
    Ok(entry.relative_path.clone())
}
pub fn validate(
    core: &Core,
    workspace: &str,
    view: &str,
    entry: &DocumentRef,
) -> Result<String, String> {
    validate_tab(core, workspace, view, entry, None)
}
pub fn validate_tab(
    core: &Core,
    workspace: &str,
    view: &str,
    entry: &DocumentRef,
    tab_id: Option<&str>,
) -> Result<String, String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if !state
        .settings
        .lists
        .favorites
        .iter()
        .chain(&state.settings.lists.recent)
        .any(|saved| saved == entry)
    {
        return Err("一覧が変更されました。もう一度開いてください".into());
    }
    if status(&state, entry) != "available" {
        return Err(
            "文書が欠落・置換されたか、一時的に読み取れません。再走査後に確認してください".into(),
        );
    }
    if let Some(tab_id) = tab_id {
        let tab = state
            .tabs
            .get_mut(tab_id)
            .filter(|tab| !tab.browser && tab.entry == entry.relative_path)
            .ok_or("TabClosed")?;
        let session = tab
            .session
            .as_ref()
            .ok_or("文書の表示完了後にもう一度選択してください")?;
        if session.storage_identity.as_deref() != Some(&entry.identity) {
            return Err("既存タブは別の文書です。先にそのタブを閉じてください".into());
        }
    }
    Ok(entry.relative_path.clone())
}
pub fn seen(
    core: &Arc<Core>,
    workspace: &str,
    view: &str,
    tab_id: &str,
    source_url: &str,
) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    let session = state
        .tabs
        .get(tab_id)
        .filter(|tab| !tab.browser)
        .and_then(|tab| tab.session.as_ref())
        .ok_or("TabClosed")?;
    let encoded_path = session
        .entry
        .split('/')
        .map(|part| {
            percent_encoding::utf8_percent_encode(part, percent_encoding::NON_ALPHANUMERIC)
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("/");
    let expected = format!("{}/s/{}/{}", core.origin, session.token, encoded_path);
    if source_url != expected {
        return Err("Superseded".into());
    }
    let identity = session
        .storage_identity
        .clone()
        .ok_or("文書の識別情報を取得できません")?;
    if knowledge::storage_identity(&session.root, &session.dir, &session.entry)? != identity {
        return Err("文書が置き換えられました".into());
    }
    let entry = DocumentRef {
        relative_path: session.entry.clone(),
        identity,
    };
    if !valid_document(&entry) {
        return Err("この一覧の文書パスはUTF-8で4096bytes以下にしてください".into());
    }
    if state.settings.lists.recent.first() == Some(&entry) {
        return Ok(());
    }
    let previous = state.settings.lists.recent.clone();
    state
        .settings
        .lists
        .recent
        .retain(|saved| saved.identity != entry.identity);
    state.settings.lists.recent.insert(0, entry);
    state.settings.lists.recent.truncate(LIST_LIMIT);
    if let Err(error) = encoded(&state.settings) {
        state.settings.lists.recent = previous;
        state.settings.error = Some(error.clone());
        return Err(error);
    }
    state.settings.dirty = true;
    if !state.settings.flush_pending {
        state.settings.flush_pending = true;
        let core = core.clone();
        let workspace = workspace.to_owned();
        std::thread::spawn(move || {
            // One shot per batch, never an idle polling timer. Root switches flush
            // synchronously, so this wake-up cannot write an obsolete root's list.
            std::thread::sleep(WRITE_DELAY);
            let _gate = core.gate.lock().unwrap();
            {
                let mut state = core.workspace.lock().unwrap();
                if state.snapshot.workspace_id.as_deref() != Some(&workspace) {
                    return;
                }
                state.settings.flush_pending = false;
            }
            let result = flush_locked(&core);
            if result.is_err() {
                let state = core.workspace.lock().unwrap();
                let change = crate::core::Change {
                    workspace_id: workspace,
                    revision: state.snapshot.revision,
                    changed_paths: vec![],
                    structure_changed: false,
                    watch_error: state.snapshot.watch_error.clone(),
                    moves: vec![],
                    tree_only: true,
                };
                drop(state);
                core.emit(change);
            }
        });
    }
    Ok(())
}
pub fn remap(settings: &mut Settings, from: &str, to: &str) {
    for entry in settings
        .lists
        .favorites
        .iter_mut()
        .chain(&mut settings.lists.recent)
        .chain(&mut settings.folder_favorites)
        .chain(
            settings
                .sets
                .iter_mut()
                .flat_map(|set| set.items.iter_mut().map(|item| &mut item.document)),
        )
        .chain(
            settings
                .session
                .iter_mut()
                .flat_map(|session| session.items.iter_mut().map(|item| &mut item.document)),
        )
    {
        let next = crate::tree_mutations::remap(&entry.relative_path, from, to);
        if next != entry.relative_path {
            entry.relative_path = next;
            settings.dirty = !settings.read_only;
        }
    }
}

// IPC captures only references to admitted views or previously stored lazy items.
// No HTML body, input value, grant or JS state is serialized by this module.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureItem {
    pub tab_id: Option<String>,
    pub document: Option<DocumentRef>,
    pub column: u8,
    pub zoom: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSnapshot {
    pub sets: Vec<WorkingSet>,
    pub set_shortcuts: SetShortcuts,
    pub error: Option<String>,
    pub read_only: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedItem {
    #[serde(flatten)]
    pub item: SetItem,
    pub status: &'static str,
    pub reusable_tabs: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSet {
    pub set: WorkingSet,
    pub items: Vec<ResolvedItem>,
}
fn set_snapshot(state: &Workspace) -> SetSnapshot {
    SetSnapshot {
        sets: state.settings.sets.clone(),
        set_shortcuts: state.settings.set_shortcuts.clone(),
        error: state.settings.error.clone(),
        read_only: state.settings.read_only,
    }
}
pub fn get_sets(core: &Core, workspace: &str, view: &str) -> Result<SetSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    Ok(set_snapshot(&state))
}
fn save_sets(
    core: &Core,
    state: &mut Workspace,
    previous: (Vec<WorkingSet>, SetShortcuts),
) -> Result<SetSnapshot, String> {
    if let Err(error) = save(core, &mut state.settings) {
        state.settings.sets = previous.0;
        state.settings.set_shortcuts = previous.1;
        state.settings.error = Some(error.clone());
        return Err(error);
    }
    state.settings.dirty = false;
    state.settings.error = None;
    Ok(set_snapshot(state))
}
fn capture_items(state: &Workspace, items: Vec<CaptureItem>) -> Result<Vec<SetItem>, String> {
    let mut captured = Vec::with_capacity(items.len());
    for item in items {
        let document = match (item.tab_id, item.document) {
            (Some(id), None) => {
                let tab = state
                    .tabs
                    .get(&id)
                    .filter(|tab| !tab.browser)
                    .ok_or("TabClosed")?;
                let session = tab
                    .session
                    .as_ref()
                    .ok_or("文書の読み込み完了後に保存してください")?;
                let identity = session
                    .storage_identity
                    .clone()
                    .ok_or("文書の識別情報がありません")?;
                if session.entry != tab.entry
                    || knowledge::storage_identity(&session.root, &session.dir, &session.entry)?
                        != identity
                {
                    return Err("文書が移動・置換されています。再走査後に確認してください".into());
                }
                DocumentRef {
                    relative_path: tab.entry.clone(),
                    identity,
                }
            }
            (None, Some(document))
                if state
                    .settings
                    .sets
                    .iter()
                    .any(|set| set.items.iter().any(|item| item.document == document))
                    || state.settings.session.as_ref().is_some_and(|session| {
                        session.items.iter().any(|item| item.document == document)
                    }) =>
            {
                document
            }
            _ => return Err("保存対象の文書が変更されました".into()),
        };
        captured.push(SetItem {
            document,
            column: item.column,
            zoom: item.zoom,
        });
    }
    Ok(captured)
}

/// Hidden session entries need no file reads or grants until selected.
pub fn get_session(core: &Core, workspace: &str, view: &str) -> Result<Option<TabSession>, String> {
    let _gate = core.gate.lock().unwrap();
    let state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    Ok(state.settings.session.clone())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCapture {
    pub items: Vec<CaptureItem>,
    pub active: [Option<usize>; 2],
    pub active_column: u8,
    pub split: bool,
    pub help: Option<SessionHelp>,
}
pub fn capture_session(
    core: &Core,
    workspace: &str,
    view: &str,
    capture: SessionCapture,
) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    // A previously persisted reference remains a placeholder even if its loaded
    // source disappeared or was replaced. Reuse only that exact admitted reference;
    // restoration still validates identity before issuing any new document grant.
    let items = capture
        .items
        .into_iter()
        .map(|mut item| {
            if item.document.is_none() {
                if let Some(tab) = item
                    .tab_id
                    .as_ref()
                    .and_then(|id| state.tabs.get(id))
                    .filter(|tab| !tab.browser)
                {
                    if let Some(document) = state
                        .settings
                        .session
                        .as_ref()
                        .and_then(|saved| {
                            saved.items.iter().find(|saved| {
                                saved.document.relative_path == tab.entry
                                    && tab.session.as_ref().is_some_and(|session| {
                                        session.entry == tab.entry
                                            && session.storage_identity.as_ref()
                                                == Some(&saved.document.identity)
                                    })
                            })
                        })
                        .map(|saved| saved.document.clone())
                    {
                        item.tab_id = None;
                        item.document = Some(document);
                    }
                }
            }
            item
        })
        .collect();
    let session = TabSession {
        items: capture_items(&state, items)?,
        active: capture.active,
        active_column: capture.active_column,
        split: capture.split,
        help: capture.help,
    };
    if !valid_session(&session) {
        return Err("TabSessionInvalid".into());
    }
    if state.settings.session.as_ref() == Some(&session) {
        return Ok(());
    }
    let previous = state.settings.session.replace(session);
    // Atomic replacement and stored-hash conflict detection preserve the last successful file.
    if let Err(error) = save(core, &mut state.settings) {
        state.settings.session = previous;
        state.settings.error = Some(error.clone());
        return Err(error);
    }
    state.settings.dirty = false;
    state.settings.error = None;
    Ok(())
}
pub fn capture_set(
    core: &Core,
    workspace: &str,
    view: &str,
    name: String,
    items: Vec<CaptureItem>,
    active: [Option<usize>; 2],
    active_column: u8,
) -> Result<SetSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    if state.settings.sets.len() >= SET_LIMIT || items.len() > SET_ITEM_LIMIT {
        return Err("作業セットは10組、各30項目までです".into());
    }
    let captured = capture_items(&state, items)?;
    let set = WorkingSet {
        id: crate::core::random_token(),
        name: name.trim().into(),
        items: captured,
        active,
        active_column,
    };
    if !valid_set(&set) {
        return Err(
            "セット名は160bytes以下、文書は各列で重複させず、倍率は50〜200%にしてください".into(),
        );
    }
    let previous = (
        state.settings.sets.clone(),
        state.settings.set_shortcuts.clone(),
    );
    state.settings.sets.push(set);
    save_sets(core, &mut state, previous)
}
pub fn edit_set(
    core: &Core,
    workspace: &str,
    view: &str,
    id: &str,
    name: Option<String>,
) -> Result<SetSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    let previous = (
        state.settings.sets.clone(),
        state.settings.set_shortcuts.clone(),
    );
    let index = state
        .settings
        .sets
        .iter()
        .position(|set| set.id == id)
        .ok_or("セットが変更されました")?;
    if let Some(name) = name {
        let mut changed = state.settings.sets[index].clone();
        changed.name = name.trim().into();
        if !valid_set(&changed) {
            return Err("セット名は空白以外で160bytes以下にしてください".into());
        }
        if changed == state.settings.sets[index] {
            return Ok(set_snapshot(&state));
        }
        state.settings.sets[index] = changed;
    } else {
        state.settings.sets.remove(index);
        for assigned in &mut state.settings.set_shortcuts {
            if assigned.as_deref() == Some(id) {
                *assigned = None;
            }
        }
    }
    save_sets(core, &mut state, previous)
}
pub fn assign_set_shortcut(
    core: &Core,
    workspace: &str,
    view: &str,
    id: &str,
    slot: Option<u8>,
) -> Result<SetSnapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let mut state = core.workspace.lock().unwrap();
    Core::check_view(&state, workspace, view)?;
    check_root(&state)?;
    if state.settings.read_only {
        return Err(state.settings.error.clone().unwrap_or_default());
    }
    if !state.settings.sets.iter().any(|set| set.id == id) {
        return Err("セットが変更されました".into());
    }
    let index = slot.map(shortcut_index).transpose()?;
    if let Some(index) = index {
        if state.settings.set_shortcuts[index]
            .as_deref()
            .is_some_and(|assigned| assigned != id)
        {
            return Err("この番号は別の作業セットに割り当て済みです".into());
        }
    }
    let previous = (
        state.settings.sets.clone(),
        state.settings.set_shortcuts.clone(),
    );
    for assigned in &mut state.settings.set_shortcuts {
        if assigned.as_deref() == Some(id) {
            *assigned = None;
        }
    }
    if let Some(index) = index {
        state.settings.set_shortcuts[index] = Some(id.into());
    }
    if previous.1 == state.settings.set_shortcuts {
        return Ok(set_snapshot(&state));
    }
    save_sets(core, &mut state, previous)
}
fn shortcut_index(slot: u8) -> Result<usize, String> {
    if (1..=10).contains(&slot) {
        Ok(usize::from(slot - 1))
    } else {
        Err("作業セットの番号は1〜10の範囲で指定してください".into())
    }
}
pub fn resolve_set(
    core: &Core,
    workspace: &str,
    view: &str,
    id: &str,
    shortcut_slot: Option<u8>,
) -> Result<ResolvedSet, String> {
    let _gate = core.gate.lock().unwrap();
    {
        let mut state = core.workspace.lock().unwrap();
        Core::check_view(&state, workspace, view)?;
        check_root(&state)?;
        if let Some(slot) = shortcut_slot {
            if state.settings.set_shortcuts[shortcut_index(slot)?].as_deref() != Some(id) {
                return Err("作業セットの番号割当が変更されました。割当を確認してください".into());
            }
        }
        if !state.settings.sets.iter().any(|set| set.id == id) {
            return Err("セットが変更されました".into());
        }
        follow_moves(&mut state);
    }
    let _ = flush_locked(core);
    let state = core.workspace.lock().unwrap();
    let set = state
        .settings
        .sets
        .iter()
        .find(|set| set.id == id)
        .unwrap()
        .clone();
    let items = set
        .items
        .iter()
        .map(|item| ResolvedItem {
            status: status(&state, &item.document),
            reusable_tabs: state
                .tabs
                .iter()
                .filter(|(_, tab)| {
                    !tab.browser
                        && tab.entry == item.document.relative_path
                        && tab
                            .session
                            .as_ref()
                            .and_then(|session| session.storage_identity.as_ref())
                            == Some(&item.document.identity)
                })
                .map(|(id, _)| id.clone())
                .collect(),
            item: item.clone(),
        })
        .collect();
    Ok(ResolvedSet { set, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn fixture() -> (tempfile::TempDir, Arc<Core>, crate::core::Snapshot) {
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir(fixture.path().join("config")).unwrap();
        fs::create_dir(fixture.path().join("knowledge")).unwrap();
        fs::write(
            fixture.path().join("knowledge/a.html"),
            "<input value='original'>",
        )
        .unwrap();
        fs::write(fixture.path().join("knowledge/b.html"), "<p>b</p>").unwrap();
        let core = configured(fixture.path());
        let snapshot = core
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        core.watcher.lock().unwrap().take();
        (fixture, core, snapshot)
    }
    fn configured(path: &Path) -> Arc<Core> {
        let core = Core::new(12345);
        core.settings_path
            .set(path.join("config/settings.json"))
            .unwrap();
        core
    }
    fn scope(snapshot: &crate::core::Snapshot) -> (&str, &str) {
        (snapshot.workspace_id.as_deref().unwrap(), &snapshot.view_id)
    }
    fn stored_path(core: &Core) -> std::path::PathBuf {
        core.settings_path
            .get()
            .unwrap()
            .parent()
            .unwrap()
            .join("workspace-settings")
            .join(format!(
                "{}.json",
                core.workspace.lock().unwrap().settings.root_identity
            ))
    }
    fn visit(core: &Arc<Core>, snapshot: &crate::core::Snapshot, path: &str) -> (String, String) {
        let (workspace, view) = scope(snapshot);
        let tab = core.create_tab(workspace, view, path).unwrap();
        let url = core.open(workspace, view, &tab, 1).unwrap();
        seen(core, workspace, view, &tab, &url).unwrap();
        (tab, url)
    }

    #[test]
    fn favorites_deduplicate_and_survive_restart_without_touching_html() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        let bytes = fs::read(stored_path(&core)).unwrap();
        favorite(&core, workspace, view, "a.html", true).unwrap();
        assert_eq!(fs::read(stored_path(&core)).unwrap(), bytes);
        let restarted = configured(fixture.path());
        let restored = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let (workspace, view) = scope(&restored);
        let lists = get(&restarted, workspace, view, true).unwrap();
        assert_eq!(lists.favorites.len(), 1);
        assert_eq!(lists.favorites[0].status, "available");
        assert_eq!(
            fs::read_to_string(fixture.path().join("knowledge/a.html")).unwrap(),
            "<input value='original'>"
        );
        favorite(&restarted, workspace, view, "a.html", false).unwrap();
        assert!(get(&restarted, workspace, view, true)
            .unwrap()
            .favorites
            .is_empty());
    }
    #[test]
    fn folder_favorites_restart_revalidate_and_never_admit_documents() {
        let (fixture, core, _) = fixture();
        let folder = "日本語.html";
        fs::create_dir(fixture.path().join("knowledge").join(folder)).unwrap();
        fs::write(
            fixture
                .path()
                .join("knowledge")
                .join(folder)
                .join("child.html"),
            "original",
        )
        .unwrap();
        let current = core.refresh().unwrap();
        let scope = scope(&current);
        let lists = favorite(&core, scope.0, scope.1, folder, true).unwrap();
        let saved = lists.folder_favorites[0].document.clone();
        let bytes = fs::read(stored_path(&core)).unwrap();
        favorite(&core, scope.0, scope.1, folder, true).unwrap();
        assert_eq!(fs::read(stored_path(&core)).unwrap(), bytes);
        assert!(lists.favorites.is_empty() && lists.recent.is_empty());
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
        assert_eq!(
            validate_folder(&core, scope.0, scope.1, &saved).unwrap(),
            folder
        );
        assert!(validate(&core, scope.0, scope.1, &saved).is_err());
        assert!(validate_folder(&core, "stale", scope.1, &saved).is_err());
        assert!(validate_folder(&core, scope.0, "stale", &saved).is_err());
        let forged = DocumentRef {
            identity: "0".repeat(64),
            ..saved.clone()
        };
        assert!(validate_folder(&core, scope.0, scope.1, &forged).is_err());
        assert!(favorite(&core, scope.0, scope.1, "../日本語.html", true).is_err());
        fs::create_dir(fixture.path().join("knowledge/unscanned")).unwrap();
        assert!(favorite(&core, scope.0, scope.1, "unscanned", true).is_err());
        let restarted = configured(fixture.path());
        let restored = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let restored_scope = super::tests::scope(&restored);
        assert_eq!(
            get(&restarted, restored_scope.0, restored_scope.1, true)
                .unwrap()
                .folder_favorites[0]
                .status,
            "available"
        );
        assert!(restarted.workspace.lock().unwrap().tabs.is_empty());
        assert_eq!(
            fs::read_to_string(
                fixture
                    .path()
                    .join("knowledge")
                    .join(folder)
                    .join("child.html")
            )
            .unwrap(),
            "original"
        );
        fs::create_dir(fixture.path().join("other")).unwrap();
        let other = restarted
            .select(&fixture.path().join("other"), false)
            .unwrap();
        let other_scope = super::tests::scope(&other);
        assert!(get(&restarted, other_scope.0, other_scope.1, true)
            .unwrap()
            .folder_favorites
            .is_empty());
        assert!(validate_folder(&restarted, restored_scope.0, restored_scope.1, &saved).is_err());
    }
    #[test]
    fn folder_and_document_favorites_share_one_limit_and_keep_failed_values() {
        let (fixture, core, _) = fixture();
        for index in 0..50 {
            fs::create_dir(fixture.path().join(format!("knowledge/folder{index}"))).unwrap();
        }
        let current = core.refresh().unwrap();
        let scope = scope(&current);
        favorite(&core, scope.0, scope.1, "a.html", true).unwrap();
        for index in 0..49 {
            favorite(&core, scope.0, scope.1, &format!("folder{index}"), true).unwrap();
        }
        let path = stored_path(&core);
        let bytes = fs::read(&path).unwrap();
        assert!(favorite(&core, scope.0, scope.1, "folder49", true)
            .err()
            .unwrap()
            .contains("合計50"));
        assert!(favorite(&core, scope.0, scope.1, "b.html", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        favorite(&core, scope.0, scope.1, "folder0", false).unwrap();
        favorite(&core, scope.0, scope.1, "b.html", true).unwrap();
        fs::write(&path, b"{broken").unwrap();
        assert!(favorite(&core, scope.0, scope.1, "folder1", false).is_err());
        assert_eq!(
            core.workspace
                .lock()
                .unwrap()
                .settings
                .folder_favorites
                .len(),
            48
        );
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let restarted = configured(fixture.path());
        let restored = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let restored_scope = super::tests::scope(&restored);
        assert!(
            get(&restarted, restored_scope.0, restored_scope.1, true)
                .unwrap()
                .read_only
        );
        assert!(favorite(
            &restarted,
            restored_scope.0,
            restored_scope.1,
            "folder49",
            true
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }
    #[test]
    fn folders_follow_internal_and_external_moves_without_becoming_documents() {
        let (fixture, core, _) = fixture();
        fs::create_dir(fixture.path().join("knowledge/folder")).unwrap();
        fs::create_dir(fixture.path().join("knowledge/parent")).unwrap();
        let current = core.refresh().unwrap();
        let scope = scope(&current);
        favorite(&core, scope.0, scope.1, "folder", true).unwrap();
        let old = get(&core, scope.0, scope.1, true).unwrap().folder_favorites[0]
            .document
            .clone();
        crate::tree_mutations::perform(
            &core,
            scope.0,
            scope.1,
            crate::tree_mutations::Mutation::Move {
                source: "folder".into(),
                parent: "parent".into(),
                anchor: None,
                after: false,
            },
        )
        .unwrap();
        let internal = get(&core, scope.0, scope.1, true).unwrap();
        assert_eq!(
            internal.folder_favorites[0].document.relative_path,
            "parent/folder"
        );
        assert_eq!(internal.folder_favorites[0].document.identity, old.identity);
        fs::rename(
            fixture.path().join("knowledge/parent/folder"),
            fixture.path().join("knowledge/renamed"),
        )
        .unwrap();
        core.refresh().unwrap();
        let moved = get(&core, scope.0, scope.1, true)
            .unwrap()
            .folder_favorites
            .remove(0)
            .document;
        assert_eq!(moved.relative_path, "renamed");
        assert_eq!(moved.identity, old.identity);
        assert!(validate_folder(&core, scope.0, scope.1, &old).is_err());
        assert_eq!(
            validate_folder(&core, scope.0, scope.1, &moved).unwrap(),
            "renamed"
        );
        fs::remove_dir(fixture.path().join("knowledge/renamed")).unwrap();
        core.refresh().unwrap();
        let missing = get(&core, scope.0, scope.1, true).unwrap();
        assert_eq!(missing.folder_favorites[0].status, "missing");
        assert!(validate_folder(&core, scope.0, scope.1, &moved).is_err());
        favorite(&core, scope.0, scope.1, "renamed", false).unwrap();
        assert!(get(&core, scope.0, scope.1, true)
            .unwrap()
            .folder_favorites
            .is_empty());
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn replaced_or_linked_folder_and_replaced_root_cannot_inherit_a_favorite() {
        use std::os::unix::fs::symlink;
        let (fixture, core, _) = fixture();
        fs::create_dir(fixture.path().join("knowledge/folder")).unwrap();
        let current = core.refresh().unwrap();
        let scope = scope(&current);
        let saved = favorite(&core, scope.0, scope.1, "folder", true)
            .unwrap()
            .folder_favorites
            .remove(0)
            .document;
        fs::rename(
            fixture.path().join("knowledge/folder"),
            fixture.path().join("retained-folder"),
        )
        .unwrap();
        fs::create_dir(fixture.path().join("knowledge/folder")).unwrap();
        assert_eq!(
            get(&core, scope.0, scope.1, true).unwrap().folder_favorites[0].status,
            "replaced"
        );
        assert!(validate_folder(&core, scope.0, scope.1, &saved).is_err());
        fs::remove_dir(fixture.path().join("knowledge/folder")).unwrap();
        symlink(
            fixture.path().join("retained-folder"),
            fixture.path().join("knowledge/folder"),
        )
        .unwrap();
        assert_eq!(
            get(&core, scope.0, scope.1, true).unwrap().folder_favorites[0].status,
            "unavailable"
        );
        assert!(validate_folder(&core, scope.0, scope.1, &saved).is_err());
        assert!(favorite(&core, scope.0, scope.1, "folder", true).is_err());
        fs::rename(
            fixture.path().join("knowledge"),
            fixture.path().join("retained-root"),
        )
        .unwrap();
        fs::create_dir(fixture.path().join("knowledge")).unwrap();
        fs::create_dir(fixture.path().join("knowledge/folder")).unwrap();
        assert!(validate_folder(&core, scope.0, scope.1, &saved).is_err());
        let replacement = core
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let replacement_scope = super::tests::scope(&replacement);
        assert!(get(&core, replacement_scope.0, replacement_scope.1, true)
            .unwrap()
            .folder_favorites
            .is_empty());
    }
    #[test]
    fn strict_v2_migration_preserves_document_lists_sets_and_rolls_back_folder_failures() {
        let (fixture, core, _) = fixture();
        fs::create_dir(fixture.path().join("knowledge/folder")).unwrap();
        let current = core.refresh().unwrap();
        let scope = scope(&current);
        favorite(&core, scope.0, scope.1, "a.html", true).unwrap();
        let tab = opened(&core, scope, "b.html");
        capture_one(&core, scope, "旧セット", &tab);
        let path = stored_path(&core);
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // v2 must never accept a folder field, even if the extra list is empty.
        legacy["version"] = 2.into();
        assert!(serde_json::from_value::<LegacyStoredV2>(legacy.clone()).is_err());
        legacy.as_object_mut().unwrap().remove("folderFavorites");
        legacy.as_object_mut().unwrap().remove("setShortcuts");
        legacy.as_object_mut().unwrap().remove("session");
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &original).unwrap();
        let restarted = configured(fixture.path());
        let restored = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let restored_scope = super::tests::scope(&restored);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(get(&restarted, restored_scope.0, restored_scope.1, false)
            .unwrap()
            .folder_favorites
            .is_empty());
        fs::write(&path, b"externally changed").unwrap();
        assert!(favorite(
            &restarted,
            restored_scope.0,
            restored_scope.1,
            "folder",
            true
        )
        .is_err());
        assert!(restarted
            .workspace
            .lock()
            .unwrap()
            .settings
            .folder_favorites
            .is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"externally changed");
        fs::write(&path, &original).unwrap();
        favorite(
            &restarted,
            restored_scope.0,
            restored_scope.1,
            "folder",
            true,
        )
        .unwrap();
        let migrated: Stored = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(migrated.version, 5);
        assert!(
            migrated.lists == serde_json::from_value::<Lists>(legacy["lists"].clone()).unwrap()
        );
        assert_eq!(
            migrated.sets,
            serde_json::from_value::<Vec<WorkingSet>>(legacy["sets"].clone()).unwrap()
        );
        assert_eq!(migrated.folder_favorites.len(), 1);
        assert!(serde_json::from_slice::<LegacyStoredV2>(&fs::read(&path).unwrap()).is_err());
        assert!(restarted.workspace.lock().unwrap().tabs.is_empty());
    }

    #[test]
    fn lists_are_finite_and_recent_is_deduplicated_and_batched() {
        let (fixture, core, _) = fixture();
        for index in 0..51 {
            fs::write(
                fixture.path().join(format!("knowledge/{index}.html")),
                "<p>fixture</p>",
            )
            .unwrap();
        }
        let current = core.refresh().unwrap();
        let (workspace, view) = scope(&current);
        for index in 0..50 {
            favorite(&core, workspace, view, &format!("{index}.html"), true).unwrap();
        }
        let original = fs::read(stored_path(&core)).unwrap();
        assert!(favorite(&core, workspace, view, "50.html", true).is_err());
        assert_eq!(fs::read(stored_path(&core)).unwrap(), original);
        for index in 0..51 {
            visit(&core, &current, &format!("{index}.html"));
        }
        assert_eq!(get(&core, workspace, view, false).unwrap().recent.len(), 50);
        // All admitted views remain in memory until one finite batch is flushed.
        assert!(core.workspace.lock().unwrap().settings.dirty);
        flush(&core).unwrap();
        let bytes = fs::read(stored_path(&core)).unwrap();
        let (tab, url) = visit(&core, &current, "50.html");
        seen(&core, workspace, view, &tab, &url).unwrap();
        assert!(!core.workspace.lock().unwrap().settings.dirty);
        assert_eq!(fs::read(stored_path(&core)).unwrap(), bytes);
    }
    #[test]
    fn recent_one_shot_flushes_and_rejects_old_tokens_views_and_roots() {
        let (_fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        let tab = core.create_tab(workspace, view, "a.html").unwrap();
        let old = core.open(workspace, view, &tab, 1).unwrap();
        let current = core.open(workspace, view, &tab, 2).unwrap();
        assert!(seen(&core, workspace, view, &tab, &old).is_err());
        assert!(get(&core, workspace, view, false)
            .unwrap()
            .recent
            .is_empty());
        seen(&core, workspace, view, &tab, &current).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !stored_path(&core).exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(stored_path(&core).exists());
        let new_view = core.begin_view();
        assert!(seen(&core, workspace, view, &tab, &current).is_err());
        assert!(get(&core, "old-root", &new_view.view_id, false).is_err());
        assert_eq!(
            get(&core, workspace, &new_view.view_id, false)
                .unwrap()
                .recent
                .len(),
            1
        );
    }
    #[test]
    fn root_switch_flushes_recent_and_root_replacement_has_a_new_store() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        visit(&core, &initial, "a.html");
        let previous_path = stored_path(&core);
        fs::create_dir(fixture.path().join("other")).unwrap();
        fs::write(fixture.path().join("other/a.html"), "other").unwrap();
        let other = core.select(&fixture.path().join("other"), false).unwrap();
        let (workspace, view) = scope(&other);
        assert!(get(&core, workspace, view, false)
            .unwrap()
            .recent
            .is_empty());
        let saved: Stored = serde_json::from_slice(&fs::read(previous_path).unwrap()).unwrap();
        assert_eq!(saved.lists.recent.len(), 1);
        let back = core
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        core.watcher.lock().unwrap().take();
        #[cfg(windows)]
        {
            assert!(fs::rename(
                fixture.path().join("knowledge"),
                fixture.path().join("old-knowledge")
            )
            .is_err());
            let (workspace, view) = scope(&back);
            assert_eq!(
                get(&core, workspace, view, true).unwrap().favorites.len(),
                1
            );
        }
        #[cfg(unix)]
        {
            fs::rename(
                fixture.path().join("knowledge"),
                fixture.path().join("old-knowledge"),
            )
            .unwrap();
            fs::create_dir(fixture.path().join("knowledge")).unwrap();
            fs::write(fixture.path().join("knowledge/a.html"), "replacement").unwrap();
            let (workspace, view) = scope(&back);
            assert!(get(&core, workspace, view, true).is_err());
            let replacement = core
                .select(&fixture.path().join("knowledge"), false)
                .unwrap();
            let (workspace, view) = scope(&replacement);
            assert!(get(&core, workspace, view, true)
                .unwrap()
                .favorites
                .is_empty());
        }
    }
    #[test]
    fn internal_and_external_moves_follow_identity_and_missing_entries_are_retained() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        visit(&core, &initial, "a.html");
        let result = crate::tree_mutations::perform(
            &core,
            workspace,
            view,
            crate::tree_mutations::Mutation::RenameHtml {
                source: "a.html".into(),
                name: "renamed".into(),
            },
        )
        .unwrap();
        assert!(result.warning.is_none());
        assert_eq!(
            get(&core, workspace, view, true).unwrap().recent[0]
                .document
                .relative_path,
            "renamed.html"
        );
        fs::rename(
            fixture.path().join("knowledge/renamed.html"),
            fixture.path().join("knowledge/moved.html"),
        )
        .unwrap();
        core.refresh().unwrap();
        let lists = get(&core, workspace, view, true).unwrap();
        assert_eq!(lists.favorites[0].document.relative_path, "moved.html");
        assert_eq!(
            validate(&core, workspace, view, &lists.favorites[0].document).unwrap(),
            "moved.html"
        );
        fs::remove_file(fixture.path().join("knowledge/moved.html")).unwrap();
        let lists = get(&core, workspace, view, true).unwrap();
        assert_eq!(lists.favorites[0].status, "missing");
        assert!(validate(&core, workspace, view, &lists.favorites[0].document).is_err());
        assert_eq!(lists.recent.len(), 1);
    }
    #[test]
    fn replacement_never_inherits_the_previous_document_and_corruption_is_preserved() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        fs::rename(
            fixture.path().join("knowledge/a.html"),
            fixture.path().join("a-retained.html"),
        )
        .unwrap();
        fs::write(fixture.path().join("knowledge/a.html"), "new document").unwrap();
        let lists = get(&core, workspace, view, true).unwrap();
        assert_eq!(lists.favorites[0].status, "replaced");
        assert!(validate(&core, workspace, view, &lists.favorites[0].document).is_err());
        let path = stored_path(&core);
        fs::write(&path, b"{broken").unwrap();
        assert!(favorite(&core, workspace, view, "b.html", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let restarted = configured(fixture.path());
        let restored = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let (workspace, view) = scope(&restored);
        assert!(get(&restarted, workspace, view, true).unwrap().read_only);
        assert!(favorite(&restarted, workspace, view, "b.html", true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }
    #[test]
    fn saved_identity_is_retained_through_registration_open_and_existing_session_reuse() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        let saved = get(&core, workspace, view, true)
            .unwrap()
            .favorites
            .remove(0)
            .document;
        assert!(validate(&core, workspace, view, &saved).is_ok());
        let checked = core
            .create_tab_checked(workspace, view, "a.html", Some(saved.identity.clone()))
            .unwrap();
        let original_tab = core.create_tab(workspace, view, "a.html").unwrap();
        core.open(workspace, view, &original_tab, 1).unwrap();
        fs::rename(
            fixture.path().join("knowledge/a.html"),
            fixture.path().join("a-retained.html"),
        )
        .unwrap();
        fs::write(fixture.path().join("knowledge/a.html"), "replacement").unwrap();
        assert!(core
            .create_tab_checked(workspace, view, "a.html", Some(saved.identity))
            .is_err());
        assert!(core.open(workspace, view, &checked, 1).is_err());
        assert!(core.workspace.lock().unwrap().tabs[&checked]
            .session
            .is_none());
        favorite(&core, workspace, view, "a.html", false).unwrap();
        favorite(&core, workspace, view, "a.html", true).unwrap();
        let replaced = get(&core, workspace, view, true)
            .unwrap()
            .favorites
            .remove(0)
            .document;
        assert!(validate_tab(&core, workspace, view, &replaced, Some(&original_tab)).is_err());
    }
    #[test]
    fn failed_recent_flush_retains_pending_and_allows_another_root() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        visit(&core, &initial, "a.html");
        let path = stored_path(&core);
        fs::write(&path, b"external edit").unwrap();
        fs::create_dir(fixture.path().join("other")).unwrap();
        let other = core.select(&fixture.path().join("other"), false).unwrap();
        assert_eq!(core.pending_workspace_settings.lock().unwrap().len(), 1);
        let (workspace, view) = scope(&other);
        assert!(get(&core, workspace, view, false)
            .unwrap()
            .recent
            .is_empty());
        let restored = core
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let (workspace, view) = scope(&restored);
        assert_eq!(get(&core, workspace, view, false).unwrap().recent.len(), 1);
        assert!(flush(&core).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
    }
    #[test]
    fn saved_identity_admission_does_not_pin_normal_editor_reload() {
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        let reference = get(&core, workspace, view, true)
            .unwrap()
            .favorites
            .remove(0)
            .document;
        let tab = core
            .create_tab_checked(workspace, view, "a.html", Some(reference.identity))
            .unwrap();
        core.open(workspace, view, &tab, 1).unwrap();
        assert!(core.workspace.lock().unwrap().tabs[&tab]
            .expected_identity
            .is_none());
        fs::rename(
            fixture.path().join("knowledge/a.html"),
            fixture.path().join("old-document.html"),
        )
        .unwrap();
        fs::write(
            fixture.path().join("knowledge/a.html"),
            "atomic editor save",
        )
        .unwrap();
        assert!(core.open(workspace, view, &tab, 2).is_ok());
    }
    #[test]
    fn write_and_read_use_the_same_schema_and_byte_budget() {
        let mut settings = Settings {
            root_identity: "a".repeat(64),
            ..Default::default()
        };
        let document = DocumentRef {
            relative_path: format!("{}x.html", "a/".repeat(2045)),
            identity: "b".repeat(64),
        };
        assert_eq!(document.relative_path.len(), 4096);
        settings.lists.recent.push(document.clone());
        let bytes = encoded(&settings).unwrap();
        let stored: Stored = serde_json::from_slice(&bytes).unwrap();
        assert!(valid_list(&stored.lists.recent));
        settings.lists.recent[0].relative_path.insert(0, 'x');
        assert!(encoded(&settings).is_err());
        settings.lists.recent[0] = document.clone();
        for index in 0..50 {
            settings.lists.favorites.push(DocumentRef {
                identity: format!("{index:064x}"),
                ..document.clone()
            });
        }
        settings.lists.recent = settings.lists.favorites.clone();
        assert!(encoded(&settings).is_err());
    }
    #[test]
    fn folder_schema_rejects_duplicate_identity_and_utf8_byte_overflow() {
        let document = DocumentRef {
            relative_path: "a.html".into(),
            identity: "b".repeat(64),
        };
        let folder = DocumentRef {
            relative_path: format!("{}あ", "あ/".repeat(1022)),
            identity: "c".repeat(64),
        };
        let mut settings = Settings {
            root_identity: "a".repeat(64),
            lists: Lists {
                favorites: vec![document.clone()],
                recent: vec![],
            },
            folder_favorites: vec![folder.clone()],
            ..Default::default()
        };
        assert!(encoded(&settings).is_ok());
        settings.folder_favorites[0].relative_path.push_str("日本");
        assert!(encoded(&settings).is_err());
        settings.folder_favorites[0] = folder;
        settings.folder_favorites[0].identity = document.identity;
        assert!(encoded(&settings).is_err());
        settings.folder_favorites[0].identity = "c".repeat(64);
        let stored = serde_json::to_value(Stored {
            version: 4,
            root_identity: settings.root_identity.clone(),
            lists: settings.lists.clone(),
            sets: vec![],
            folder_favorites: settings.folder_favorites.clone(),
            set_shortcuts: settings.set_shortcuts.clone(),
            session: None,
        })
        .unwrap();
        let mut future = stored.clone();
        future["unknown"] = true.into();
        assert!(serde_json::from_value::<Stored>(future).is_err());
        let mut missing = stored;
        missing.as_object_mut().unwrap().remove("folderFavorites");
        assert!(serde_json::from_value::<Stored>(missing).is_err());
    }
    #[test]
    fn pending_capacity_allows_returning_to_a_retained_root() {
        let (_fixture, core, _) = fixture();
        let mut retained = core.workspace.lock().unwrap().settings.clone();
        retained.dirty = true;
        core.workspace.lock().unwrap().settings.dirty = true;
        for index in 0..8 {
            let mut settings = retained.clone();
            settings.root_identity = format!("{index:064x}");
            core.pending_workspace_settings
                .lock()
                .unwrap()
                .insert(settings.root_identity.clone(), settings);
        }
        let loaded =
            core.pending_workspace_settings.lock().unwrap()[&format!("{:064x}", 0)].clone();
        assert_eq!(
            switch(&core, loaded).unwrap().root_identity,
            format!("{:064x}", 0)
        );
        assert_eq!(core.pending_workspace_settings.lock().unwrap().len(), 8);
    }
    #[cfg(unix)]
    #[test]
    fn unsafe_settings_destinations_and_unreadable_document_links_are_not_followed() {
        use std::os::unix::fs::symlink;
        let (fixture, core, initial) = fixture();
        let (workspace, view) = scope(&initial);
        favorite(&core, workspace, view, "a.html", true).unwrap();
        let saved_path = stored_path(&core);
        let original = fs::read(&saved_path).unwrap();
        fs::rename(
            fixture.path().join("knowledge/a.html"),
            fixture.path().join("a-retained.html"),
        )
        .unwrap();
        symlink(
            fixture.path().join("a-retained.html"),
            fixture.path().join("knowledge/a.html"),
        )
        .unwrap();
        assert_eq!(
            get(&core, workspace, view, true).unwrap().favorites[0].status,
            "unavailable"
        );
        fs::rename(
            fixture.path().join("config/workspace-settings"),
            fixture.path().join("retained-settings"),
        )
        .unwrap();
        symlink(
            fixture.path().join("retained-settings"),
            fixture.path().join("config/workspace-settings"),
        )
        .unwrap();
        assert!(favorite(&core, workspace, view, "b.html", true).is_err());
        assert_eq!(fs::read(&saved_path).unwrap(), original);
        assert_eq!(
            core.workspace
                .lock()
                .unwrap()
                .settings
                .lists
                .favorites
                .len(),
            1
        );
    }
    fn capture_one(core: &Core, scope: (&str, &str), name: &str, tab: &str) -> SetSnapshot {
        capture_set(
            core,
            scope.0,
            scope.1,
            name.into(),
            vec![CaptureItem {
                tab_id: Some(tab.into()),
                document: None,
                column: 0,
                zoom: 125.0,
            }],
            [Some(0), None],
            0,
        )
        .unwrap()
    }
    fn opened(core: &Core, scope: (&str, &str), path: &str) -> String {
        let tab = core.create_tab(scope.0, scope.1, path).unwrap();
        core.open(scope.0, scope.1, &tab, 1).unwrap();
        tab
    }
    #[test]
    fn set_shortcuts_keep_ids_through_rename_reorder_restart_and_delete() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let tab = opened(&core, scope, "a.html");
        let a = capture_one(&core, scope, "A", &tab).sets[0].id.clone();
        let b = capture_one(&core, scope, "B", &tab).sets[1].id.clone();
        assign_set_shortcut(&core, scope.0, scope.1, &a, Some(1)).unwrap();
        assert!(assign_set_shortcut(&core, scope.0, scope.1, &b, Some(1)).is_err());
        for slot in [0, 11, 255] {
            assert!(assign_set_shortcut(&core, scope.0, scope.1, &b, Some(slot)).is_err());
        }
        assert!(assign_set_shortcut(&core, "stale", scope.1, &b, Some(2)).is_err());
        assert!(assign_set_shortcut(&core, scope.0, "stale", &b, Some(2)).is_err());
        assert!(assign_set_shortcut(&core, scope.0, scope.1, "unknown", Some(2)).is_err());
        edit_set(&core, scope.0, scope.1, &a, Some("改名".into())).unwrap();
        // The persisted order may change; shortcuts must follow IDs, never indices.
        core.workspace.lock().unwrap().settings.sets.reverse();
        let updated = assign_set_shortcut(&core, scope.0, scope.1, &b, Some(10)).unwrap();
        assert_eq!(updated.set_shortcuts[0].as_deref(), Some(a.as_str()));
        assert_eq!(updated.set_shortcuts[9].as_deref(), Some(b.as_str()));
        let restarted = configured(fixture.path());
        let snapshot = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let next = super::tests::scope(&snapshot);
        assert_eq!(
            get_sets(&restarted, next.0, next.1).unwrap().set_shortcuts,
            updated.set_shortcuts
        );
        assert!(restarted.workspace.lock().unwrap().tabs.is_empty());
        assert_eq!(
            resolve_set(&restarted, next.0, next.1, &a, Some(1))
                .unwrap()
                .set
                .name,
            "改名"
        );
        assert!(resolve_set(&restarted, next.0, next.1, &b, Some(1)).is_err());
        assert!(resolve_set(&restarted, next.0, next.1, &a, Some(2)).is_err());
        assert!(resolve_set(&restarted, next.0, next.1, &a, Some(0)).is_err());
        assign_set_shortcut(&restarted, next.0, next.1, &b, Some(2)).unwrap();
        assert!(resolve_set(&restarted, next.0, next.1, &b, Some(10)).is_err());
        let deleted = edit_set(&restarted, next.0, next.1, &a, None).unwrap();
        assert!(deleted.set_shortcuts[0].is_none());
        assert_eq!(deleted.set_shortcuts[1].as_deref(), Some(b.as_str()));
        let cleared = assign_set_shortcut(&restarted, next.0, next.1, &b, None).unwrap();
        assert!(cleared.set_shortcuts.iter().all(Option::is_none));
        fs::create_dir(fixture.path().join("other")).unwrap();
        let other = restarted
            .select(&fixture.path().join("other"), false)
            .unwrap();
        let other_scope = super::tests::scope(&other);
        assert!(get_sets(&restarted, other_scope.0, other_scope.1)
            .unwrap()
            .set_shortcuts
            .iter()
            .all(Option::is_none));
        assert!(assign_set_shortcut(&restarted, next.0, next.1, &b, Some(1)).is_err());
    }
    #[test]
    fn set_shortcuts_atomic_failure_rolls_back_assignment_and_deletion_together() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let tab = opened(&core, scope, "a.html");
        let id = capture_one(&core, scope, "保存", &tab).sets[0].id.clone();
        assign_set_shortcut(&core, scope.0, scope.1, &id, Some(10)).unwrap();
        let before = get_sets(&core, scope.0, scope.1).unwrap();
        let path = stored_path(&core);
        let original = fs::read(&path).unwrap();
        fs::write(&path, b"externally changed").unwrap();
        assert!(assign_set_shortcut(&core, scope.0, scope.1, &id, Some(1)).is_err());
        assert!(edit_set(&core, scope.0, scope.1, &id, None).is_err());
        let after = get_sets(&core, scope.0, scope.1).unwrap();
        assert_eq!(after.sets, before.sets);
        assert_eq!(after.set_shortcuts, before.set_shortcuts);
        assert_eq!(fs::read(&path).unwrap(), b"externally changed");
        fs::write(&path, original).unwrap();
        assign_set_shortcut(&core, scope.0, scope.1, &id, Some(1)).unwrap();
        assert_eq!(
            fs::read(fixture.path().join("knowledge/a.html")).unwrap(),
            b"<input value='original'>"
        );
    }
    #[test]
    fn set_shortcuts_v1_v2_v3_read_without_assignment_or_eager_migration() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        favorite(&core, scope.0, scope.1, "a.html", true).unwrap();
        let tab = opened(&core, scope, "a.html");
        let id = capture_one(&core, scope, "旧設定", &tab).sets[0].id.clone();
        let path = stored_path(&core);
        let current: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for version in [1, 2, 3, 4] {
            let mut legacy = current.clone();
            legacy["version"] = version.into();
            legacy.as_object_mut().unwrap().remove("session");
            if version < 4 {
                legacy.as_object_mut().unwrap().remove("setShortcuts");
            }
            if version < 3 {
                legacy.as_object_mut().unwrap().remove("folderFavorites");
            }
            if version == 1 {
                legacy.as_object_mut().unwrap().remove("sets");
            }
            let original = serde_json::to_vec(&legacy).unwrap();
            fs::write(&path, &original).unwrap();
            let reader = configured(fixture.path());
            let snapshot = reader
                .select(&fixture.path().join("knowledge"), false)
                .unwrap();
            let next = super::tests::scope(&snapshot);
            let sets = get_sets(&reader, next.0, next.1).unwrap();
            assert!(!sets.read_only);
            assert!(sets.set_shortcuts.iter().all(Option::is_none));
            assert_eq!(sets.sets.len(), usize::from(version != 1));
            assert_eq!(
                get(&reader, next.0, next.1, false).unwrap().favorites.len(),
                1
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            if version != 1 {
                assign_set_shortcut(&reader, next.0, next.1, &id, Some(1)).unwrap();
                let written: Stored = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                assert_eq!(written.version, 5);
                assert_eq!(written.sets, sets.sets);
            }
        }
    }
    #[test]
    fn set_shortcuts_schema_rejects_duplicates_dangling_ids_bounds_and_old_extras() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let tab = opened(&core, scope, "a.html");
        let id = capture_one(&core, scope, "厳密", &tab).sets[0].id.clone();
        assign_set_shortcut(&core, scope.0, scope.1, &id, Some(1)).unwrap();
        let path = stored_path(&core);
        let current: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut broken = vec![];
        for version in [1, 2, 3, 4, 6] {
            let mut data = current.clone();
            data["version"] = version.into();
            broken.push(serde_json::to_vec(&data).unwrap());
        }
        for slots in [
            serde_json::json!([
                id.clone(),
                id.clone(),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null
            ]),
            serde_json::json!([
                "f".repeat(64),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null
            ]),
            serde_json::json!([null]),
            serde_json::json!([null, null, null, null, null, null, null, null, null, null, null]),
            serde_json::json!("bad"),
        ] {
            let mut data = current.clone();
            data["setShortcuts"] = slots;
            broken.push(serde_json::to_vec(&data).unwrap());
        }
        let mut unknown = current.clone();
        unknown["unknown"] = true.into();
        broken.push(serde_json::to_vec(&unknown).unwrap());
        let duplicate = serde_json::to_string(&current).unwrap().replacen(
            '{',
            "{\"setShortcuts\":[null,null,null,null,null,null,null,null,null,null],",
            1,
        );
        broken.push(duplicate.into_bytes());
        for bytes in broken {
            fs::write(&path, &bytes).unwrap();
            let reader = configured(fixture.path());
            let snapshot = reader
                .select(&fixture.path().join("knowledge"), false)
                .unwrap();
            let next = super::tests::scope(&snapshot);
            assert!(get_sets(&reader, next.0, next.1).unwrap().read_only);
            assert!(assign_set_shortcut(&reader, next.0, next.1, &id, Some(1)).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let mut optional = current;
        optional.as_object_mut().unwrap().remove("setShortcuts");
        let bytes = serde_json::to_vec(&optional).unwrap();
        fs::write(&path, &bytes).unwrap();
        let reader = configured(fixture.path());
        let snapshot = reader
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let next = super::tests::scope(&snapshot);
        let sets = get_sets(&reader, next.0, next.1).unwrap();
        assert!(!sets.read_only);
        assert!(sets.set_shortcuts.iter().all(Option::is_none));
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn sets_crud_restart_and_resolve_do_not_admit_views_or_modify_html() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let original = fs::read(fixture.path().join("knowledge/a.html")).unwrap();
        let tab = opened(&core, scope, "a.html");
        let saved = capture_one(&core, scope, "計算と資料", &tab);
        let id = saved.sets[0].id.clone();
        assert_eq!(saved.sets[0].items[0].zoom, 125.0);
        assert_eq!(
            resolve_set(&core, scope.0, scope.1, &id, None)
                .unwrap()
                .items[0]
                .reusable_tabs,
            vec![tab]
        );
        edit_set(&core, scope.0, scope.1, &id, Some("別の名前".into())).unwrap();
        let restarted = configured(fixture.path());
        let snapshot = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let restored_scope = super::tests::scope(&snapshot);
        let resolved =
            resolve_set(&restarted, restored_scope.0, restored_scope.1, &id, None).unwrap();
        assert_eq!(resolved.set.name, "別の名前");
        assert_eq!(resolved.items[0].status, "available");
        assert!(restarted.workspace.lock().unwrap().tabs.is_empty());
        assert_eq!(
            fs::read(fixture.path().join("knowledge/a.html")).unwrap(),
            original
        );
        edit_set(&restarted, restored_scope.0, restored_scope.1, &id, None).unwrap();
        assert!(get_sets(&restarted, restored_scope.0, restored_scope.1)
            .unwrap()
            .sets
            .is_empty());
        assert!(resolve_set(&restarted, scope.0, scope.1, &id, None).is_err());
    }
    #[test]
    fn sets_allow_independent_columns_but_bound_duplicates_zoom_active_and_count() {
        let (_fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let a = opened(&core, scope, "a.html");
        let b = opened(&core, scope, "a.html");
        let items = || {
            vec![
                CaptureItem {
                    tab_id: Some(a.clone()),
                    document: None,
                    column: 0,
                    zoom: 75.0,
                },
                CaptureItem {
                    tab_id: Some(b.clone()),
                    document: None,
                    column: 1,
                    zoom: 175.0,
                },
            ]
        };
        let saved = capture_set(
            &core,
            scope.0,
            scope.1,
            "左右".into(),
            items(),
            [Some(0), Some(1)],
            1,
        )
        .unwrap();
        assert_eq!(
            saved.sets[0].items[0].document,
            saved.sets[0].items[1].document
        );
        let bytes = fs::read(stored_path(&core)).unwrap();
        for kind in 0..4 {
            let mut bad = items();
            let mut active = [Some(0), Some(1)];
            match kind {
                0 => bad[1].column = 0,
                1 => bad[0].zoom = f64::NAN,
                2 => active[1] = Some(99),
                _ => bad[0].zoom = 201.0,
            }
            assert!(
                capture_set(&core, scope.0, scope.1, "invalid".into(), bad, active, 0).is_err()
            );
            assert_eq!(fs::read(stored_path(&core)).unwrap(), bytes);
        }
        for index in 1..SET_LIMIT {
            capture_one(&core, scope, &format!("set{index}"), &a);
        }
        assert!(capture_set(
            &core,
            scope.0,
            scope.1,
            "11".into(),
            items(),
            [Some(0), Some(1)],
            0
        )
        .is_err());
    }
    #[test]
    fn thirty_item_set_resolves_metadata_without_native_tabs_and_rejects_thirty_one() {
        let (fixture, core, _) = fixture();
        for index in 0..31 {
            fs::write(
                fixture.path().join(format!("knowledge/{index}.html")),
                "<script>throw Error('must not run')</script>",
            )
            .unwrap();
        }
        let snapshot = core.refresh().unwrap();
        let scope = scope(&snapshot);
        let ids: Vec<_> = (0..31)
            .map(|index| opened(&core, scope, &format!("{index}.html")))
            .collect();
        let items = |count: usize| {
            ids.iter()
                .take(count)
                .map(|id| CaptureItem {
                    tab_id: Some(id.clone()),
                    document: None,
                    column: 0,
                    zoom: 100.0,
                })
                .collect()
        };
        assert!(capture_set(
            &core,
            scope.0,
            scope.1,
            "31".into(),
            items(31),
            [Some(0), None],
            0
        )
        .is_err());
        let saved = capture_set(
            &core,
            scope.0,
            scope.1,
            "30".into(),
            items(30),
            [Some(0), None],
            0,
        )
        .unwrap();
        for id in ids {
            core.close_tab(scope.0, scope.1, &id).unwrap();
        }
        let resolved = resolve_set(&core, scope.0, scope.1, &saved.sets[0].id, None).unwrap();
        assert_eq!(resolved.items.len(), 30);
        assert!(resolved.items.iter().all(|item| item.status == "available"));
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[test]
    fn sets_follow_moves_keep_missing_and_replaced_refs_and_validate_root() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        let tab = opened(&core, scope, "a.html");
        let saved = capture_one(&core, scope, "移動", &tab);
        let id = &saved.sets[0].id;
        crate::tree_mutations::perform(
            &core,
            scope.0,
            scope.1,
            crate::tree_mutations::Mutation::RenameHtml {
                source: "a.html".into(),
                name: "renamed".into(),
            },
        )
        .unwrap();
        assert_eq!(
            resolve_set(&core, scope.0, scope.1, id, None)
                .unwrap()
                .set
                .items[0]
                .document
                .relative_path,
            "renamed.html"
        );
        fs::rename(
            fixture.path().join("knowledge/renamed.html"),
            fixture.path().join("knowledge/moved.html"),
        )
        .unwrap();
        core.refresh().unwrap();
        assert_eq!(
            resolve_set(&core, scope.0, scope.1, id, None)
                .unwrap()
                .set
                .items[0]
                .document
                .relative_path,
            "moved.html"
        );
        fs::rename(
            fixture.path().join("knowledge/moved.html"),
            fixture.path().join("old.html"),
        )
        .unwrap();
        fs::write(
            fixture.path().join("knowledge/moved.html"),
            "different identity",
        )
        .unwrap();
        assert_eq!(
            resolve_set(&core, scope.0, scope.1, id, None)
                .unwrap()
                .items[0]
                .status,
            "replaced"
        );
        fs::remove_file(fixture.path().join("knowledge/moved.html")).unwrap();
        assert_eq!(
            resolve_set(&core, scope.0, scope.1, id, None)
                .unwrap()
                .items[0]
                .status,
            "missing"
        );
        fs::create_dir(fixture.path().join("other")).unwrap();
        let other = core.select(&fixture.path().join("other"), false).unwrap();
        assert!(resolve_set(&core, scope.0, scope.1, id, None).is_err());
        let other_scope = super::tests::scope(&other);
        assert!(get_sets(&core, other_scope.0, other_scope.1)
            .unwrap()
            .sets
            .is_empty());
    }
    #[test]
    fn legacy_schema_is_migrated_only_on_atomic_success_and_corrupt_future_data_is_preserved() {
        let (fixture, core, initial) = fixture();
        let scope = scope(&initial);
        favorite(&core, scope.0, scope.1, "a.html", true).unwrap();
        let path = stored_path(&core);
        let mut legacy: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        legacy["version"] = 1.into();
        legacy.as_object_mut().unwrap().remove("sets");
        legacy.as_object_mut().unwrap().remove("folderFavorites");
        legacy.as_object_mut().unwrap().remove("setShortcuts");
        legacy.as_object_mut().unwrap().remove("session");
        let original = serde_json::to_vec(&legacy).unwrap();
        fs::write(&path, &original).unwrap();
        let restarted = configured(fixture.path());
        let current = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        let scope = super::tests::scope(&current);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(
            get(&restarted, scope.0, scope.1, false)
                .unwrap()
                .favorites
                .len(),
            1
        );
        let tab = opened(&restarted, scope, "a.html");
        // A failed first migration cannot replace v1 or retain a partial set.
        let mut externally_changed = legacy.clone();
        externally_changed["lists"]["recent"] = externally_changed["lists"]["favorites"].clone();
        let changed = serde_json::to_vec(&externally_changed).unwrap();
        fs::write(&path, &changed).unwrap();
        assert!(capture_set(
            &restarted,
            scope.0,
            scope.1,
            "失敗".into(),
            vec![CaptureItem {
                tab_id: Some(tab.clone()),
                document: None,
                column: 0,
                zoom: 100.0
            }],
            [Some(0), None],
            0
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), changed);
        assert!(get_sets(&restarted, scope.0, scope.1)
            .unwrap()
            .sets
            .is_empty());
        fs::write(&path, &original).unwrap();
        capture_one(&restarted, scope, "旧設定", &tab);
        let migrated: Stored = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(migrated.version, 5);
        assert_eq!(migrated.lists.favorites.len(), 1);
        assert_eq!(migrated.sets.len(), 1);
        for broken in [
            b"{broken".to_vec(),
            br#"{"version":5}"#.to_vec(),
            vec![b' '; MAX_BYTES + 1],
        ] {
            fs::write(&path, &broken).unwrap();
            assert!(edit_set(&restarted, scope.0, scope.1, &migrated.sets[0].id, None).is_err());
            assert_eq!(
                get_sets(&restarted, scope.0, scope.1).unwrap().sets.len(),
                1
            );
            assert_eq!(fs::read(&path).unwrap(), broken);
            let read_only = configured(fixture.path());
            let snapshot = read_only
                .select(&fixture.path().join("knowledge"), false)
                .unwrap();
            let scope = super::tests::scope(&snapshot);
            assert!(get_sets(&read_only, scope.0, scope.1).unwrap().read_only);
            assert_eq!(fs::read(&path).unwrap(), broken);
        }
    }
    #[test]
    fn set_byte_budget_and_strict_topology_reject_without_rewriting() {
        let mut settings = Settings {
            root_identity: "a".repeat(64),
            ..Default::default()
        };
        for group in 0..SET_LIMIT {
            let items = (0..SET_ITEM_LIMIT)
                .map(|index| SetItem {
                    document: DocumentRef {
                        relative_path: format!("{}x.html", "a/".repeat(2045)),
                        identity: format!("{index:064x}"),
                    },
                    column: 0,
                    zoom: 100.0,
                })
                .collect();
            settings.sets.push(WorkingSet {
                id: format!("{group:064x}"),
                name: "finite".into(),
                items,
                active: [Some(0), None],
                active_column: 0,
            });
        }
        assert!(valid_sets(&settings.sets));
        assert!(encoded(&settings).unwrap_err().contains("256KiB"));
        let unknown =
            br#"{"version":1,"rootIdentity":"x","lists":{"favorites":[],"recent":[]},"sets":[]}"#;
        assert!(serde_json::from_slice::<LegacyStored>(unknown).is_err());
    }
    fn session_capture(tab: &str) -> SessionCapture {
        SessionCapture {
            items: vec![
                CaptureItem {
                    tab_id: Some(tab.into()),
                    document: None,
                    column: 0,
                    zoom: 125.0,
                },
                CaptureItem {
                    tab_id: Some(tab.into()),
                    document: None,
                    column: 1,
                    zoom: 75.0,
                },
            ],
            active: [Some(0), Some(1)],
            active_column: 1,
            split: true,
            help: None,
        }
    }
    #[test]
    fn session_restores_both_panes_and_root_identity_without_issuing_grants() {
        let (fixture, core, snapshot) = fixture();
        let scope = scope(&snapshot);
        let (tab, _) = visit(&core, &snapshot, "a.html");
        capture_session(&core, scope.0, scope.1, session_capture(&tab)).unwrap();
        let expected = get_session(&core, scope.0, scope.1).unwrap().unwrap();
        let path = stored_path(&core);
        let before = fs::read(&path).unwrap();
        capture_session(&core, scope.0, scope.1, session_capture(&tab)).unwrap();
        assert_eq!(before, fs::read(&path).unwrap());
        fs::remove_file(fixture.path().join("knowledge/a.html")).unwrap();
        let restarted = configured(fixture.path());
        let next = restarted
            .select(&fixture.path().join("knowledge"), false)
            .unwrap();
        restarted.watcher.lock().unwrap().take();
        let next_scope = super::tests::scope(&next);
        assert_eq!(
            get_session(&restarted, next_scope.0, next_scope.1).unwrap(),
            Some(expected.clone())
        );
        assert!(restarted.workspace.lock().unwrap().tabs.is_empty());
        // Existing missing references are admitted as lazy placeholders, never arbitrary paths.
        let lazy = SessionCapture {
            items: expected
                .items
                .iter()
                .map(|item| CaptureItem {
                    tab_id: None,
                    document: Some(item.document.clone()),
                    column: item.column,
                    zoom: item.zoom,
                })
                .collect(),
            active: expected.active,
            active_column: 0,
            split: true,
            help: None,
        };
        capture_session(&restarted, next_scope.0, next_scope.1, lazy).unwrap();
        fs::create_dir(fixture.path().join("other")).unwrap();
        let other = restarted
            .select(&fixture.path().join("other"), false)
            .unwrap();
        restarted.watcher.lock().unwrap().take();
        let other_scope = super::tests::scope(&other);
        assert!(get_session(&restarted, other_scope.0, other_scope.1)
            .unwrap()
            .is_none());
        assert!(get_session(&restarted, next_scope.0, next_scope.1).is_err());
    }
    #[test]
    fn session_rejects_forged_references_and_keeps_prior_file_on_conflict() {
        let (_fixture, core, snapshot) = fixture();
        let scope = scope(&snapshot);
        let (tab, _) = visit(&core, &snapshot, "a.html");
        capture_session(&core, scope.0, scope.1, session_capture(&tab)).unwrap();
        let prior = get_session(&core, scope.0, scope.1).unwrap();
        let path = stored_path(&core);
        let bytes = fs::read(&path).unwrap();
        let mut forged = session_capture(&tab);
        forged.items[0].tab_id = None;
        forged.items[0].document = Some(DocumentRef {
            relative_path: "a.html".into(),
            identity: "0".repeat(64),
        });
        assert!(capture_session(&core, scope.0, scope.1, forged).is_err());
        assert_eq!(bytes, fs::read(&path).unwrap());
        let mut external = bytes.clone();
        external.push(b' ');
        fs::write(&path, &external).unwrap();
        let mut changed = session_capture(&tab);
        changed.active_column = 0;
        assert!(capture_session(&core, scope.0, scope.1, changed).is_err());
        assert_eq!(external, fs::read(&path).unwrap());
        assert_eq!(get_session(&core, scope.0, scope.1).unwrap(), prior);
    }
    #[test]
    fn session_retains_admitted_missing_loaded_views_without_blocking_other_layout_changes() {
        let (fixture, core, snapshot) = fixture();
        let scope = scope(&snapshot);
        let (tab, _) = visit(&core, &snapshot, "a.html");
        capture_session(&core, scope.0, scope.1, session_capture(&tab)).unwrap();
        let identity = get_session(&core, scope.0, scope.1).unwrap().unwrap().items[0]
            .document
            .identity
            .clone();
        fs::remove_file(fixture.path().join("knowledge/a.html")).unwrap();
        let mut next = session_capture(&tab);
        next.items[0].zoom = 150.0;
        capture_session(&core, scope.0, scope.1, next).unwrap();
        let saved = get_session(&core, scope.0, scope.1).unwrap().unwrap();
        assert_eq!(saved.items[0].zoom, 150.0);
        assert_eq!(saved.items[0].document.identity, identity);
        fs::write(fixture.path().join("knowledge/a.html"), "replacement").unwrap();
        assert!(core
            .create_tab_checked(scope.0, scope.1, "a.html", Some(identity))
            .is_err());
    }
    #[test]
    fn session_supports_more_than_manual_set_limit_and_empty_layout() {
        let items: Vec<_> = (0..101)
            .map(|index| SetItem {
                document: DocumentRef {
                    relative_path: format!("{index}.html"),
                    identity: format!("{index:064x}"),
                },
                column: 0,
                zoom: 100.0,
            })
            .collect();
        let session = TabSession {
            items,
            active: [Some(100), None],
            active_column: 0,
            split: false,
            help: None,
        };
        assert!(valid_session(&session));
        let empty = TabSession {
            items: vec![],
            active: [None, None],
            active_column: 0,
            split: false,
            help: Some(SessionHelp {
                index: 0,
                column: 0,
                zoom: 100.0,
                active: true,
            }),
        };
        assert!(valid_session(&empty));
        let mut invalid = session.clone();
        invalid.active[0] = Some(101);
        assert!(!valid_session(&invalid));
        let mut settings = Settings {
            root_identity: "a".repeat(64),
            session: Some(session),
            ..Default::default()
        };
        assert!(encoded(&settings).is_ok());
        settings.session.as_mut().unwrap().items[0]
            .document
            .relative_path = "../escape.html".into();
        assert!(encoded(&settings).is_err());
    }
}
