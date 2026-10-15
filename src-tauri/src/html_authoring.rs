//! Ownership-aware bundled authoring outputs and recoverable dedicated-folder setup.
use crate::{
    core::Core,
    knowledge,
    write_fs::{self, LockedDir},
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Write},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const VERSION: u8 = 2;
const LIMIT: usize = 512 * 1024;
const PREF_LIMIT: usize = 64 * 1024;
const MANIFEST: &str = ".my-knowledge/html-authoring/manifest.json";
const GUIDE: &str = ".my-knowledge/html-authoring/GUIDE.md";
const CONTENTS: [(&str, &[u8]); 4] = [
    (GUIDE, include_bytes!("../html-authoring-kit/guide.md")),
    (
        ".my-knowledge/html-authoring/template.html",
        include_bytes!("../html-authoring-kit/template.html"),
    ),
    (
        ".agents/skills/my-knowledge-html-authoring/SKILL.md",
        include_bytes!("../html-authoring-kit/codex-skill.md"),
    ),
    (
        ".claude/skills/my-knowledge-html-authoring/SKILL.md",
        include_bytes!("../html-authoring-kit/claude-skill.md"),
    ),
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub workspace_id: String,
    pub view_id: String,
    pub revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root_identity: String,
    pub enabled: bool,
    pub preference_hash: Option<String>,
    pub read_only: bool,
    pub guide_available: bool,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub action: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub plan_id: String,
    pub kit_version: u8,
    pub files: Vec<FilePreview>,
    pub read_only: bool,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedFile {
    path: String,
    hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u8,
    owner: String,
    root_identity: String,
    files: Vec<OwnedFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preference {
    version: u8,
    root_identity: String,
    enabled: bool,
}

pub(crate) struct Plan {
    id: String,
    context: Context,
    root_identity: String,
    captured: Vec<Option<String>>,
    manifest_hash: Option<String>,
    rows: Vec<FilePreview>,
    owned: Vec<OwnedFile>,
    created: Instant,
    read_only: bool,
}
struct Root {
    path: PathBuf,
    original: Arc<Dir>,
    locked: LockedDir,
    identity: String,
}
impl Root {
    fn current(core: &Core, context: &Context) -> Result<Self, String> {
        let (path, original) = {
            let state = core.workspace.lock().unwrap();
            if state.snapshot.workspace_id.as_deref() != Some(&context.workspace_id) {
                return Err("WorkspaceChanged".into());
            }
            if state.snapshot.view_id != context.view_id {
                return Err("ViewChanged".into());
            }
            if state.snapshot.revision != context.revision {
                return Err("対象が変更されました。確認画面を開き直してください".into());
            }
            (
                state.root.clone().ok_or("WorkspaceChanged")?,
                state.dir.clone().ok_or("WorkspaceChanged")?,
            )
        };
        Self::open(path, original)
    }
    fn open(path: PathBuf, original: Arc<Dir>) -> Result<Self, String> {
        let locked = LockedDir::open(&original, "")?;
        locked.revalidate(&path, &original)?;
        let identity = knowledge::storage_root_identity(locked.dir())
            .map_err(|_| "フォルダーの識別情報を取得できません")?;
        Ok(Self {
            path,
            original,
            locked,
            identity,
        })
    }
    fn revalidate(&self) -> Result<(), String> {
        self.locked.revalidate(&self.path, &self.original)
    }
}
// Retain all ordinary directory handles, including the reserved dot directories.
// No caller-selected hidden path reaches this traversal or its creation helper.
struct Chain {
    components: Vec<String>,
    dirs: Vec<Dir>,
}
impl Chain {
    fn open(root: &Root, path: &str, create: bool) -> Result<Option<Self>, String> {
        let components = parts(path)?;
        let mut dirs = vec![root
            .locked
            .dir()
            .try_clone()
            .map_err(|_| "フォルダーを保持できません")?];
        for part in &components {
            let parent = dirs.last().unwrap();
            let file = match write_fs::open_subtree_entry(parent, part, true) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound && !create => {
                    return Ok(None)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    match write_fs::mkdir_internal(parent, part) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(_) => return Err("制作キットのフォルダーを作成できません".into()),
                    }
                    write_fs::open_subtree_entry(parent, part, true)
                        .map_err(|_| "制作キットのフォルダーを確認できません")?
                }
                Err(_) => {
                    return Err(
                        "制作キットのフォルダーは通常のローカルフォルダーである必要があります"
                            .into(),
                    )
                }
            };
            dirs.push(Dir::from_std_file(file));
        }
        Ok(Some(Self { components, dirs }))
    }
    fn dir(&self) -> &Dir {
        self.dirs.last().unwrap()
    }
    fn revalidate(&self, root: &Root) -> Result<(), String> {
        root.revalidate()?;
        let fresh = Self::open(root, &self.components.join("/"), false)?
            .ok_or("制作キットのフォルダーが変更されました")?;
        if self.dirs.len() != fresh.dirs.len() {
            return Err("制作キットのフォルダーが変更されました".into());
        }
        for (old, new) in self.dirs.iter().zip(&fresh.dirs) {
            if !knowledge::same_directory(old, new)? {
                return Err("制作キットのフォルダーが変更されました".into());
            }
        }
        Ok(())
    }
}
fn parts(path: &str) -> Result<Vec<String>, String> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']))
    {
        return Err("制作キットの固定パスが無効です".into());
    }
    Ok(path.split('/').map(str::to_owned).collect())
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn parent_leaf(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}
fn read(root: &Root, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let (parent, leaf) = parent_leaf(path);
    let Some(chain) = Chain::open(root, parent, false)? else {
        return Ok(None);
    };
    let bytes = match write_fs::read_regular(chain.dir(), leaf, limit) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => {
            return Err("制作キットのファイルを安全に読み取れません。元の内容を保持します".into())
        }
    };
    chain.revalidate(root)?;
    Ok(bytes)
}
fn manifest(root: &Root) -> Result<(Option<Manifest>, Option<String>), String> {
    let Some(bytes) = read(root, MANIFEST, PREF_LIMIT)? else {
        return Ok((None, None));
    };
    let value: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| "制作キットの所有記録を読み取れません。元の内容を保持します")?;
    let mut seen = std::collections::HashSet::new();
    if !(1..=VERSION).contains(&value.version)
        || value.owner != "my-knowledge-html-authoring-kit"
        || value.root_identity != root.identity
        || value.files.len() > CONTENTS.len()
        || value.files.iter().any(|entry| {
            !CONTENTS.iter().any(|(path, _)| *path == entry.path)
                || !valid_hash(&entry.hash)
                || !seen.insert(&entry.path)
        })
    {
        return Err(
            "制作キットの所有記録は未対応または別のフォルダー用です。元の内容を保持します".into(),
        );
    }
    Ok((Some(value), Some(hash(&bytes))))
}
fn guide_available(root: &Root, owner: Option<&Manifest>) -> Result<bool, String> {
    let expected = hash(CONTENTS[0].1);
    if !owner.is_some_and(|value| value.files.iter().any(|file| file.path == GUIDE)) {
        return Ok(false);
    }
    Ok(read(root, GUIDE, LIMIT)?.is_some_and(|bytes| hash(&bytes) == expected))
}
fn profile(core: &Core, create: bool) -> Result<Option<(Root, Chain)>, String> {
    let Some(parent) = core.settings_path.get().and_then(|path| path.parent()) else {
        return Ok(None);
    };
    let (path, dir) = knowledge::open_root(parent)?;
    let root = Root::open(path, dir)?;
    let Some(chain) = Chain::open(&root, "html-authoring-settings", create)? else {
        return Ok(None);
    };
    Ok(Some((root, chain)))
}
fn preference(core: &Core, identity: &str) -> Result<(bool, Option<String>), String> {
    let Some((root, chain)) = profile(core, false)? else {
        return Ok((false, None));
    };
    let bytes = match write_fs::read_regular(chain.dir(), &format!("{identity}.json"), PREF_LIMIT) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((false, None)),
        Err(_) => return Err("制作ガイド設定を安全に読み取れません。元の設定を保持します".into()),
    };
    let value: Preference = serde_json::from_slice(&bytes)
        .map_err(|_| "制作ガイド設定が未対応または破損しています。元の設定を保持します")?;
    if !(1..=VERSION).contains(&value.version) || value.root_identity != identity {
        return Err("制作ガイド設定が未対応または別のフォルダー用です".into());
    }
    chain.revalidate(&root)?;
    Ok((value.enabled, Some(hash(&bytes))))
}
fn status_locked(core: &Core, root: &Root) -> Status {
    let prefs = preference(core, &root.identity);
    let kit = manifest(root).and_then(|(owner, _)| guide_available(root, owner.as_ref()));
    let read_only = prefs.is_err();
    let error = prefs.as_ref().err().or_else(|| kit.as_ref().err()).cloned();
    Status {
        root_identity: root.identity.clone(),
        enabled: prefs.as_ref().map(|value| value.0).unwrap_or(false),
        preference_hash: prefs.ok().and_then(|value| value.1),
        read_only,
        guide_available: kit.unwrap_or(false),
        error,
    }
}
pub fn get_status(core: &Core, context: &Context) -> Result<Status, String> {
    let _gate = core.gate.lock().unwrap();
    let root = Root::current(core, context)?;
    Ok(status_locked(core, &root))
}
pub fn preview(core: &Core, context: &Context) -> Result<Preview, String> {
    let _gate = core.gate.lock().unwrap();
    let root = Root::current(core, context)?;
    let (owner, manifest_hash, error) = match manifest(&root) {
        Ok((owner, digest)) => (owner, digest, None),
        Err(error) => (None, None, Some(error)),
    };
    let mut captured = Vec::new();
    let mut rows = Vec::new();
    let mut owned = Vec::new();
    let mut failure = error;
    for (path, bytes) in CONTENTS {
        let expected = hash(bytes);
        let current = match read(&root, path, LIMIT) {
            Ok(bytes) => bytes.map(|bytes| hash(&bytes)),
            Err(error) => {
                failure.get_or_insert(error);
                Some("unreadable".into())
            }
        };
        let previously_owned = owner
            .as_ref()
            .and_then(|value| value.files.iter().find(|file| file.path == path));
        let action = if current.is_none()
            && (owner.is_none() || previously_owned.is_some_and(|entry| entry.hash == expected))
        {
            "create"
        } else if current.as_ref() == Some(&expected)
            && previously_owned.is_some_and(|entry| entry.hash == expected)
        {
            "current"
        } else {
            "conflict"
        };
        if action == "create" || action == "current" {
            owned.push(OwnedFile {
                path: path.into(),
                hash: expected,
            });
        }
        captured.push(current);
        rows.push(FilePreview {
            path: path.into(),
            action,
        });
    }
    rows.push(FilePreview {
        path: MANIFEST.into(),
        action: if owner.is_some() { "current" } else { "create" },
    });
    let id = crate::core::random_token();
    let read_only = failure.is_some();
    *core.html_authoring_plan.lock().unwrap() = Some(Plan {
        id: id.clone(),
        context: context.clone(),
        root_identity: root.identity.clone(),
        captured,
        manifest_hash,
        rows: rows.clone(),
        owned,
        created: Instant::now(),
        read_only,
    });
    Ok(Preview {
        plan_id: id,
        kit_version: VERSION,
        files: rows,
        read_only,
        error: failure,
    })
}
pub fn cancel(core: &Core, context: &Context, id: &str) {
    let mut pending = core.html_authoring_plan.lock().unwrap();
    if pending
        .as_ref()
        .is_some_and(|plan| plan.id == id && plan.context == *context)
    {
        *pending = None;
    }
}
fn write_new(root: &Root, path: &str, bytes: &[u8]) -> Result<(), String> {
    let (parent, leaf) = parent_leaf(path);
    let chain = Chain::open(root, parent, true)?.ok_or("制作キットの保存先を確認できません")?;
    let (temporary, mut file) =
        write_fs::create_temporary(chain.dir()).map_err(|_| "制作キットを保存できません")?;
    let result: Result<(), String> = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "制作キットを保存できません。元の内容は保持します")?;
        chain.revalidate(root)?;
        write_fs::rename_noreplace(chain.dir(), &temporary, chain.dir(), leaf, &file).map_err(
            |_| {
                "制作キットの保存先が変更されたか、書き込めません。既存の内容は保持します"
                    .to_owned()
            },
        )
    })();
    if result.is_err() {
        let _ = write_fs::remove_temporary(chain.dir(), &temporary, &file);
    }
    result
}

