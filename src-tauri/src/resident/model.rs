//! Bounded device preferences and root-scoped HTML references; no document scan.
use crate::{core::Core, knowledge, workspace_settings::DocumentRef, write_fs};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
};

const NAME: &str = "resident.json";
const MAX_BYTES: usize = 16 * 1024;
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    #[default]
    Current,
    Pinned {
        root_identity: String,
        document: DocumentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub version: u8,
    pub enabled: bool,
    pub startup_enabled: bool,
    pub target: Target,
    #[serde(default)]
    pub shortcut: Shortcut,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Shortcut {
    #[default]
    Standard,
    Custom {
        control: bool,
        alt: bool,
        shift: bool,
        meta: bool,
        key: String,
    },
}
impl Shortcut {
    pub fn valid(&self) -> bool {
        match self {
            Self::Standard => true,
            Self::Custom {
                control,
                alt,
                meta,
                key,
                ..
            } => (*control || *alt || *meta) && valid_shortcut_key(key),
        }
    }
}
fn valid_shortcut_key(key: &str) -> bool {
    (key.len() == 4 && key.starts_with("Key") && key.as_bytes()[3].is_ascii_uppercase())
        || (key.len() == 6 && key.starts_with("Digit") && key.as_bytes()[5].is_ascii_digit())
        || key.strip_prefix('F').is_some_and(|number| {
            number
                .parse::<u8>()
                .is_ok_and(|value| (1..=24).contains(&value) && value.to_string() == number)
        })
        || matches!(
            key,
            "Space"
                | "Enter"
                | "Tab"
                | "Escape"
                | "Backspace"
                | "Delete"
                | "Insert"
                | "Home"
                | "End"
                | "PageUp"
                | "PageDown"
                | "ArrowLeft"
                | "ArrowRight"
                | "ArrowUp"
                | "ArrowDown"
        )
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: false,
            startup_enabled: false,
            target: Target::Current,
            shortcut: Shortcut::Standard,
        }
    }
}
fn valid_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
impl Preferences {
    pub(crate) fn valid(&self) -> bool {
        self.version == 1
            && self.shortcut.valid()
            && match &self.target {
                Target::Current => true,
                Target::Pinned {
                    root_identity,
                    document,
                } => {
                    valid_identity(root_identity)
                        && valid_identity(&document.identity)
                        && document.relative_path.len() <= 4096
                        && knowledge::validate_relative(&document.relative_path).is_ok()
                        && knowledge::is_html(&document.relative_path)
                }
            }
    }
}
pub struct Store {
    parent: PathBuf,
    original: Option<Vec<u8>>,
}
impl Store {
    pub fn load(core: &Core) -> Result<(Self, Preferences), String> {
        let parent = core
            .settings_path
            .get()
            .and_then(|path| path.parent())
            .ok_or("常駐設定の保存先が未初期化です")?
            .to_owned();
        let original = read(&parent)?;
        let preferences = match original.as_ref() {
            None => Preferences::default(),
            Some(bytes) => {
                let value: Preferences = serde_json::from_slice(bytes)
                    .map_err(|_| "常駐設定を読めません。保存内容を上書きせず保持します")?;
                if !value.valid() {
                    return Err("常駐設定が未対応または無効です。保存内容を保持します".into());
                }
                value
            }
        };
        Ok((Self { parent, original }, preferences))
    }
    pub fn save(&mut self, preferences: &Preferences) -> Result<(), String> {
        if !preferences.valid() {
            return Err("常駐設定が無効です".into());
        }
        if read(&self.parent)? != self.original {
            return Err("常駐設定が外部で変更されました。再起動して確認してください".into());
        }
        let bytes = serde_json::to_vec(preferences).map_err(|_| "常駐設定を保存できません")?;
        if bytes.len() > MAX_BYTES {
            return Err("常駐設定が上限を超えています".into());
        }
        if std::fs::symlink_metadata(&self.parent)
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            // First launch has no config leaf before knowledge selection. Create
            // only that leaf on explicit save, beneath a retained ordinary parent.
            let container = self.parent.parent().ok_or("常駐設定の保存先が無効です")?;
            let leaf = self
                .parent
                .file_name()
                .ok_or("常駐設定の保存先が無効です")?;
            let (root, dir) = knowledge::open_root(container)?;
            let guard = knowledge::RootReferenceGuard::open_profile_write(&root, &dir)?;
            guard.revalidate(&root, &dir)?;
            match std::fs::create_dir(root.join(leaf)) {
                Ok(()) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err("常駐設定の保存先を作れません".into()),
            }
            guard.revalidate(&root, &dir)?;
        }
        let (root, dir) = knowledge::open_root(&self.parent)?;
        let guard = knowledge::RootReferenceGuard::open_profile_write(&root, &dir)?;
        let (temporary, mut file) =
            write_fs::create_temporary(&dir).map_err(|_| "常駐設定の一時ファイルを作れません")?;
        let result = (|| {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "常駐設定を書き込めません")?;
            guard.revalidate(&root, &dir)?;
            if read(&self.parent)? != self.original {
                return Err("常駐設定が外部で変更されました".into());
            }
            write_fs::replace_resident_preferences(&dir, &temporary, &file)
                .map_err(|_| "常駐設定を保存できません")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = write_fs::remove_temporary(&dir, &temporary, &file);
        }
        if result.is_ok() {
            self.original = Some(bytes);
        }
        result
    }
}
fn read(parent: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    // An absent app-config directory is an unsaved default, not a corrupt store.
    // Links, access errors and existing non-directories still go through validation.
    if std::fs::symlink_metadata(parent)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return Ok(None);
    }
    let (_, dir) = knowledge::open_root(parent)?;
    let opened = crate::workspace_settings::read_file(&dir, NAME);
    let file = match opened {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("常駐設定を安全に読めません。保存内容を保持します".into()),
        Ok(file) => file,
    };
    let metadata = file.metadata().map_err(|_| "常駐設定を検証できません")?;
    if !metadata.is_file() || write_fs::rejected_link(&metadata) {
        return Err("常駐設定は通常ファイルではありません".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "常駐設定を読めません")?;
    if bytes.len() > MAX_BYTES {
        return Err("常駐設定が16KiBを超えています。原本を保持します".into());
    }
    Ok(Some(bytes))
}

