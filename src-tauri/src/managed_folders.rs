//! Profile registration never owns or deletes the user's folder or documents.
use crate::{
    core::{Core, Snapshot},
    html_authoring, knowledge, profile_store, write_fs,
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

const FILE: &str = "managed-folders.json";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    name: String,
    path: PathBuf,
    identity: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u8,
    folders: Vec<Entry>,
    selected_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFolder {
    id: String,
    name: String,
    path: PathBuf,
    status: &'static str,
    kit_update: &'static str,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFolders {
    pub revision: String,
    folders: Vec<ManagedFolder>,
    selected_id: Option<String>,
}
fn profile(core: &Core) -> Result<&Path, String> {
    core.settings_path
        .get()
        .and_then(|path| path.parent())
        .ok_or_else(|| "設定の保存先がありません".into())
}
fn load(core: &Core) -> Result<(Registry, Option<String>), String> {
    let (mut value, digest): (Registry, _) = profile_store::read(profile(core)?, FILE)?;
    if digest.is_none() {
        value.version = 1;
    }
    let mut ids = std::collections::HashSet::new();
    if value.version != 1
        || value.folders.len() > 64
        || value.folders.iter().any(|entry| {
            crate::document_identity::normalize_uuid(&entry.id).as_deref() != Some(&entry.id)
                || !entry.path.is_absolute()
                || !ids.insert(&entry.id)
        })
        || value
            .selected_id
            .as_ref()
            .is_some_and(|id| !ids.contains(id))
    {
        return Err("専用フォルダー一覧が壊れています。既存内容を保持します".into());
    }
    Ok((value, digest))
}
fn expected(core: &Core, revision: &str) -> Result<(Registry, Option<String>), String> {
    let loaded = load(core)?;
    if loaded.1.as_deref().unwrap_or("none") != revision {
        return Err("一覧が変更されました。開き直してください".into());
    }
    Ok(loaded)
}
pub(crate) fn marker_for_dir(path: &Path, dir: &Arc<Dir>) -> Result<Option<String>, String> {
    let Some(value) = html_authoring::managed_marker(path.to_path_buf(), dir.clone())? else {
        return Ok(None);
    };
    if value.get("version").and_then(|v| v.as_u64()) != Some(1)
        || value.get("kind").and_then(|v| v.as_str()) != Some("mogledge-managed-folder")
    {
        return Err("専用フォルダーの識別情報が無効です".into());
    }
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .and_then(crate::document_identity::normalize_uuid)
        .ok_or("専用フォルダーの識別情報が無効です")?;
    Ok(Some(id))
}
fn opened(entry: &Entry) -> Result<(PathBuf, Arc<Dir>), String> {
    let (path, dir) = knowledge::open_root(&entry.path)?;
    if knowledge::storage_root_identity(&dir).map_err(|_| "StorageUnavailable")? != entry.identity {
        return Err("専用フォルダーの物理識別情報が一致しません".into());
    }
    if marker_for_dir(&path, &dir)?.as_deref() != Some(&entry.id) {
        return Err("専用フォルダーの識別情報が一致しません。再登録してください".into());
    }
    Ok((path, dir))
}
pub(crate) fn registered_paths(core: &Core) -> Result<Vec<PathBuf>, String> {
    Ok(load(core)?
        .0
        .folders
        .into_iter()
        .filter_map(|entry| opened(&entry).ok().map(|(path, _)| path))
        .collect())
}
fn list_locked(core: &Core) -> Result<ManagedFolders, String> {
    let (value, digest) = load(core)?;
    let folders = value
        .folders
        .into_iter()
        .map(|entry| {
            let check =
                opened(&entry).and_then(|(path, dir)| html_authoring::reconcile(path, dir, false));
            let (status, kit_update, error) = match check {
                Ok("current") => ("ready", "current", None),
                Ok(update) => (
                    "incomplete",
                    update,
                    Some("制作キットの更新または競合の確認が必要です".into()),
                ),
                Err(error) => (
                    if entry.path.exists() {
                        "incomplete"
                    } else {
                        "missing"
                    },
                    "blocked",
                    Some(error),
                ),
            };
            ManagedFolder {
                id: entry.id,
                name: entry.name,
                path: entry.path,
                status,
                kit_update,
                error,
            }
        })
        .collect();
    Ok(ManagedFolders {
        revision: digest.unwrap_or_else(|| "none".into()),
        folders,
        selected_id: value.selected_id,
    })
}
pub fn list(core: &Core) -> Result<ManagedFolders, String> {
    let _gate = core.gate.lock().unwrap();
    list_locked(core)
}

pub fn register(
    core: &Arc<Core>,
    path: &Path,
    name: Option<&str>,
    revision: &str,
) -> Result<ManagedFolders, String> {
    let _gate = core.gate.lock().unwrap();
    let (mut registry, digest) = expected(core, revision)?;
    let (path, dir) = if let Some(name) = name {
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err("新しいフォルダー名を確認してください".into());
        }
        knowledge::validate_relative(name)?;
        let (parent, original) = knowledge::open_root(path)?;
        let locked = write_fs::LockedDir::open(&original, "")?;
        locked.revalidate(&parent, &original)?;
        write_fs::mkdir(locked.dir(), name)
            .map_err(|_| "新しいフォルダーを作成できません。同名フォルダーは変更しません")?;
        knowledge::open_root(&parent.join(name))?
    } else {
        knowledge::open_root(path)?
    };
    if registry.folders.iter().any(|entry| entry.path == path) {
        return Err("このフォルダーは登録済みです".into());
    }
    let marker = marker_for_dir(&path, &dir)?;
    let id = marker
        .clone()
        .unwrap_or_else(crate::document_identity::new_uuid);
    let relocated = registry.folders.iter().position(|entry| entry.id == id);
    if relocated.is_some_and(|index| opened(&registry.folders[index]).is_ok()) {
        return Err("同じ専用フォルダーIDが登録されています".into());
    }
    if relocated.is_none() && registry.folders.len() >= 64 {
        return Err("専用フォルダーは64件まで登録できます".into());
    }
    // Preflight all fixed outputs before any write. Unowned user files block
    // setup rather than being adopted, replaced, or moved.
    if html_authoring::reconcile(path.clone(), dir.clone(), false)? == "blocked" {
        return Err(
            "制作キットの配置先に既存ファイルがあります。内容を保持して登録を中止しました".into(),
        );
    }
    if html_authoring::reconcile(path.clone(), dir.clone(), true)? != "current" {
        return Err("制作キットの準備が未完了です。既存内容を保持しました".into());
    }
    core.document_state
        .get()
        .ok_or("StorageUnavailable")?
        .verify_management()
        .map_err(|_| "StorageUnavailable")?;
    if marker.is_none() {
        html_authoring::install_managed_marker(
            path.clone(),
            dir.clone(),
            &serde_json::json!({"version":1,"kind":"mogledge-managed-folder","id":id}),
        )?;
    }
    let entry = Entry {
        id,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path,
        identity: knowledge::storage_root_identity(&dir).map_err(|_| "StorageUnavailable")?,
    };
    if let Some(index) = relocated {
        registry.folders[index] = entry;
    } else {
        registry.folders.push(entry);
    }
    profile_store::write(profile(core)?, FILE, digest.as_deref(), &registry).map_err(|error| {
        format!("専用フォルダーの資材配置後、一覧登録が未完了です。再登録できます。{error}")
    })?;
    list_locked(core)
}
pub fn select(core: &Arc<Core>, id: &str, revision: &str) -> Result<Snapshot, String> {
    let _gate = core.gate.lock().unwrap();
    let (mut registry, digest) = expected(core, revision)?;
    let entry = registry
        .folders
        .iter()
        .find(|entry| entry.id == id)
        .ok_or("登録が見つかりません")?;
    let (path, dir) = opened(entry)?;
    let _ = html_authoring::reconcile(path.clone(), dir, true)?;
    let previous = registry
        .selected_id
        .as_ref()
        .and_then(|id| registry.folders.iter().find(|entry| &entry.id == id))
        .and_then(|entry| opened(entry).ok().map(|(path, _)| path));
    let snapshot = core.select_locked(&path, true)?;
    registry.selected_id = Some(id.into());
    if let Err(error) = profile_store::write(profile(core)?, FILE, digest.as_deref(), &registry) {
        if let Some(path) = previous {
            let _ = core.select_locked(&path, true);
        } else {
            clear_locked(core);
        }
        return Err(format!(
            "選択の保存を完了できません。再確認してください。{error}"
        ));
    }
    Ok(snapshot)
}
pub fn unregister(core: &Arc<Core>, id: &str, revision: &str) -> Result<ManagedFolders, String> {
    let _gate = core.gate.lock().unwrap();
    let (mut registry, digest) = expected(core, revision)?;
    if !registry.folders.iter().any(|entry| entry.id == id) {
        return Err("登録が見つかりません".into());
    }
    registry.folders.retain(|entry| entry.id != id);
    let clear = registry.selected_id.as_deref() == Some(id);
    if clear {
        registry.selected_id = None;
        crate::workspace_settings::flush_locked(core)?;
    }
    profile_store::write(profile(core)?, FILE, digest.as_deref(), &registry)?;
    if clear {
        clear_locked(core);
    }
    list_locked(core)
}
fn clear_locked(core: &Core) {
    let mut state = core.workspace.lock().unwrap();
    state.root = None;
    state.dir = None;
    state.tabs.clear();
    state.snapshot = Snapshot {
        view_id: crate::core::random_token(),
        document_origin: core.origin.clone(),
        ..Default::default()
    };
    core.watcher.lock().unwrap().take();
}
pub(crate) fn restore(core: &Arc<Core>) -> Result<(), String> {
    let (registry, _) = load(core)?;
    if let Some(entry) = registry
        .folders
        .iter()
        .find(|entry| Some(&entry.id) == registry.selected_id.as_ref())
    {
        // Missing/moved/incomplete roots remain listed and never stop startup.
        if let Ok((path, dir)) = opened(entry) {
            let _ = html_authoring::reconcile(path.clone(), dir, true);
            let _ = core.select(&path, false);
        } else {
            let _gate = core.gate.lock().unwrap();
            core.restore_root_locked(crate::root_recovery::SavedRoot {
                path: entry.path.clone(),
                identity: Some(entry.identity.clone()),
                scheme: core
                    .persistent_storage_identity
                    .then(|| crate::storage_identity_transition::SCHEME.into()),
            });
        }
    }
    Ok(())
}
pub(crate) fn has_selected(core: &Core) -> Result<bool, String> {
    Ok(load(core)?.0.selected_id.is_some())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, Arc<Core>) {
        let roots = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let core = Core::new(19276);
        core.settings_path
            .set(profile.path().join("settings.json"))
            .unwrap();
        core.document_state
            .set(
                crate::document_state::DocumentState::new(profile.path().join("document-state"))
                    .unwrap(),
            )
            .ok()
            .unwrap();
        (roots, profile, core)
    }
    #[test]
    fn setup_registration_selection_unregister_and_missing_folder_preserve_user_material() {
        let (roots, _profile, core) = fixture();
        let first = register(&core, roots.path(), Some("新しい資料"), "none").unwrap();
        let path = roots.path().join("新しい資料");
        assert_eq!(first.folders.len(), 1);
        assert!(first.selected_id.is_none());
        let entry = &first.folders[0];
        assert_eq!(entry.status, "ready");
        for file in [
            ".mogledge/mogledge-folder.json",
            ".mogledge/html-authoring/GUIDE.md",
            ".mogledge/html-authoring/template.html",
            ".agents/skills/mogledge-html-authoring/SKILL.md",
            ".claude/skills/mogledge-html-authoring/SKILL.md",
        ] {
            assert!(path.join(file).is_file(), "{file}");
        }
        std::fs::write(path.join("user.html"), "user HTML").unwrap();
        let snapshot = select(&core, &entry.id, &first.revision).unwrap();
        assert!(snapshot.workspace_id.is_some());
        core.watcher.lock().unwrap().take();
        assert!(register(&core, roots.path(), Some("新しい資料"), &first.revision).is_err());
        let selected = list(&core).unwrap();
        let id = selected.folders[0].id.clone();
        let removed = unregister(&core, &id, &selected.revision).unwrap();
        assert!(removed.folders.is_empty());
        assert!(core.snapshot().workspace_id.is_none());
        assert_eq!(
            std::fs::read_to_string(path.join("user.html")).unwrap(),
            "user HTML"
        );
        assert!(core
            .document_state
            .get()
            .unwrap()
            .identity_schema_version()
            .is_ok());
        let added = register(&core, &path, None, &removed.revision).unwrap();
        select(&core, &id, &added.revision).unwrap();
        core.watcher.lock().unwrap().take();
        // Detach only runtime handles before an external move.
        {
            let mut state = core.workspace.lock().unwrap();
            state.root = None;
            state.dir = None;
            state.tabs.clear();
        }
        std::fs::rename(&path, roots.path().join("moved")).unwrap();
        restore(&core).unwrap();
        assert_eq!(list(&core).unwrap().folders[0].status, "missing");
    }
    #[test]
    fn preflight_conflict_and_stale_revision_do_not_modify_existing_instructions_or_html() {
        let (roots, _profile, core) = fixture();
        let path = roots.path().join("existing");
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir_all(path.join(".agents/skills/mogledge-html-authoring")).unwrap();
        for (leaf, value) in [
            ("AGENTS.md", "user agents"),
            ("CLAUDE.md", "user claude"),
            ("document.html", "user HTML"),
            (
                ".agents/skills/mogledge-html-authoring/SKILL.md",
                "custom skill",
            ),
        ] {
            std::fs::write(path.join(leaf), value).unwrap();
        }
        assert!(register(&core, &path, None, "none").is_err());
        assert!(!path.join(".mogledge").exists());
        assert_eq!(list(&core).unwrap().folders.len(), 0);
        assert!(register(&core, roots.path(), Some("stale"), "old revision").is_err());
        assert!(!roots.path().join("stale").exists());
        assert_eq!(
            std::fs::read_to_string(path.join("AGENTS.md")).unwrap(),
            "user agents"
        );
        assert_eq!(
            std::fs::read_to_string(path.join(".agents/skills/mogledge-html-authoring/SKILL.md"))
                .unwrap(),
            "custom skill"
        );
    }
    #[test]
    fn empty_registry_is_onboarding_while_missing_registered_folder_is_recovery() {
        let (roots, profile, core) = fixture();
        core.restore().unwrap();
        assert!(core.snapshot().startup_recovery.is_none());
        assert!(!profile.path().join(FILE).exists());
        let settings = serde_json::to_vec(&serde_json::json!({
            "knowledgeRoot": roots.path().join("legacy missing"), "keep":"user setting"
        }))
        .unwrap();
        std::fs::write(core.settings_path.get().unwrap(), &settings).unwrap();
        core.restore().unwrap();
        assert!(core.snapshot().startup_recovery.is_none());
        let folders = register(&core, roots.path(), Some("dedicated"), "none").unwrap();
        let id = folders.folders[0].id.clone();
        select(&core, &id, &folders.revision).unwrap();
        core.watcher.lock().unwrap().take();
        let selected = list(&core).unwrap();
        unregister(&core, &id, &selected.revision).unwrap();
        let retained = std::fs::read(core.settings_path.get().unwrap()).unwrap();
        core.restore().unwrap();
        assert!(core.snapshot().startup_recovery.is_none());
        assert!(core.snapshot().workspace_id.is_none());
        assert_eq!(
            std::fs::read(core.settings_path.get().unwrap()).unwrap(),
            retained
        );
        let folders = list(&core).unwrap();
        let added = register(
            &core,
            &roots.path().join("dedicated"),
            None,
            &folders.revision,
        )
        .unwrap();
        select(&core, &id, &added.revision).unwrap();
        let selected = list(&core).unwrap();
        clear_locked(&core);
        std::fs::rename(roots.path().join("dedicated"), roots.path().join("moved")).unwrap();
        core.restore().unwrap();
        assert!(core.snapshot().workspace_id.is_none());
        assert!(core.snapshot().startup_recovery.as_ref().unwrap().can_retry);
        assert_eq!(list(&core).unwrap().selected_id, selected.selected_id);
    }
    #[test]
    fn fresh_config_directory_can_list_without_writes_then_register() {
        let roots = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        let core = Core::new(19277);
        let config = profile.path().join("new-config");
        core.settings_path
            .set(config.join("settings.json"))
            .unwrap();
        core.document_state
            .set(
                crate::document_state::DocumentState::new(profile.path().join("document-state"))
                    .unwrap(),
            )
            .ok()
            .unwrap();
        assert_eq!(list(&core).unwrap().revision, "none");
        assert!(!config.exists());
        let folders = register(&core, roots.path(), Some("new folder"), "none").unwrap();
        assert_eq!(folders.folders.len(), 1);
        assert!(config.join(FILE).is_file());
        assert!(folders.selected_id.is_none());
        core.restore().unwrap();
        assert!(core.snapshot().workspace_id.is_none());
    }
}