fn replace_owned(root: &Root, path: &str, bytes: &[u8], expected: &str) -> Result<(), String> {
    let (parent, leaf) = parent_leaf(path);
    let chain = Chain::open(root, parent, false)?.ok_or("制作キットの保存先がありません")?;
    let (temporary, mut file) =
        write_fs::create_temporary(chain.dir()).map_err(|_| "制作キットを保存できません")?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "制作キットを保存できません")?;
        chain.revalidate(root)?;
        write_fs::replace_checked(chain.dir(), &temporary, &file, leaf, Some(expected), LIMIT)
            .map_err(|_| {
                "制作キットが変更されたか書き込めません。退避した旧版を保持します".to_owned()
            })
    })();
    if result.is_err() {
        let _ = write_fs::remove_temporary(chain.dir(), &temporary, &file);
    }
    result
}

/// Inspect without mutation, or reconcile only app-owned unmodified files. The
/// old manifest and every replaced byte stream survive in a unique backup.
pub(crate) fn reconcile(
    path: PathBuf,
    dir: Arc<Dir>,
    update: bool,
) -> Result<&'static str, String> {
    let root = Root::open(path, dir)?;
    let (owner, manifest_hash) = manifest(&root)?;
    let mut previous = Vec::new();
    let mut conflicts = Vec::new();
    let mut changed = false;
    for (path, bytes) in CONTENTS {
        let current = read(&root, path, LIMIT)?;
        let conflict = current.as_ref().is_some_and(|data| {
            !owner.as_ref().is_some_and(|value| {
                value
                    .files
                    .iter()
                    .any(|file| file.path == path && file.hash == hash(data))
            })
        });
        changed |= !conflict && current.as_deref() != Some(bytes);
        conflicts.push(conflict);
        previous.push(current);
    }
    let blocked = conflicts.iter().any(|blocked| *blocked);
    if blocked && (owner.is_none() || !update) {
        return Ok("blocked");
    }
    changed |= !blocked
        && owner
            .as_ref()
            .is_none_or(|value| value.version != VERSION || value.files.len() != CONTENTS.len());
    if !changed {
        return Ok(if blocked { "blocked" } else { "current" });
    }
    if !update {
        return Ok("available");
    }
    let next = Manifest {
        version: if blocked {
            owner.as_ref().unwrap().version
        } else {
            VERSION
        },
        owner: "my-knowledge-html-authoring-kit".into(),
        root_identity: root.identity.clone(),
        files: CONTENTS
            .iter()
            .zip(&conflicts)
            .filter_map(|((path, bytes), conflict)| {
                if *conflict {
                    owner
                        .as_ref()
                        .and_then(|value| value.files.iter().find(|file| file.path == *path))
                        .cloned()
                } else {
                    Some(OwnedFile {
                        path: (*path).into(),
                        hash: hash(bytes),
                    })
                }
            })
            .collect(),
    };
    let manifest_bytes =
        serde_json::to_vec_pretty(&next).map_err(|_| "所有記録を作成できません")?;
    let backup = format!(
        ".my-knowledge/html-authoring/backups/{}",
        crate::core::random_token()
    );
    if let Some(bytes) = read(&root, MANIFEST, PREF_LIMIT)? {
        write_new(&root, &format!("{backup}/manifest.json"), &bytes)?;
    }
    for ((path, _), old) in CONTENTS.iter().zip(&previous) {
        if let Some(bytes) = old {
            write_new(&root, &format!("{backup}/{path}"), bytes)?;
        }
    }
    // Initial ownership is published before outputs so an interrupted first
    // setup can safely resume only its fixed planned paths.
    if owner.is_none() {
        write_new(&root, MANIFEST, &manifest_bytes)?;
    }
    let mut written = Vec::new();
    let result: Result<(), String> = (|| {
        for (index, ((path, bytes), old)) in CONTENTS.iter().zip(&previous).enumerate() {
            if conflicts[index] || old.as_deref() == Some(*bytes) {
                continue;
            }
            match old {
                Some(data) => replace_owned(&root, path, bytes, &hash(data))?,
                None => write_new(&root, path, bytes)?,
            }
            written.push(index);
        }
        for ((path, bytes), conflict) in CONTENTS.iter().zip(&conflicts) {
            if !conflict && read(&root, path, LIMIT)?.as_deref() != Some(*bytes) {
                return Err("制作キットの検証に失敗しました".into());
            }
        }
        if let Some(expected) = &manifest_hash {
            replace_owned(&root, MANIFEST, &manifest_bytes, expected)?;
        }
        Ok(())
    })();
    if result.is_err() {
        // Never roll back an intervening edit. The durable backup remains even
        // if a locked destination also prevents this best-effort rollback.
        for index in written.into_iter().rev() {
            if let Some(old) = &previous[index] {
                let _ = replace_owned(&root, CONTENTS[index].0, old, &hash(CONTENTS[index].1));
            }
        }
    }
    result?;
    Ok(if blocked { "blocked" } else { "current" })
}