fn contains_html(nodes: &[knowledge::TreeNode], path: &str) -> bool {
    nodes.iter().any(|node| {
        (node.kind == "html" && node.relative_path == path) || contains_html(&node.children, path)
    })
}

pub fn capture(
    core: &Core,
    workspace: &str,
    view: &str,
    revision: u64,
    path: &str,
) -> Result<Target, String> {
    let _gate = core.gate.lock().map_err(|_| "対象を確認できません")?;
    let state = core.workspace.lock().map_err(|_| "対象を確認できません")?;
    Core::check_view(&state, workspace, view)?;
    if state.snapshot.revision != revision || !contains_html(&state.snapshot.nodes, path) {
        return Err("対象HTMLが変更されました。再選択してください".into());
    }
    let root = state
        .root
        .as_ref()
        .ok_or("作業フォルダーを選択してください")?;
    let dir = state
        .dir
        .as_ref()
        .ok_or("作業フォルダーを選択してください")?;
    let (_, current) = knowledge::open_root(root)?;
    if !knowledge::same_directory(dir, &current)? {
        return Err("作業フォルダーが置き換えられました".into());
    }
    Ok(Target::Pinned {
        root_identity: knowledge::storage_root_identity(dir)
            .map_err(|_| "対象のルートを識別できません")?,
        document: DocumentRef {
            relative_path: path.into(),
            identity: knowledge::storage_identity(root, dir, path)
                .map_err(|_| "対象HTMLを識別できません")?,
        },
    })
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub workspace_id: Option<String>,
    pub view_id: String,
    pub revision: u64,
    pub document: Option<DocumentRef>,
    pub fallback: bool,
}
pub fn resolve(core: &Core, target: &Target, tab_id: Option<&str>) -> Selection {
    let _gate = core.gate.lock().unwrap();
    let snapshot = core.snapshot();
    let mut result = Selection {
        workspace_id: snapshot.workspace_id.clone(),
        view_id: snapshot.view_id.clone(),
        revision: snapshot.revision,
        document: None,
        fallback: false,
    };
    let Target::Pinned {
        root_identity,
        document,
    } = target
    else {
        return result;
    };
    result.fallback = true;
    if snapshot.workspace_id.is_none() {
        return result;
    }
    let state = core.workspace.lock().unwrap();
    let valid = (|| {
        let root = state.root.as_ref()?;
        let dir = state.dir.as_ref()?;
        let (_, current) = knowledge::open_root(root).ok()?;
        if !knowledge::same_directory(dir, &current).ok()?
            || knowledge::storage_root_identity(dir).ok().as_ref() != Some(root_identity)
            || !contains_html(&state.snapshot.nodes, &document.relative_path)
            || knowledge::storage_identity(root, dir, &document.relative_path)
                .ok()
                .as_ref()
                != Some(&document.identity)
        {
            return None;
        }
        if let Some(id) = tab_id {
            let tab = state.tabs.get(id)?;
            if tab.browser
                || tab.entry != document.relative_path
                || tab
                    .expected_identity
                    .as_ref()
                    .is_some_and(|identity| identity != &document.identity)
                || tab.session.as_ref().is_some_and(|session| {
                    session.storage_identity.as_ref() != Some(&document.identity)
                })
            {
                return None;
            }
        }
        Some(())
    })()
    .is_some();
    if valid {
        result.document = Some(document.clone());
        result.fallback = false;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Arc};
    fn fixture() -> (tempfile::TempDir, Arc<Core>) {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join("config")).unwrap();
        fs::create_dir(directory.path().join("knowledge")).unwrap();
        fs::write(directory.path().join("knowledge/a.html"), "<h1>a</h1>").unwrap();
        let core = Core::new(0);
        core.settings_path
            .set(directory.path().join("config/settings.json"))
            .unwrap();
        core.select(&directory.path().join("knowledge"), false)
            .unwrap();
        (directory, core)
    }
    #[test]
    fn defaults_off_without_writing_and_roundtrips_explicit_preferences() {
        let (directory, core) = fixture();
        let (mut store, preferences) = Store::load(&core).unwrap();
        assert!(!preferences.enabled && !preferences.startup_enabled);
        assert_eq!(preferences.target, Target::Current);
        assert!(!directory.path().join("config/resident.json").exists());
        let preferences = Preferences {
            enabled: true,
            ..preferences
        };
        store.save(&preferences).unwrap();
        assert_eq!(Store::load(&core).unwrap().1, preferences);
    }
    #[test]
    fn first_launch_can_enable_without_a_config_directory_or_knowledge_selection() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("config");
        let core = Core::new(0);
        core.settings_path
            .set(parent.join("settings.json"))
            .unwrap();
        let (mut store, mut preferences) = Store::load(&core).unwrap();
        assert!(
            !parent.exists(),
            "reading defaults must not create a profile"
        );
        assert!(!preferences.enabled);
        preferences.enabled = true;
        store.save(&preferences).unwrap();
        assert_eq!(Store::load(&core).unwrap().1, preferences);
        assert!(!parent.join("settings.json").exists());
        assert!(core.workspace.lock().unwrap().root.is_none());
    }
    #[test]
    fn successive_toggles_and_restart_restore_latest_preferences() {
        let (_directory, core) = fixture();
        let (mut store, mut preferences) = Store::load(&core).unwrap();
        for enabled in [true, false, true, false] {
            preferences.enabled = enabled;
            store.save(&preferences).unwrap();
            let (restarted, restored) = Store::load(&core).unwrap();
            assert_eq!(restored, preferences);
            store = restarted;
        }
    }
    #[test]
    fn existing_preferences_default_to_standard_and_custom_restores_after_restart() {
        let (directory, core) = fixture();
        fs::write(
            directory.path().join("config/resident.json"),
            br#"{"version":1,"enabled":true,"startupEnabled":false,"target":{"kind":"current"}}"#,
        )
        .unwrap();
        let (mut store, mut preferences) = Store::load(&core).unwrap();
        assert_eq!(preferences.shortcut, Shortcut::Standard);
        preferences.shortcut = Shortcut::Custom {
            control: true,
            alt: true,
            shift: false,
            meta: false,
            key: "KeyM".into(),
        };
        store.save(&preferences).unwrap();
        assert_eq!(Store::load(&core).unwrap().1, preferences);
        preferences.shortcut = Shortcut::Standard;
        store.save(&preferences).unwrap();
        assert_eq!(Store::load(&core).unwrap().1.shortcut, Shortcut::Standard);
    }
    #[test]
    fn shortcut_validation_rejects_typing_and_unbounded_or_modifier_keys() {
        let (directory, core) = fixture();
        let (mut store, mut preferences) = Store::load(&core).unwrap();
        for key in ["KeyA", "Digit0", "F1", "F24", "ArrowLeft", "Space"] {
            let shortcut = Shortcut::Custom {
                control: true,
                alt: false,
                shift: false,
                meta: false,
                key: key.into(),
            };
            assert!(shortcut.valid(), "{key}");
        }
        for (control, key) in [
            (false, "KeyM"),
            (true, "ControlLeft"),
            (true, "F0"),
            (true, "F25"),
            (true, "F01"),
            (true, "keyA"),
            (true, "KeyAB"),
            (true, "Digit00"),
            (true, "Ctrl+M"),
            (true, ""),
        ] {
            preferences.shortcut = Shortcut::Custom {
                control,
                alt: false,
                shift: true,
                meta: false,
                key: key.into(),
            };
            assert!(!preferences.shortcut.valid(), "{control}/{key}");
            assert!(store.save(&preferences).is_err());
        }
        assert!(!directory.path().join("config/resident.json").exists());
    }
    #[cfg(windows)]
    #[test]
    fn blocked_replacement_preserves_original_and_can_retry_after_unlock() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let (directory, core) = fixture();
        let (mut store, mut preferences) = Store::load(&core).unwrap();
        preferences.enabled = true;
        store.save(&preferences).unwrap();
        let path = directory.path().join("config/resident.json");
        let original = fs::read(&path).unwrap();
        // Allow the original-value check, but deny deletion/replacement at publication.
        let blocking = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .open(&path)
            .unwrap();
        preferences.enabled = false;
        assert!(store.save(&preferences).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(Store::load(&core).unwrap().1.enabled);
        assert!(!fs::read_dir(path.parent().unwrap()).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".mogledge-")
        }));
        drop(blocking);
        store.save(&preferences).unwrap();
        assert!(!Store::load(&core).unwrap().1.enabled);
    }
    #[test]
    fn malformed_future_external_change_and_oversized_files_are_preserved() {
        let (directory, core) = fixture();
        let path = directory.path().join("config/resident.json");
        let (mut store, preferences) = Store::load(&core).unwrap();
        fs::write(&path, "{broken").unwrap();
        assert!(store.save(&preferences).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        assert!(Store::load(&core).is_err());
        fs::write(
            &path,
            br#"{"version":2,"enabled":false,"startupEnabled":false,"target":{"kind":"current"}}"#,
        )
        .unwrap();
        assert!(Store::load(&core).is_err());
        fs::write(&path, vec![b' '; MAX_BYTES + 1]).unwrap();
        assert!(Store::load(&core).is_err());
        assert_eq!(fs::metadata(&path).unwrap().len(), (MAX_BYTES + 1) as u64);
    }
    #[test]
    fn pinned_target_is_not_required_to_be_a_favorite_and_never_switches_roots() {
        let (directory, core) = fixture();
        let snapshot = core.snapshot();
        let target = capture(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            snapshot.revision,
            "a.html",
        )
        .unwrap();
        let resolved = resolve(&core, &target, None);
        assert!(!resolved.fallback);
        assert_eq!(resolved.document.unwrap().relative_path, "a.html");
        fs::create_dir(directory.path().join("other")).unwrap();
        fs::write(directory.path().join("other/a.html"), "other").unwrap();
        core.select(&directory.path().join("other"), false).unwrap();
        assert!(resolve(&core, &target, None).fallback);
        assert!(resolve(&core, &target, None).document.is_none());
        assert!(capture(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            snapshot.revision,
            "a.html"
        )
        .is_err());
    }
    #[test]
    fn removed_replaced_or_moved_target_falls_back_and_invalid_paths_are_rejected() {
        let (directory, core) = fixture();
        let snapshot = core.snapshot();
        for path in ["../outside.html", "a.txt", "missing.html"] {
            assert!(capture(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                snapshot.revision,
                path
            )
            .is_err());
        }
        let target = capture(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            snapshot.revision,
            "a.html",
        )
        .unwrap();
        fs::rename(
            directory.path().join("knowledge/a.html"),
            directory.path().join("knowledge/moved.html"),
        )
        .unwrap();
        assert!(resolve(&core, &target, None).fallback);
        fs::write(directory.path().join("knowledge/a.html"), "replacement").unwrap();
        assert!(resolve(&core, &target, None).fallback);
        assert!(resolve(&core, &target, Some("forged-tab"))
            .document
            .is_none());
    }
    #[cfg(unix)]
    #[test]
    fn linked_preferences_and_target_cannot_redirect_access() {
        use std::os::unix::fs::symlink;
        let (directory, core) = fixture();
        fs::write(directory.path().join("outside.json"), "original").unwrap();
        symlink(
            directory.path().join("outside.json"),
            directory.path().join("config/resident.json"),
        )
        .unwrap();
        assert!(Store::load(&core).is_err());
        assert_eq!(
            fs::read(directory.path().join("outside.json")).unwrap(),
            b"original"
        );
        fs::remove_file(directory.path().join("knowledge/a.html")).unwrap();
        symlink(
            directory.path().join("outside.json"),
            directory.path().join("knowledge/a.html"),
        )
        .unwrap();
        let snapshot = core.snapshot();
        assert!(capture(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            snapshot.revision,
            "a.html"
        )
        .is_err());
    }
}