pub(crate) fn managed_marker(
    path: PathBuf,
    dir: Arc<Dir>,
) -> Result<Option<serde_json::Value>, String> {
    let root = Root::open(path, dir)?;
    read(&root, ".my-knowledge/mogledge-folder.json", PREF_LIMIT)?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|_| "専用フォルダーの識別情報が壊れています".into())
        })
        .transpose()
}
pub(crate) fn install_managed_marker(
    path: PathBuf,
    dir: Arc<Dir>,
    value: &serde_json::Value,
) -> Result<(), String> {
    let root = Root::open(path, dir)?;
    write_new(
        &root,
        ".my-knowledge/mogledge-folder.json",
        &serde_json::to_vec_pretty(value).map_err(|_| "識別情報を作成できません")?,
    )
}
pub fn install(core: &Core, context: &Context, id: &str) -> Result<Installed, String> {
    install_before_file(core, context, id, |_| {})
}
fn install_before_file(
    core: &Core,
    context: &Context,
    id: &str,
    mut before_file: impl FnMut(usize),
) -> Result<Installed, String> {
    let _gate = core.gate.lock().unwrap();
    let root = Root::current(core, context)?;
    let plan = {
        let mut pending = core.html_authoring_plan.lock().unwrap();
        if !pending
            .as_ref()
            .is_some_and(|plan| plan.id == id && plan.context == *context)
        {
            return Err("配置確認が失効しました。もう一度確認してください".into());
        }
        pending.take().unwrap()
    };
    if plan.read_only
        || plan.created.elapsed() > Duration::from_secs(300)
        || plan.root_identity != root.identity
    {
        return Err("配置確認が失効したか、読み取り専用です。もう一度確認してください".into());
    }
    if manifest(&root)?.1 != plan.manifest_hash {
        return Err("制作キットの所有記録が変更されました。上書きしません".into());
    }
    for ((path, _), expected) in CONTENTS.iter().zip(&plan.captured) {
        if read(&root, path, LIMIT)?.as_deref().map(hash) != *expected {
            return Err("配置先が確認後に変更されました。上書きしません".into());
        }
    }
    let mut result = Installed {
        written: Vec::new(),
        skipped: plan
            .rows
            .iter()
            .filter(|row| row.action != "create")
            .map(|row| row.path.clone())
            .collect(),
        error: None,
    };
    // Claim only previewed new outputs before creating them. A partial failure
    // retains the immutable ownership record and can safely fill missing files.
    if plan.manifest_hash.is_none() {
        let manifest = Manifest {
            version: VERSION,
            owner: "my-knowledge-html-authoring-kit".into(),
            root_identity: root.identity.clone(),
            files: plan.owned,
        };
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| "所有記録を作成できません")?;
        write_new(&root, MANIFEST, &bytes)?;
        result.written.push(MANIFEST.into());
    }
    for (index, ((path, bytes), row)) in CONTENTS.iter().zip(&plan.rows).enumerate() {
        if row.action != "create" {
            continue;
        }
        before_file(index);
        if let Err(error) = write_new(&root, path, bytes) {
            result.error = Some(error);
            break;
        }
        result.written.push((*path).into());
    }
    for row in &plan.rows {
        if !result.written.contains(&row.path) && !result.skipped.contains(&row.path) {
            result.skipped.push(row.path.clone());
        }
    }
    Ok(result)
}
pub fn set_enabled(
    core: &Core,
    context: &Context,
    expected: Option<&str>,
    enabled: bool,
) -> Result<Status, String> {
    let _gate = core.gate.lock().unwrap();
    let root = Root::current(core, context)?;
    let (_, current) = preference(core, &root.identity)?;
    if current.as_deref() != expected {
        return Err("制作ガイド設定が外部で変更されました。上書きしません".into());
    }
    if enabled {
        let (owner, _) = manifest(&root)?;
        if !guide_available(&root, owner.as_ref())? {
            return Err("制作ガイドを配置し、変更されていないことを確認してください".into());
        }
    }
    let (profile, chain) = profile(core, true)?.ok_or("制作ガイド設定の保存先が未初期化です")?;
    let leaf = format!("{}.json", root.identity);
    let data = serde_json::to_vec(&Preference {
        version: VERSION,
        root_identity: root.identity.clone(),
        enabled,
    })
    .map_err(|_| "制作ガイド設定を作成できません")?;
    let (temporary, mut file) =
        write_fs::create_temporary(chain.dir()).map_err(|_| "制作ガイド設定を保存できません")?;
    let result: Result<(), String> = (|| {
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "制作ガイド設定を保存できません")?;
        root.revalidate()?;
        chain.revalidate(&profile)?;
        let now = match write_fs::read_regular(chain.dir(), &leaf, PREF_LIMIT) {
            Ok(bytes) => Some(hash(&bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(_) => return Err("制作ガイド設定を検証できません".into()),
        };
        if now != current {
            return Err("制作ガイド設定が外部で変更されました。上書きしません".into());
        }
        if current.is_none() {
            write_fs::rename_noreplace(chain.dir(), &temporary, chain.dir(), &leaf, &file)
                .map_err(|_| "制作ガイド設定を保存できません")?;
        } else {
            drop(file);
            chain
                .dir()
                .rename(&temporary, chain.dir(), &leaf)
                .map_err(|_| "制作ガイド設定を保存できません")?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = chain.dir().remove_file(&temporary);
    }
    result?;
    Ok(status_locked(core, &root))
}
// Called only inside the existing AI handoff gate. Managed folders always attach
// the latest verified guide, including an otherwise empty folder prompt.
pub(crate) fn guide_instruction_locked(
    core: &Core,
    workspace: &str,
    view: &str,
    relative_cwd: &str,
) -> Result<Option<String>, String> {
    let (revision, dir) = {
        let state = core.workspace.lock().unwrap();
        if state.snapshot.workspace_id.as_deref() != Some(workspace)
            || state.snapshot.view_id != view
        {
            return Err("WorkspaceChanged".into());
        }
        (
            state.snapshot.revision,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    // An unset preference must preserve read-only AI handoff paths, including
    // resident cloud roots. Ordinary write-directory guards are needed only ON.
    let managed = crate::managed_folders::marker_for_dir(&state_root(core)?, &dir)?.is_some();
    if !managed && profile(core, false)?.is_none() {
        return Ok(None);
    }
    #[cfg(windows)]
    let Ok(_metadata_scope) = knowledge::local_metadata_scope() else {
        return Ok(None);
    };
    // A root without persistent storage identity cannot enable this feature.
    // Its existing path-only AI handoff remains available with guidance OFF.
    let Ok(identity) = knowledge::storage_root_identity(&dir) else {
        return Ok(None);
    };
    if !managed && !preference(core, &identity)?.0 {
        return Ok(None);
    }
    let root = Root::current(
        core,
        &Context {
            workspace_id: workspace.into(),
            view_id: view.into(),
            revision,
        },
    )?;
    if managed {
        let _ = reconcile(root.path.clone(), root.original.clone(), true)?;
    }
    let (owner, _) = manifest(&root)?;
    if !guide_available(&root, owner.as_ref())? {
        return Err("最新版の制作ガイドが未配置または変更されています。編集内容を保持して、設定から制作キットを確認してください".into());
    }
    let prefix = "../".repeat(
        relative_cwd
            .split('/')
            .filter(|part| !part.is_empty())
            .count(),
    );
    Ok(Some(format!("Before creating or changing HTML, read `{prefix}{GUIDE}` and follow its storage API and safe restoration instructions.")))
}

fn state_root(core: &Core) -> Result<PathBuf, String> {
    core.workspace
        .lock()
        .unwrap()
        .root
        .clone()
        .ok_or_else(|| "WorkspaceChanged".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn old_kit(f: &Fixture) -> Vec<Vec<u8>> {
        reconcile(
            f.root.path().to_path_buf(),
            crate::knowledge::open_root(f.root.path()).unwrap().1,
            true,
        )
        .unwrap();
        let previous: Vec<_> = CONTENTS
            .iter()
            .enumerate()
            .map(|(i, _)| format!("old kit {i}").into_bytes())
            .collect();
        let root = Root::open(
            crate::knowledge::open_root(f.root.path()).unwrap().0,
            crate::knowledge::open_root(f.root.path()).unwrap().1,
        )
        .unwrap();
        let manifest = Manifest {
            version: 1,
            owner: "my-knowledge-html-authoring-kit".into(),
            root_identity: root.identity,
            files: CONTENTS
                .iter()
                .zip(&previous)
                .map(|((path, _), bytes)| OwnedFile {
                    path: (*path).into(),
                    hash: hash(bytes),
                })
                .collect(),
        };
        for ((path, _), bytes) in CONTENTS.iter().zip(&previous) {
            fs::write(f.root.path().join(path), bytes).unwrap();
        }
        fs::write(
            f.root.path().join(MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        previous
    }
    #[test]
    fn owned_kit_update_backs_up_old_bytes_and_preserves_edited_files() {
        let f = fixture();
        let previous = old_kit(&f);
        let (path, dir) = knowledge::open_root(f.root.path()).unwrap();
        assert_eq!(
            reconcile(path.clone(), dir.clone(), false).unwrap(),
            "available"
        );
        assert_eq!(
            reconcile(path.clone(), dir.clone(), true).unwrap(),
            "current"
        );
        let backups: Vec<_> =
            fs::read_dir(f.root.path().join(".my-knowledge/html-authoring/backups"))
                .unwrap()
                .filter_map(Result::ok)
                .collect();
        let backup = backups
            .iter()
            .find(|entry| entry.path().join("manifest.json").exists())
            .unwrap();
        for ((name, bytes), old) in CONTENTS.iter().zip(&previous) {
            assert_eq!(fs::read(f.root.path().join(name)).unwrap(), *bytes);
            assert_eq!(fs::read(backup.path().join(name)).unwrap(), *old);
        }
        fs::write(f.root.path().join(CONTENTS[2].0), "edited skill").unwrap();
        assert_eq!(reconcile(path, dir, true).unwrap(), "blocked");
        assert_eq!(
            fs::read_to_string(f.root.path().join(CONTENTS[2].0)).unwrap(),
            "edited skill"
        );
        let mixed = fixture();
        old_kit(&mixed);
        fs::write(
            mixed.root.path().join(CONTENTS[2].0),
            "customized old skill",
        )
        .unwrap();
        let (path, dir) = knowledge::open_root(mixed.root.path()).unwrap();
        assert_eq!(
            reconcile(path.clone(), dir.clone(), true).unwrap(),
            "blocked"
        );
        assert_eq!(
            fs::read(mixed.root.path().join(GUIDE)).unwrap(),
            CONTENTS[0].1
        );
        assert_eq!(
            fs::read_to_string(mixed.root.path().join(CONTENTS[2].0)).unwrap(),
            "customized old skill"
        );
        let installed: Manifest =
            serde_json::from_slice(&fs::read(mixed.root.path().join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(installed.version, 1);
        assert!(guide_available(&Root::open(path, dir).unwrap(), Some(&installed)).unwrap());
    }
    #[cfg(windows)]
    #[test]
    fn locked_kit_update_does_not_advance_manifest_and_rolls_back_completed_replacements() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = fixture();
        let previous = old_kit(&f);
        let manifest = fs::read(f.root.path().join(MANIFEST)).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(f.root.path().join(CONTENTS[1].0))
            .unwrap();
        let (path, dir) = knowledge::open_root(f.root.path()).unwrap();
        assert!(reconcile(path, dir, true).is_err());
        drop(locked);
        assert_eq!(fs::read(f.root.path().join(MANIFEST)).unwrap(), manifest);
        for ((path, _), old) in CONTENTS.iter().zip(&previous) {
            assert_eq!(fs::read(f.root.path().join(path)).unwrap(), *old);
        }
    }
    struct Fixture {
        root: tempfile::TempDir,
        profile: tempfile::TempDir,
        core: Arc<Core>,
        context: Context,
    }
    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("日本語資料")).unwrap();
        fs::write(root.path().join("日本語資料/アプリ.html"), "<input>").unwrap();
        let core = Core::new(19190);
        core.settings_path
            .set(profile.path().join("settings.json"))
            .unwrap();
        let snapshot = core.select(root.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let context = Context {
            workspace_id: snapshot.workspace_id.unwrap(),
            view_id: snapshot.view_id,
            revision: snapshot.revision,
        };
        Fixture {
            root,
            profile,
            core,
            context,
        }
    }
    fn installed(f: &Fixture) {
        let plan = preview(&f.core, &f.context).unwrap();
        let result = install(&f.core, &f.context, &plan.plan_id).unwrap();
        assert!(result.error.is_none());
    }
    #[test]
    fn explicit_preview_new_files_only_preserves_all_existing_instructions_and_skills() {
        let f = fixture();
        fs::write(f.root.path().join("AGENTS.md"), "user agents").unwrap();
        fs::write(f.root.path().join("AGENTS.local.md"), "user local").unwrap();
        fs::write(f.root.path().join("CLAUDE.md"), "user claude").unwrap();
        fs::create_dir_all(
            f.root
                .path()
                .join(".agents/skills/my-knowledge-html-authoring"),
        )
        .unwrap();
        fs::write(f.root.path().join(CONTENTS[2].0), "custom skill").unwrap();
        let plan = preview(&f.core, &f.context).unwrap();
        assert_eq!(plan.files[2].action, "conflict");
        assert!(!f.root.path().join(MANIFEST).exists());
        let result = install(&f.core, &f.context, &plan.plan_id).unwrap();
        assert_eq!(result.written.len(), 4);
        assert_eq!(result.skipped, [CONTENTS[2].0]);
        for (path, expected) in [
            ("AGENTS.md", "user agents"),
            ("AGENTS.local.md", "user local"),
            ("CLAUDE.md", "user claude"),
            (CONTENTS[2].0, "custom skill"),
        ] {
            assert_eq!(
                fs::read_to_string(f.root.path().join(path)).unwrap(),
                expected
            );
        }
        assert_eq!(
            fs::read(f.root.path().join(CONTENTS[1].0)).unwrap(),
            CONTENTS[1].1
        );
        assert!(install(&f.core, &f.context, &plan.plan_id).is_err());
        let again = preview(&f.core, &f.context).unwrap();
        assert_eq!(again.files[0].action, "current");
        assert_eq!(again.files[2].action, "conflict");
    }
    #[test]
    fn cancellation_latest_plan_expiry_and_stale_root_view_revision_do_not_write() {
        let f = fixture();
        let first = preview(&f.core, &f.context).unwrap();
        let second = preview(&f.core, &f.context).unwrap();
        cancel(&f.core, &f.context, &first.plan_id);
        assert!(install(&f.core, &f.context, &first.plan_id).is_err());
        cancel(&f.core, &f.context, &second.plan_id);
        assert!(install(&f.core, &f.context, &second.plan_id).is_err());
        let third = preview(&f.core, &f.context).unwrap();
        f.core
            .html_authoring_plan
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .created = Instant::now() - Duration::from_secs(301);
        assert!(install(&f.core, &f.context, &third.plan_id).is_err());
        let plan = preview(&f.core, &f.context).unwrap();
        let mut stale = f.context.clone();
        stale.revision += 1;
        assert!(install(&f.core, &stale, &plan.plan_id).is_err());
        stale = f.context.clone();
        stale.view_id = "stale".into();
        assert!(preview(&f.core, &stale).is_err());
        let other = tempfile::tempdir().unwrap();
        f.core.select(other.path(), false).unwrap();
        f.core.watcher.lock().unwrap().take();
        assert!(install(&f.core, &f.context, &plan.plan_id).is_err());
        assert!(!f.root.path().join(MANIFEST).exists());
    }
    #[test]
    fn changes_after_preview_are_rejected_before_claiming_ownership() {
        let f = fixture();
        let plan = preview(&f.core, &f.context).unwrap();
        fs::create_dir_all(f.root.path().join(".my-knowledge/html-authoring")).unwrap();
        fs::write(f.root.path().join(GUIDE), "new user guide").unwrap();
        assert!(install(&f.core, &f.context, &plan.plan_id).is_err());
        assert!(!f.root.path().join(MANIFEST).exists());
        assert_eq!(
            fs::read_to_string(f.root.path().join(GUIDE)).unwrap(),
            "new user guide"
        );
    }
    #[test]
    fn final_new_file_collision_preserves_user_bytes_and_partial_outputs_can_be_completed() {
        let f = fixture();
        let plan = preview(&f.core, &f.context).unwrap();
        let result = install_before_file(&f.core, &f.context, &plan.plan_id, |index| {
            if index == 0 {
                fs::write(f.root.path().join(GUIDE), "racing user guide").unwrap();
            }
        })
        .unwrap();
        assert!(result.error.is_some());
        assert_eq!(result.written, [MANIFEST]);
        assert_eq!(result.skipped.len(), 4);
        let original = fs::read(f.root.path().join(MANIFEST)).unwrap();
        let retry = preview(&f.core, &f.context).unwrap();
        assert_eq!(retry.files[0].action, "conflict");
        assert_eq!(retry.files[1].action, "create");
        let done = install(&f.core, &f.context, &retry.plan_id).unwrap();
        assert_eq!(done.written.len(), 3);
        assert_eq!(fs::read(f.root.path().join(MANIFEST)).unwrap(), original);
        assert_eq!(
            fs::read_to_string(f.root.path().join(GUIDE)).unwrap(),
            "racing user guide"
        );
        assert!(!get_status(&f.core, &f.context).unwrap().guide_available);
        assert!(set_enabled(&f.core, &f.context, None, true).is_err());
    }
    #[test]
    fn immutable_owned_files_missing_outputs_and_foreign_or_corrupt_manifest_are_preserved() {
        let f = fixture();
        installed(&f);
        let original = fs::read(f.root.path().join(MANIFEST)).unwrap();
        fs::remove_file(f.root.path().join(CONTENTS[1].0)).unwrap();
        let retry = preview(&f.core, &f.context).unwrap();
        assert_eq!(retry.files[1].action, "create");
        install(&f.core, &f.context, &retry.plan_id).unwrap();
        assert_eq!(fs::read(f.root.path().join(MANIFEST)).unwrap(), original);
        // Old owned payload hashes never authorize an overwrite or recreation.
        let mut old: serde_json::Value = serde_json::from_slice(&original).unwrap();
        old["files"][1]["hash"] = serde_json::json!("0".repeat(64));
        fs::write(
            f.root.path().join(MANIFEST),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        fs::remove_file(f.root.path().join(CONTENTS[1].0)).unwrap();
        let old_plan = preview(&f.core, &f.context).unwrap();
        assert_eq!(old_plan.files[1].action, "conflict");
        assert!(install(&f.core, &f.context, &old_plan.plan_id)
            .unwrap()
            .written
            .is_empty());
        assert!(!f.root.path().join(CONTENTS[1].0).exists());
        fs::write(f.root.path().join(MANIFEST), &original).unwrap();
        fs::write(f.root.path().join(CONTENTS[1].0), CONTENTS[1].1).unwrap();
        fs::write(f.root.path().join(GUIDE), "user-edited owned guide").unwrap();
        let changed = preview(&f.core, &f.context).unwrap();
        assert_eq!(changed.files[0].action, "conflict");
        install(&f.core, &f.context, &changed.plan_id).unwrap();
        assert_eq!(
            fs::read_to_string(f.root.path().join(GUIDE)).unwrap(),
            "user-edited owned guide"
        );
        let mut foreign: serde_json::Value = serde_json::from_slice(&original).unwrap();
        foreign["rootIdentity"] = serde_json::json!("0".repeat(64));
        let foreign_bytes = serde_json::to_vec(&foreign).unwrap();
        for bytes in [
            b"broken".as_slice(),
            b"{\"version\":999}".as_slice(),
            foreign_bytes.as_slice(),
        ] {
            fs::write(f.root.path().join(MANIFEST), bytes).unwrap();
            let blocked = preview(&f.core, &f.context).unwrap();
            assert!(blocked.read_only);
            assert!(install(&f.core, &f.context, &blocked.plan_id).is_err());
            assert_eq!(fs::read(f.root.path().join(MANIFEST)).unwrap(), bytes);
        }
    }
    #[test]
    fn root_preferences_default_off_cas_disable_and_corrupt_data_keep_saved_bytes() {
        let f = fixture();
        installed(&f);
        assert!(!get_status(&f.core, &f.context).unwrap().enabled);
        let on = set_enabled(&f.core, &f.context, None, true).unwrap();
        assert!(on.enabled);
        let ownership = fs::read(f.root.path().join(MANIFEST)).unwrap();
        fs::write(f.root.path().join(MANIFEST), b"corrupt kit ownership").unwrap();
        let blocked_kit = get_status(&f.core, &f.context).unwrap();
        assert!(!blocked_kit.read_only);
        assert!(!blocked_kit.guide_available);
        let disabled =
            set_enabled(&f.core, &f.context, on.preference_hash.as_deref(), false).unwrap();
        assert!(!disabled.enabled);
        assert_eq!(
            fs::read(f.root.path().join(MANIFEST)).unwrap(),
            b"corrupt kit ownership"
        );
        fs::write(f.root.path().join(MANIFEST), ownership).unwrap();
        let on = set_enabled(
            &f.core,
            &f.context,
            disabled.preference_hash.as_deref(),
            true,
        )
        .unwrap();
        assert!(set_enabled(&f.core, &f.context, None, false).is_err());
        let off = set_enabled(&f.core, &f.context, on.preference_hash.as_deref(), false).unwrap();
        assert!(!off.enabled);
        let file = f
            .profile
            .path()
            .join("html-authoring-settings")
            .join(format!("{}.json", off.root_identity));
        fs::write(&file, b"unknown preference").unwrap();
        let invalid = get_status(&f.core, &f.context).unwrap();
        assert!(invalid.read_only);
        assert!(set_enabled(&f.core, &f.context, None, true).is_err());
        assert_eq!(fs::read(file).unwrap(), b"unknown preference");
        let other = tempfile::tempdir().unwrap();
        let snapshot = f.core.select(other.path(), false).unwrap();
        f.core.watcher.lock().unwrap().take();
        let context = Context {
            workspace_id: snapshot.workspace_id.unwrap(),
            view_id: snapshot.view_id,
            revision: snapshot.revision,
        };
        assert!(!get_status(&f.core, &context).unwrap().enabled);
    }
    #[test]
    fn absent_guide_preferences_leave_existing_ai_handoff_and_unrelated_kit_bytes_untouched() {
        use crate::ai_handoff::{self, Context as AiContext, RootContext, RootTarget};
        let f = fixture();
        fs::create_dir_all(f.root.path().join(".my-knowledge/html-authoring")).unwrap();
        fs::write(f.root.path().join(MANIFEST), b"unrelated existing bytes").unwrap();
        let context = AiContext::Root(RootContext {
            workspace_id: f.context.workspace_id.clone(),
            view_id: f.context.view_id.clone(),
            target: RootTarget::Root,
        });
        assert!(ai_handoff::prepare(&f.core, &context)
            .unwrap()
            .guide_instruction
            .is_none());
        assert!(!f.profile.path().join("html-authoring-settings").exists());
        assert_eq!(
            fs::read(f.root.path().join(MANIFEST)).unwrap(),
            b"unrelated existing bytes"
        );
    }
    #[test]
    fn trusted_native_guide_composition_preserves_raw_user_text_file_path_and_folder_cwd() {
        use crate::ai_handoff::{
            self, Context as AiContext, Destination, DocumentContext, Request, RootContext,
            RootTarget,
        };
        let f = fixture();
        installed(&f);
        let root = || {
            AiContext::Root(RootContext {
                workspace_id: f.context.workspace_id.clone(),
                view_id: f.context.view_id.clone(),
                target: RootTarget::Root,
            })
        };
        let unset = ai_handoff::prepare(&f.core, &root()).unwrap();
        assert!(unset.guide_instruction.is_none());
        set_enabled(&f.core, &f.context, None, true).unwrap();
        let current = ai_handoff::prepare(&f.core, &root()).unwrap();
        assert!(current
            .guide_instruction
            .as_ref()
            .unwrap()
            .contains("`.my-knowledge/html-authoring/GUIDE.md`"));
        let raw = " 日本語 / path / $& \n\t ";
        let request = Request {
            context: root(),
            preview: current.clone(),
            instruction: raw.into(),
            destination: Destination::CodexApp,
            copy: false,
        };
        ai_handoff::perform(&f.core, &request, |target| {
            let query: std::collections::HashMap<_, _> = target
                .target
                .split_once('?')
                .unwrap()
                .1
                .split('&')
                .map(|part| part.split_once('=').unwrap())
                .collect();
            let prompt = percent_encoding::percent_decode_str(query["prompt"])
                .decode_utf8()
                .unwrap();
            assert_eq!(
                prompt,
                format!("{raw}\n\n{}", current.guide_instruction.as_ref().unwrap())
            );
            assert!(!prompt.starts_with(&current.selected_path));
            Ok(())
        })
        .unwrap();
        let file = AiContext::Document(DocumentContext {
            workspace_id: f.context.workspace_id.clone(),
            view_id: f.context.view_id.clone(),
            relative_path: "日本語資料/アプリ.html".into(),
        });
        let document = ai_handoff::prepare(&f.core, &file).unwrap();
        assert!(document
            .guide_instruction
            .as_ref()
            .unwrap()
            .contains("../.my-knowledge/"));
        ai_handoff::perform(
            &f.core,
            &Request {
                context: file,
                preview: document.clone(),
                instruction: raw.into(),
                destination: Destination::CodexCli,
                copy: true,
            },
            |target| {
                assert_eq!(
                    target.target,
                    format!(
                        "{}\n\n{raw}\n\n{}",
                        document.selected_path,
                        document.guide_instruction.as_ref().unwrap()
                    )
                );
                Ok(())
            },
        )
        .unwrap();
        let mut forged = current;
        forged.guide_instruction = Some("forged".into());
        assert!(ai_handoff::perform(
            &f.core,
            &Request {
                context: root(),
                preview: forged,
                instruction: "".into(),
                destination: Destination::CodexApp,
                copy: false
            },
            |_| panic!("must not dispatch")
        )
        .is_err());
        fs::write(f.root.path().join(GUIDE), "user change").unwrap();
        assert!(ai_handoff::prepare(&f.core, &root()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn linked_directories_files_and_replaced_roots_never_escape_the_fixed_output_scope() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), f.root.path().join(".agents")).unwrap();
        let blocked = preview(&f.core, &f.context).unwrap();
        assert!(blocked.read_only);
        assert!(install(&f.core, &f.context, &blocked.plan_id).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(f.root.path().join(".agents")).unwrap();
        installed(&f);
        fs::remove_file(f.root.path().join(GUIDE)).unwrap();
        fs::write(outside.path().join("guide.md"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path().join("guide.md"), f.root.path().join(GUIDE))
            .unwrap();
        assert!(preview(&f.core, &f.context).unwrap().read_only);
        assert_eq!(
            fs::read_to_string(outside.path().join("guide.md")).unwrap(),
            "outside"
        );
        let old = f.root.path().with_extension("retained");
        fs::rename(f.root.path(), &old).unwrap();
        fs::create_dir(f.root.path()).unwrap();
        assert!(preview(&f.core, &f.context).is_err());
        fs::remove_dir_all(old).unwrap();
    }
}
