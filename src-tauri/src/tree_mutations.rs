use crate::{
    core::{Change, Core, Snapshot},
    knowledge, tree_order,
    write_fs::{self, LockedDir},
};
use cap_std::fs::Dir;
#[path = "tree_mutations/trash.rs"]
mod trash;
#[cfg(test)]
#[path = "tree_mutations/trash_tests.rs"]
mod trash_tests;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Mutation {
    Trash {
        source: String,
        revision: u64,
    },
    CreateHtml {
        parent: String,
        name: String,
    },
    CreateFolder {
        parent: String,
        name: String,
    },
    RenameHtml {
        source: String,
        name: String,
    },
    Move {
        source: String,
        parent: String,
        #[serde(default)]
        anchor: Option<String>,
        #[serde(default)]
        after: bool,
    },
    Reorder {
        source: String,
        anchor: String,
        after: bool,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMove {
    pub from: String,
    pub to: String,
    pub revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub snapshot: Snapshot,
    pub created_path: Option<String>,
    pub moves: Vec<PathMove>,
    pub warning: Option<String>,
}

pub fn split(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or(("", path))
}
fn join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}
pub fn remap(path: &str, from: &str, to: &str) -> String {
    if path == from {
        to.into()
    } else if let Some(tail) = path.strip_prefix(&format!("{from}/")) {
        format!("{to}/{tail}")
    } else {
        path.into()
    }
}
fn commit_path_move(core: &Core, source: &str, destination: &str) -> PathMove {
    // HTTP reads do not take the mutation gate. Revoke old grants before
    // any potentially slow sidecar write or rescan can run.
    let mut state = core.workspace.lock().unwrap();
    crate::workspace_settings::remap(&mut state.settings, source, destination);
    for tab in state.tabs.values_mut() {
        let next = remap(&tab.entry, source, destination);
        if next != tab.entry {
            tab.entry = next;
            if let Some(document) = &mut tab.admitted_document {
                document.relative_path = remap(&document.relative_path, source, destination);
            }
            tab.session = None;
            tab.revocation += 1;
        }
    }
    PathMove {
        from: source.into(),
        to: destination.into(),
        revision: state.snapshot.revision + 1,
    }
}
pub fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('.')
        || name.ends_with(['.', ' '])
        || name.encode_utf16().count() > 200
        || name
            .chars()
            .any(|ch| ch < ' ' || "/\\<>:\"|?*".contains(ch))
    {
        return Err(
            "名前には1〜200文字を使い、区切り・隠し名・末尾の空白やドットを避けてください".into(),
        );
    }
    let base = name.split('.').next().unwrap().trim_end().to_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str())
        || base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                [
                    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³",
                ]
                .contains(&suffix)
            })
    {
        return Err("Windowsの予約名は利用できません".into());
    }
    Ok(())
}
fn no_collision(parent: &Dir, name: &str) -> Result<(), String> {
    let folded = name.to_lowercase();
    for entry in parent
        .entries()
        .map_err(|_| "親フォルダーを読み取れません")?
    {
        let entry = entry.map_err(|_| "親フォルダーを読み取れません")?;
        if entry.file_name().to_string_lossy().to_lowercase() == folded {
            return Err("同じ名前の項目があります（大文字・小文字を区別しません）".into());
        }
    }
    Ok(())
}
fn validate_subtree(file: &File) -> Result<(), String> {
    if !file
        .metadata()
        .map_err(|_| "移動対象を確認できません")?
        .is_dir()
    {
        return Ok(());
    }
    fn walk(dir: &Dir) -> Result<(), String> {
        for entry in dir.entries().map_err(|_| "移動対象を読み取れません")? {
            let entry = entry.map_err(|_| "移動対象を読み取れません")?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "この名前の文字コードは利用できません")?;
            let is_directory = write_fs::entry_is_directory(dir, &name)
                .map_err(|_| "リンクやクラウド上の項目を含むフォルダーは移動できません")?;
            let file = write_fs::open_subtree_entry(dir, &name, is_directory)
                .map_err(|_| "リンク/reparseや特殊ファイルを含むフォルダーは移動できません")?;
            if is_directory {
                walk(&Dir::from_std_file(file))?;
            }
        }
        Ok(())
    }
    walk(&Dir::from_std_file(
        file.try_clone().map_err(|_| "移動対象を確認できません")?,
    ))
}

#[derive(Clone, PartialEq)]
struct Fingerprint {
    identity: (u64, u128),
    modified: Option<SystemTime>,
    length: u64,
    readonly: bool,
}
pub struct Echo {
    path: String,
    value: Option<Fingerprint>,
    expires: Instant,
}
fn fingerprint(root: &Dir, path: &str) -> Result<Option<Fingerprint>, ()> {
    let (parent, name) = split(path);
    let parent = LockedDir::open(root, parent).map_err(|_| ())?;
    let is_directory = match write_fs::entry_is_directory(parent.dir(), name) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let file = write_fs::open_at(parent.dir(), name, is_directory, false, false).map_err(|_| ())?;
    let meta = file.metadata().map_err(|_| ())?;
    Ok(Some(Fingerprint {
        identity: write_fs::identity(&file).map_err(|_| ())?,
        modified: meta.modified().ok(),
        length: meta.len(),
        readonly: meta.permissions().readonly(),
    }))
}
/// Only explicit structural-only watcher batches may use metadata echoes.
/// Metadata cannot prove that a file's contents have not changed.
pub fn filter_structural_echoes(
    state: &mut crate::core::Workspace,
    paths: Vec<String>,
) -> Vec<String> {
    filter_echoes_with(state, paths, fingerprint)
}
fn filter_echoes_with(
    state: &mut crate::core::Workspace,
    paths: Vec<String>,
    mut inspect: impl FnMut(&Dir, &str) -> Result<Option<Fingerprint>, ()>,
) -> Vec<String> {
    let Some(dir) = state.dir.clone() else {
        return paths;
    };
    state
        .mutation_echoes
        .retain(|echo| echo.expires > Instant::now());
    paths
        .into_iter()
        .filter(|path| {
            // Ordinary watcher traffic never probes native-mutation metadata.
            // In particular Cloud Files roots bypass this write-only helper.
            if !state.mutation_echoes.iter().any(|echo| echo.path == *path) {
                return true;
            }
            let value = inspect(&dir, path);
            let matching = value.as_ref().is_ok_and(|value| {
                state
                    .mutation_echoes
                    .iter()
                    .any(|echo| echo.path == *path && &echo.value == value)
            });
            if !matching {
                // Once an external change is observed, an older native echo must
                // never hide a later change that happens to restore its value.
                state.mutation_echoes.retain(|echo| echo.path != *path);
            }
            !matching
        })
        .collect()
}

pub fn perform(
    core: &Arc<Core>,
    workspace: &str,
    view: &str,
    mutation: Mutation,
) -> Result<MutationResult, String> {
    perform_with(core, workspace, view, mutation, || {})
}
fn perform_with(
    core: &Arc<Core>,
    workspace: &str,
    view: &str,
    mutation: Mutation,
    before: impl FnOnce(),
) -> Result<MutationResult, String> {
    perform_with_trash(core, workspace, view, mutation, before, trash::execute)
}
fn perform_with_trash(
    core: &Arc<Core>,
    workspace: &str,
    view: &str,
    mutation: Mutation,
    before: impl FnOnce(),
    recycle: impl FnOnce(&std::path::Path) -> Result<(), String>,
) -> Result<MutationResult, String> {
    let _gate = core.gate.lock().unwrap();
    let (root, dir, snapshot, mut order) = {
        let state = core.workspace.lock().unwrap();
        if state.snapshot.workspace_id.as_deref() != Some(workspace) {
            return Err("WorkspaceChanged".into());
        }
        if state.snapshot.view_id != view {
            return Err("ViewChanged".into());
        }
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
            state.snapshot.clone(),
            state.order.clone(),
        )
    };
    #[cfg(windows)]
    let _metadata_scope =
        knowledge::local_metadata_scope().map_err(|_| "安全なファイル検証を開始できません")?;
    #[cfg(windows)]
    if knowledge::validate_cache_path(&root).is_err() {
        return perform_cloud(core, workspace, &root, &dir, snapshot, mutation, before);
    }
    let creating_html = matches!(&mutation, Mutation::CreateHtml { .. });
    let recycling = matches!(&mutation, Mutation::Trash { .. });
    let mut rescan_needed = !matches!(&mutation, Mutation::Reorder { .. });
    let mut created = None;
    let mut moves = Vec::new();
    let mut changed = Vec::new();
    let mut warning = None;
    match mutation {
        Mutation::Trash { source, revision } => {
            if snapshot.revision != revision {
                return Err("ツリーが変更されました。対象を確認し直してください".into());
            }
            knowledge::validate_relative(&source)?;
            let (parent, name) = split(&source);
            let node = tree_order::children(&snapshot.nodes, parent)
                .and_then(|nodes| nodes.iter().find(|node| node.relative_path == source))
                .ok_or("ごみ箱に移動する対象が見つかりません")?;
            let parent_handle = LockedDir::open(&dir, parent)?;
            let source_file = write_fs::open_at(
                parent_handle.dir(),
                name,
                node.kind == "folder",
                false,
                false,
            )
            .map_err(|_| "対象を開けません。アクセス権・リンク・ロックを確認してください")?;
            validate_subtree(&source_file)?;
            let identity = write_fs::identity(&source_file).map_err(|_| "対象を確認できません")?;
            before();
            parent_handle.revalidate(&root, &dir)?;
            let current = write_fs::open_at(
                parent_handle.dir(),
                name,
                node.kind == "folder",
                false,
                false,
            )
            .map_err(|_| "対象が変更されました。確認し直してください")?;
            if write_fs::identity(&current).map_err(|_| "対象を確認できません")? != identity
            {
                return Err("対象が置き換えられました。確認し直してください".into());
            }
            validate_subtree(&current)?;
            // Shell/FileManager needs to acquire its own delete-capable handle.
            // Keep all ancestor capabilities locked during OS dispatch; never
            // emulate recycling with remove_file/remove_dir_all.
            drop(current);
            drop(source_file);
            recycle(&root.join(&source))?;
            // Revoke immediately after committed OS success, before rescan or
            // index I/O. Storage identities and their SQLite values are retained.
            {
                let mut state = core.workspace.lock().unwrap();
                for tab in state.tabs.values_mut() {
                    if tab.entry == source || tab.entry.starts_with(&format!("{source}/")) {
                        tab.session = None;
                        tab.revocation += 1;
                    }
                }
            }
            changed.push(source);
        }
        Mutation::CreateHtml { parent, name } | Mutation::CreateFolder { parent, name } => {
            // The enum is recorded before matching so HTML extension handling is exact.
            let html = creating_html;
            if tree_order::children(&snapshot.nodes, &parent).is_none() {
                return Err("親フォルダーが見つかりません".into());
            }
            valid_name(&name)?;
            let name = if html && !name.to_ascii_lowercase().ends_with(".html") {
                format!("{name}.html")
            } else {
                name
            };
            valid_name(&name)?;
            let parent_handle = LockedDir::open(&dir, &parent)?;
            no_collision(parent_handle.dir(), &name)?;
            before();
            parent_handle.revalidate(&root, &dir)?;
            no_collision(parent_handle.dir(), &name)?;
            if html {
                let (temporary, mut file) = write_fs::create_temporary(parent_handle.dir())
                    .map_err(|_| "HTMLを作成できません。アクセス権を確認してください")?;
                let title = name
                    .trim_end_matches(".html")
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;");
                let content=format!("<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n</body>\n</html>\n");
                let result: Result<(), String> = (|| {
                    file.write_all(content.as_bytes())
                        .and_then(|_| file.sync_all())
                        .map_err(|_| "HTMLを書き込めません")?;
                    parent_handle.revalidate(&root, &dir)?;
                    no_collision(parent_handle.dir(), &name)?;
                    write_fs::rename_noreplace(
                        parent_handle.dir(),
                        &temporary,
                        parent_handle.dir(),
                        &name,
                        &file,
                    )
                    .map_err(|_| {
                        "HTMLを公開できません。同名・アクセス権・外部変更を確認してください"
                            .to_owned()
                    })
                })();
                if result.is_err() {
                    let _ = write_fs::remove_temporary(parent_handle.dir(), &temporary, &file);
                }
                result?;
                created = Some(join(&parent, &name));
            } else {
                write_fs::mkdir(parent_handle.dir(), &name).map_err(|_| {
                    "フォルダーを作成できません。同名・アクセス権を確認してください"
                })?;
            }
            changed.push(join(&parent, &name));
        }
        Mutation::RenameHtml { source, name } => {
            let (parent, previous_name) = split(&source);
            let siblings = tree_order::children(&snapshot.nodes, parent)
                .ok_or("名前変更対象が見つかりません")?;
            let node = siblings
                .iter()
                .find(|node| node.relative_path == source && node.kind == "html")
                .ok_or("名前変更対象のHTMLが見つかりません")?;
            let (_, extension) = previous_name
                .rsplit_once('.')
                .filter(|(_, extension)| {
                    extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
                })
                .ok_or("名前変更対象のHTML拡張子が無効です")?;
            valid_name(&name)?;
            let next_name = format!("{name}.{extension}");
            valid_name(&next_name)?;
            let parent_handle = LockedDir::open(&dir, parent)?;
            let unchanged = next_name == node.name;
            let source_file =
                write_fs::open_at(parent_handle.dir(), previous_name, false, false, !unchanged)
                    .map_err(|_| {
                        "名前変更対象を開けません。アクセス権・リンク・ロックを確認してください"
                    })?;
            if unchanged {
                before();
                parent_handle.revalidate(&root, &dir)?;
                let current =
                    write_fs::open_at(parent_handle.dir(), previous_name, false, false, false)
                        .map_err(|_| "名前変更対象が変更されました。再走査してください")?;
                if write_fs::identity(&current).map_err(|_| "名前変更対象を確認できません")?
                    != write_fs::identity(&source_file)
                        .map_err(|_| "名前変更対象を確認できません")?
                {
                    return Err("名前変更対象が変更されました。再走査してください".into());
                }
                return Ok(MutationResult {
                    snapshot,
                    created_path: None,
                    moves: Vec::new(),
                    warning: None,
                });
            }
            if next_name.to_lowercase() == previous_name.to_lowercase() {
                return Err("大文字・小文字だけの名前変更には対応していません".into());
            }
            no_collision(parent_handle.dir(), &next_name)?;
            before();
            parent_handle.revalidate(&root, &dir)?;
            no_collision(parent_handle.dir(), &next_name)?;
            write_fs::rename_noreplace(
                parent_handle.dir(),
                previous_name,
                parent_handle.dir(),
                &next_name,
                &source_file,
            )
            .map_err(|_| {
                "名前変更できません。同名・外部変更・アクセス権・ロックを確認してください"
            })?;
            let destination = join(parent, &next_name);
            moves.push(commit_path_move(core, &source, &destination));
            if let Some(store) = core.document_state.get() {
                if store.remap_locations(&dir, &source, &destination).is_err() {
                    warning = Some("名前変更は完了しましたが、旧入力状態の場所情報を更新できません。保存状態そのものは保持されています".into());
                }
            }
            // Keep the renamed document in its current visual position, including
            // default alphabetical order that would otherwise change on rescan.
            order.parents.insert(
                parent.into(),
                siblings
                    .iter()
                    .map(|node| {
                        if node.relative_path == source {
                            next_name.clone()
                        } else {
                            node.name.clone()
                        }
                    })
                    .collect(),
            );
            changed.extend([source, destination]);
            if let Err(error) = tree_order::save(core, &root, &order) {
                warning = Some(format!(
                    "名前変更は完了しましたが、{error}。保存済み順序で再走査しました"
                ));
                order = tree_order::load(core, &root).unwrap_or_default();
            }
        }
        Mutation::Move {
            source,
            parent,
            anchor,
            after,
        } => {
            let (source_parent, name) = split(&source);
            valid_name(name)?;
            if tree_order::children(&snapshot.nodes, source_parent)
                .is_none_or(|nodes| !nodes.iter().any(|node| node.relative_path == source))
            {
                return Err("移動対象が見つかりません".into());
            }
            if tree_order::children(&snapshot.nodes, &parent).is_none() {
                return Err("移動先フォルダーが見つかりません".into());
            }
            if source_parent == parent {
                return Err("同じ親では並べ替えを使ってください".into());
            }
            if parent == source || parent.starts_with(&format!("{source}/")) {
                return Err("自分自身や子孫へは移動できません".into());
            }
            let destination_names = if let Some(anchor) = anchor.as_ref() {
                let (anchor_parent, anchor_name) = split(anchor);
                if anchor_parent != parent {
                    return Err("移動先の同じ親にある項目を指定してください".into());
                }
                let mut names: Vec<_> = tree_order::children(&snapshot.nodes, &parent)
                    .unwrap()
                    .iter()
                    .map(|node| node.name.clone())
                    .collect();
                let at = names
                    .iter()
                    .position(|item| item == anchor_name)
                    .ok_or("移動先の項目が見つかりません")?
                    + usize::from(after);
                names.insert(at, name.into());
                Some(names)
            } else {
                None
            };
            let old = LockedDir::open(&dir, source_parent)?;
            let new = LockedDir::open(&dir, &parent)?;
            let node = tree_order::children(&snapshot.nodes, source_parent)
                .unwrap()
                .iter()
                .find(|node| node.relative_path == source)
                .unwrap();
            let source_file =
                write_fs::open_at(old.dir(), name, node.kind == "folder", false, true).map_err(
                    |_| "移動対象を開けません。アクセス権・リンク・ロックを確認してください",
                )?;
            validate_subtree(&source_file)?;
            no_collision(new.dir(), name)?;
            before();
            old.revalidate(&root, &dir)?;
            new.revalidate(&root, &dir)?;
            no_collision(new.dir(), name)?;
            write_fs::rename_noreplace(old.dir(), name, new.dir(), name, &source_file).map_err(
                |_| "移動できません。同名・外部変更・アクセス権・ロックを確認してください",
            )?;
            let destination = join(&parent, name);
            moves.push(commit_path_move(core, &source, &destination));
            if let Some(store) = core.document_state.get() {
                if store.remap_locations(&dir, &source, &destination).is_err() {
                    warning = Some("移動は完了しましたが、旧入力状態の場所情報を更新できません。保存状態そのものは保持されています".into());
                }
            }
            tree_order::remap(&mut order, &source, &destination);
            if let Some(names) = destination_names {
                order.parents.insert(parent, names);
            }
            changed.extend([source.clone(), destination.clone()]);
            // A filesystem move is already committed; sidecar failure never rolls it back.
            if let Err(error) = tree_order::save(core, &root, &order) {
                warning = Some(format!(
                    "移動は完了しましたが、{error}。保存済み順序で再走査しました"
                ));
                order = tree_order::load(core, &root).unwrap_or_default();
            }
        }
        Mutation::Reorder {
            source,
            anchor,
            after,
        } => {
            let next = tree_order::reordered(&order, &snapshot.nodes, &source, &anchor, after)?;
            let (parent, _) = split(&source);
            let parent_handle = LockedDir::open(&dir, parent)?;
            for path in [&source, &anchor] {
                let (_, name) = split(path);
                let node = tree_order::children(&snapshot.nodes, parent)
                    .unwrap()
                    .iter()
                    .find(|node| node.relative_path == *path)
                    .ok_or("項目が見つかりません")?;
                let _ = write_fs::open_at(
                    parent_handle.dir(),
                    name,
                    node.kind == "folder",
                    false,
                    false,
                )
                .map_err(|_| "項目が変更されました。再走査してください")?;
            }
            before();
            parent_handle.revalidate(&root, &dir)?;
            if let Err(error) = tree_order::save(core, &root, &next) {
                warning = Some(format!("{error}。並べ替えを適用せず再走査しました"));
                order = tree_order::load(core, &root).unwrap_or_default();
                rescan_needed = true;
            } else {
                order = next;
            }
        }
    }
    {
        let mut state = core.workspace.lock().unwrap();
        state.order = order.clone();
    }
    if let Err(error) = crate::workspace_settings::flush_locked(core) {
        warning = Some(error);
    }
    let scan_started = Instant::now();
    let (mut nodes, tree_complete) = if !rescan_needed {
        (snapshot.nodes.clone(), snapshot.tree_complete)
    } else {
        match knowledge::scan(&root) {
            Ok(nodes) => (nodes, true),
            Err(error) => {
                warning = Some(format!("操作後の{error}。再走査してください"));
                (Vec::new(), false)
            }
        }
    };
    let scan_duration_ms = if rescan_needed {
        scan_started.elapsed().as_secs_f64() * 1000.0
    } else {
        0.0
    };
    tree_order::apply(&mut nodes, &order);
    {
        let mut state = core.workspace.lock().unwrap();
        for tab in state.tabs.values_mut() {
            if !knowledge::contains(&nodes, &tab.entry) {
                tab.session = None;
                tab.revocation += 1;
            }
        }
        state.snapshot.nodes = nodes;
        state.snapshot.tree_complete = tree_complete;
        state.snapshot.scan_duration_ms = scan_duration_ms;
        state.snapshot.revision += 1;
        state.snapshot.path_moves.extend(moves.iter().cloned());
        if state.snapshot.path_moves.len() > 128 {
            let excess = state.snapshot.path_moves.len() - 128;
            state.snapshot.path_moves.drain(..excess);
        }
        let echo_paths: std::collections::HashSet<_> = changed
            .iter()
            .flat_map(|path| {
                let (parent, _) = split(path);
                [path.clone(), parent.into()]
            })
            .filter(|path| !path.is_empty())
            .collect();
        for path in echo_paths {
            let Ok(value) = fingerprint(&dir, &path) else {
                continue;
            };
            state.mutation_echoes.push(Echo {
                path,
                value,
                expires: Instant::now() + Duration::from_secs(2),
            });
        }
        if state.mutation_echoes.len() > 256 {
            let count = state.mutation_echoes.len() - 256;
            state.mutation_echoes.drain(..count);
        }
    }
    let snapshot = core.snapshot();
    // Publish committed create/move paths before their watcher echoes can be
    // suppressed. Reordering changes no HTML path/content and needs no reindex.
    if !changed.is_empty() {
        if let Some(index) = core.index.get() {
            index.changed(
                workspace,
                &changed,
                &snapshot.nodes,
                true,
                snapshot.watch_error.is_some(),
            );
        }
    }
    core.emit(Change {
        workspace_id: workspace.into(),
        revision: snapshot.revision,
        changed_paths: changed,
        structure_changed: true,
        watch_error: snapshot.watch_error.clone(),
        moves: moves.clone(),
        tree_only: !recycling,
    });
    Ok(MutationResult {
        snapshot,
        created_path: created,
        moves,
        warning,
    })
}

#[cfg(windows)]
fn perform_cloud(
    core: &Arc<Core>,
    workspace: &str,
    root: &std::path::Path,
    dir: &Dir,
    snapshot: Snapshot,
    mutation: Mutation,
    before: impl FnOnce(),
) -> Result<MutationResult, String> {
    let creating_html = matches!(&mutation, Mutation::CreateHtml { .. });
    let (destination, source, kind, outcome) = match mutation {
        Mutation::CreateHtml { parent, name } | Mutation::CreateFolder { parent, name } => {
            let html = creating_html;
            if tree_order::children(&snapshot.nodes, &parent).is_none() {
                return Err("親フォルダーが見つかりません".into());
            }
            valid_name(&name)?;
            let name = if html && !name.to_ascii_lowercase().ends_with(".html") {
                format!("{name}.html")
            } else {
                name
            };
            valid_name(&name)?;
            let outcome = if html {
                let title = name
                    .trim_end_matches(".html")
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;");
                let content = format!("<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<title>{title}</title>\n</head>\n<body>\n</body>\n</html>\n");
                knowledge::create_cloud_html(root, dir, &parent, &name, content.as_bytes(), || {
                    before();
                    Ok(())
                })?
            } else {
                knowledge::create_cloud_folder(root, dir, &parent, &name, || {
                    before();
                    Ok(())
                })?
            };
            (
                join(&parent, &name),
                None,
                if html { "html" } else { "folder" },
                outcome,
            )
        }
        Mutation::RenameHtml { source, name } => {
            let (parent, previous) = split(&source);
            let node = tree_order::children(&snapshot.nodes, parent)
                .and_then(|nodes| {
                    nodes
                        .iter()
                        .find(|node| node.relative_path == source && node.kind == "html")
                })
                .ok_or("名前変更対象のHTMLが見つかりません")?;
            let (_, extension) = previous
                .rsplit_once('.')
                .filter(|(_, ext)| {
                    ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm")
                })
                .ok_or("名前変更対象のHTML拡張子が無効です")?;
            valid_name(&name)?;
            let name = format!("{name}.{extension}");
            valid_name(&name)?;
            if name == node.name {
                knowledge::move_cloud_leaf(root, dir, &source, &source, false, || {
                    before();
                    Ok(())
                })?;
                return Ok(MutationResult {
                    snapshot,
                    created_path: None,
                    moves: Vec::new(),
                    warning: None,
                });
            }
            if name.to_lowercase() == node.name.to_lowercase() {
                return Err("大文字・小文字だけの名前変更には対応していません".into());
            }
            let destination = join(parent, &name);
            let outcome =
                knowledge::move_cloud_leaf(root, dir, &source, &destination, false, || {
                    before();
                    Ok(())
                })?;
            (destination, Some(source), "html", outcome)
        }
        Mutation::Move {
            source,
            parent,
            anchor,
            ..
        } => {
            // Ordering needs a separate persistent sidecar transaction. Plain
            // moves are enabled first; anchored/reorder/trash remain excluded.
            if anchor.is_some() {
                return Err("同期フォルダー内では位置指定の移動に対応していません".into());
            }
            let (old_parent, name) = split(&source);
            let node = tree_order::children(&snapshot.nodes, old_parent)
                .and_then(|nodes| nodes.iter().find(|node| node.relative_path == source))
                .ok_or("移動対象が見つかりません")?;
            if old_parent == parent || parent == source || parent.starts_with(&format!("{source}/"))
            {
                return Err("同じ親や自分自身・子孫へは移動できません".into());
            }
            if tree_order::children(&snapshot.nodes, &parent).is_none() {
                return Err("移動先フォルダーが見つかりません".into());
            }
            let directory = node.kind == "folder";
            if directory && !node.children.is_empty() {
                return Err("同期フォルダー内では空フォルダーだけを移動できます".into());
            }
            let destination = join(&parent, name);
            let outcome =
                knowledge::move_cloud_leaf(root, dir, &source, &destination, directory, || {
                    before();
                    Ok(())
                })?;
            (destination, Some(source), node.kind, outcome)
        }
        _ => return Err("同期フォルダー内ではごみ箱・並べ替えに対応していません".into()),
    };
    publish_cloud_change(core, workspace, dir, destination, source, kind, outcome)
}
#[cfg(windows)]
fn publish_cloud_change(
    core: &Arc<Core>,
    workspace: &str,
    dir: &Dir,
    destination: String,
    source: Option<String>,
    kind: &'static str,
    outcome: knowledge::CloudWriteOutcome,
) -> Result<MutationResult, String> {
    let root = core
        .workspace
        .lock()
        .unwrap()
        .root
        .clone()
        .ok_or("knowledgeフォルダーが未選択です")?;
    let verified = outcome == knowledge::CloudWriteOutcome::Verified
        && knowledge::open_root(&root)
            .and_then(|(_, current)| knowledge::same_directory(dir, &current))
            .unwrap_or(false);
    let mut warning = (!verified).then(|| "操作が完了した可能性がありますが、確認を完了できませんでした。再試行や削除をせず、再読み込みで状態を確認してください".to_owned());
    let mut moves = Vec::new();
    if verified {
        if let Some(source) = source.as_ref() {
            moves.push(commit_path_move(core, source, &destination));
            // Existing state/profile policies remain intact. A location update
            // failure never removes saved values or rolls back a committed move.
            if let Some(store) = core.document_state.get() {
                if store.remap_locations(dir, source, &destination).is_err() {
                    warning = Some("移動は完了しましたが、旧入力状態の場所情報を更新できません。保存状態そのものは保持されています".into());
                }
            }
        }
    }
    let published =
        {
            let mut state = core.workspace.lock().unwrap();
            if verified {
                let rename_order = source
                    .as_ref()
                    .filter(|source| split(source).0 == split(&destination).0)
                    .and_then(|source| {
                        tree_order::children(&state.snapshot.nodes, split(source).0).map(|nodes| {
                            nodes
                                .iter()
                                .map(|node| {
                                    if node.relative_path == *source {
                                        split(&destination).1.into()
                                    } else {
                                        node.name.clone()
                                    }
                                })
                                .collect::<Vec<String>>()
                        })
                    });
                let mut node = source
                    .as_ref()
                    .and_then(|source| remove_cloud_node(&mut state.snapshot.nodes, source))
                    .unwrap_or(knowledge::TreeNode {
                        relative_path: destination.clone(),
                        name: split(&destination).1.into(),
                        kind,
                        children: Vec::new(),
                    });
                node.relative_path = destination.clone();
                node.name = split(&destination).1.into();
                if let Some(children) =
                    cloud_children_mut(&mut state.snapshot.nodes, split(&destination).0)
                {
                    children.push(node);
                    children.sort_by(|a, b| {
                        (a.kind != "folder")
                            .cmp(&(b.kind != "folder"))
                            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                            .then_with(|| a.name.cmp(&b.name))
                    });
                }
                if let Some(source) = source.as_ref() {
                    tree_order::remap(&mut state.order, source, &destination);
                }
                if let Some(names) = rename_order {
                    state
                        .order
                        .parents
                        .insert(split(&destination).0.into(), names);
                }
                let order = state.order.clone();
                tree_order::apply(&mut state.snapshot.nodes, &order);
                state.snapshot.path_moves.extend(moves.iter().cloned());
                if state.snapshot.path_moves.len() > 128 {
                    let excess = state.snapshot.path_moves.len() - 128;
                    state.snapshot.path_moves.drain(..excess);
                }
            } else if let Some(source) = source.as_ref() {
                for tab in state.tabs.values_mut().filter(|tab| {
                    tab.entry == *source || tab.entry.starts_with(&format!("{source}/"))
                }) {
                    tab.session = None;
                    tab.revocation += 1;
                }
            }
            // Unknown preserves the confirmed tree, preferences and database;
            // only verified moves reach the scoped ordinary sidecar publishers.
            state.snapshot.revision += 1;
            state.snapshot.scan_duration_ms = 0.0;
            state.snapshot.clone()
        };
    if verified && !moves.is_empty() {
        let order = core.workspace.lock().unwrap().order.clone();
        let order_result = tree_order::save_cloud_move(core, &root, &order);
        let preferences_result = crate::workspace_settings::flush_cloud_move_locked(core);
        for error in [order_result.err(), preferences_result.err()]
            .into_iter()
            .flatten()
        {
            let message =
                format!("移動は完了しましたが、{error}。自動復元せず現在のファイルを保持します");
            warning = Some(match warning {
                Some(previous) => format!("{previous}\n{message}"),
                None => message,
            });
        }
    }
    let mut changed = vec![destination.clone()];
    if let Some(source) = source {
        changed.push(source);
    }
    if verified {
        if let Some(index) = core.index.get() {
            index.changed(
                workspace,
                &changed,
                &published.nodes,
                true,
                published.watch_error.is_some(),
            );
        }
    }
    core.emit(Change {
        workspace_id: workspace.into(),
        revision: published.revision,
        changed_paths: changed,
        structure_changed: true,
        watch_error: published.watch_error.clone(),
        moves: moves.clone(),
        tree_only: true,
    });
    Ok(MutationResult {
        snapshot: published,
        created_path: (verified && moves.is_empty() && kind == "html").then_some(destination),
        moves,
        warning,
    })
}
#[cfg(windows)]
fn cloud_children_mut<'a>(
    nodes: &'a mut Vec<knowledge::TreeNode>,
    parent: &str,
) -> Option<&'a mut Vec<knowledge::TreeNode>> {
    if parent.is_empty() {
        return Some(nodes);
    }
    for node in nodes {
        if node.relative_path == parent && node.kind == "folder" {
            return Some(&mut node.children);
        }
        if let Some(children) = cloud_children_mut(&mut node.children, parent) {
            return Some(children);
        }
    }
    None
}
#[cfg(windows)]
fn remove_cloud_node(
    nodes: &mut Vec<knowledge::TreeNode>,
    path: &str,
) -> Option<knowledge::TreeNode> {
    if let Some(at) = nodes.iter().position(|node| node.relative_path == path) {
        return Some(nodes.remove(at));
    }
    for node in nodes {
        if let Some(found) = remove_cloud_node(&mut node.children, path) {
            return Some(found);
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    #[test]
    fn tree_completeness_tracks_mutation_rescans_and_is_retained_without_scan() {
        let (_tmp, core, snapshot, _root) = fixture();
        core.workspace.lock().unwrap().snapshot.tree_complete = false;
        let reordered = run(&core, &snapshot, reorder("b.html", "a.html", false)).unwrap();
        assert!(!reordered.snapshot.tree_complete);
        let created = run(
            &core,
            &reordered.snapshot,
            Mutation::CreateFolder {
                parent: String::new(),
                name: "New".into(),
            },
        )
        .unwrap();
        assert!(created.snapshot.tree_complete);
    }
    fn fixture() -> (tempfile::TempDir, Arc<Core>, Snapshot, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("knowledge");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("Folder")).unwrap();
        fs::create_dir(root.join("Target")).unwrap();
        for name in ["a.html", "b.html", "c.html", "Folder/nested.html"] {
            fs::write(
                root.join(name),
                format!("<!doctype html><meta charset=\"utf-8\"><body>{name}</body>"),
            )
            .unwrap();
        }
        let core = Core::new(19200);
        core.settings_path
            .set(tmp.path().join("config/settings.json"))
            .unwrap();
        let snapshot = core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        (tmp, core, snapshot, root)
    }
    #[cfg(windows)]
    #[test]
    fn unknown_cloud_creation_preserves_tree_and_settings_without_success_claim() {
        let (tmp, core, snapshot, root) = fixture();
        let before = serde_json::to_value(&snapshot.nodes).unwrap();
        let profile = tmp.path().join("config/settings.json");
        fs::create_dir_all(profile.parent().unwrap()).unwrap();
        fs::write(&profile, "untouched test sentinel").unwrap();
        let settings = serde_json::to_value(
            crate::workspace_settings::get(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                false,
            )
            .unwrap(),
        )
        .unwrap();
        let dir = core.workspace.lock().unwrap().dir.clone().unwrap();
        let result = publish_cloud_change(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &dir,
            "unconfirmed".into(),
            None,
            "folder",
            knowledge::CloudWriteOutcome::Unknown,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&result.snapshot.nodes).unwrap(),
            before
        );
        assert_eq!(
            serde_json::to_value(
                crate::workspace_settings::get(
                    &core,
                    snapshot.workspace_id.as_ref().unwrap(),
                    &snapshot.view_id,
                    false
                )
                .unwrap()
            )
            .unwrap(),
            settings
        );
        assert_eq!(fs::read(&profile).unwrap(), b"untouched test sentinel");
        assert!(!root.join("unconfirmed").exists());
        assert!(result.created_path.is_none());
        assert!(result.moves.is_empty());
        assert!(result.warning.unwrap().contains("再試行や削除をせず"));
        assert_eq!(result.snapshot.revision, snapshot.revision + 1);
    }

    #[cfg(windows)]
    #[test]
    fn unknown_cloud_move_revokes_only_source_without_remapping_preferences() {
        let (_tmp, core, snapshot, root) = fixture();
        fs::create_dir_all(core.settings_path.get().unwrap().parent().unwrap()).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        let source_tab = core
            .create_tab(workspace, &snapshot.view_id, "a.html")
            .unwrap();
        let other_tab = core
            .create_tab(workspace, &snapshot.view_id, "b.html")
            .unwrap();
        let source_url = core
            .open(workspace, &snapshot.view_id, &source_tab, 1)
            .unwrap();
        let other_url = core
            .open(workspace, &snapshot.view_id, &other_tab, 1)
            .unwrap();
        crate::workspace_settings::favorite(&core, workspace, &snapshot.view_id, "a.html", true)
            .unwrap();
        let (dir, nodes) = {
            let state = core.workspace.lock().unwrap();
            (
                state.dir.clone().unwrap(),
                serde_json::to_value(&state.snapshot.nodes).unwrap(),
            )
        };
        let settings = serde_json::to_value(
            crate::workspace_settings::get(&core, workspace, &snapshot.view_id, false).unwrap(),
        )
        .unwrap();
        let profile = core
            .settings_path
            .get()
            .unwrap()
            .parent()
            .unwrap()
            .join("workspace-settings")
            .join(format!(
                "{}.json",
                knowledge::storage_root_identity(&dir).unwrap()
            ));
        let stored = fs::read(&profile).unwrap();
        let result = publish_cloud_change(
            &core,
            workspace,
            &dir,
            "Target/a.html".into(),
            Some("a.html".into()),
            "html",
            knowledge::CloudWriteOutcome::Unknown,
        )
        .unwrap();
        assert!(result.moves.is_empty());
        assert!(result.created_path.is_none());
        assert!(result.warning.is_some());
        assert_eq!(serde_json::to_value(&result.snapshot.nodes).unwrap(), nodes);
        let state = core.workspace.lock().unwrap();
        assert_eq!(state.tabs[&source_tab].entry, "a.html");
        drop(state);
        assert_eq!(
            serde_json::to_value(
                crate::workspace_settings::get(&core, workspace, &snapshot.view_id, false).unwrap()
            )
            .unwrap(),
            settings
        );
        assert!(core.session_for_token(token(&source_url)).is_none());
        assert!(core.session_for_token(token(&other_url)).is_some());
        assert_eq!(fs::read(&profile).unwrap(), stored);
        assert!(root.join("a.html").exists());
        assert!(!root.join("Target/a.html").exists());
    }

    #[cfg(windows)]
    #[test]
    fn verified_cloud_move_reports_sidecar_failure_without_rollback_or_retry() {
        let (tmp, core, snapshot, root) = fixture();
        fs::create_dir_all(tmp.path().join("config")).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        crate::workspace_settings::favorite(&core, workspace, &snapshot.view_id, "a.html", true)
            .unwrap();
        let dir = core.workspace.lock().unwrap().dir.clone().unwrap();
        let preferences = tmp.path().join("config/workspace-settings").join(format!(
            "{}.json",
            knowledge::storage_root_identity(&dir).unwrap()
        ));
        let saved = fs::read(&preferences).unwrap();
        let alias = tmp.path().join("retained-preferences.json");
        fs::hard_link(&preferences, &alias).unwrap();
        // A foreign ordinary file at the required directory name is preserved.
        fs::write(
            tmp.path().join("config/tree-order"),
            b"retained order obstruction",
        )
        .unwrap();
        let content = fs::read(root.join("a.html")).unwrap();
        fs::rename(root.join("a.html"), root.join("Target/a.html")).unwrap();
        let result = publish_cloud_change(
            &core,
            workspace,
            &dir,
            "Target/a.html".into(),
            Some("a.html".into()),
            "html",
            knowledge::CloudWriteOutcome::Verified,
        )
        .unwrap();
        assert_eq!(result.moves[0].to, "Target/a.html");
        let warning = result.warning.unwrap();
        assert!(warning.contains("順序の保存先が通常フォルダーではありません"));
        assert!(warning.contains("端末設定の保存を確認できません"));
        assert_eq!(fs::read(&preferences).unwrap(), saved);
        assert_eq!(fs::read(&alias).unwrap(), saved);
        assert_eq!(
            fs::read(tmp.path().join("config/tree-order")).unwrap(),
            b"retained order obstruction"
        );
        assert_eq!(fs::read(root.join("Target/a.html")).unwrap(), content);
        assert!(!root.join("a.html").exists());
        let retained =
            crate::workspace_settings::get(&core, workspace, &snapshot.view_id, false).unwrap();
        assert!(retained.read_only);
        assert!(retained
            .favorites
            .iter()
            .any(|entry| entry.document.relative_path == "Target/a.html"));
        assert!(crate::workspace_settings::flush_locked(&core).is_err());
        assert_eq!(fs::read(&preferences).unwrap(), saved);
        assert!(fs::read_dir(preferences.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".my-knowledge-")));
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "creates and moves only new synthetic items in an approved disposable OneDrive fixture"]
    fn disposable_onedrive_product_namespace_writes() {
        let root = PathBuf::from(
            std::env::var_os("MOGLEDGE_ONEDRIVE_PROBE_FIXTURE").expect("approved fixture required"),
        );
        assert!(root
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Mogledge-OneDrive-QA-072-"));
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::new(19200);
        let profile = tmp.path().join("config/settings.json");
        core.settings_path.set(profile.clone()).unwrap();
        let snapshot = core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        fs::create_dir_all(profile.parent().unwrap()).unwrap();
        fs::write(&profile, "untouched test sentinel").unwrap();
        let (selected_root, selected_dir) = {
            let state = core.workspace.lock().unwrap();
            (state.root.clone().unwrap(), state.dir.clone().unwrap())
        };
        let source = knowledge::read_source_with_identity(
            &selected_root,
            &selected_dir,
            "target/probe-moved.html",
        )
        .unwrap();
        let before = serde_json::to_value(&snapshot.nodes).unwrap();
        let settings = serde_json::to_value(
            crate::workspace_settings::get(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                false,
            )
            .unwrap(),
        )
        .unwrap();
        let name = format!("product-{:016x}", rand::random::<u64>());
        let result = run(&core, &snapshot, folder("", &name)).unwrap();
        assert!(result.warning.is_none(), "{:?}", result.warning);
        assert!(result.created_path.is_none());
        assert!(result
            .snapshot
            .nodes
            .iter()
            .any(|node| node.kind == "folder"
                && node.relative_path == name
                && node.children.is_empty()));
        let existing: Vec<_> = result
            .snapshot
            .nodes
            .iter()
            .filter(|node| node.relative_path != name)
            .cloned()
            .collect();
        assert_eq!(serde_json::to_value(existing).unwrap(), before);
        assert_eq!(
            serde_json::to_value(
                crate::workspace_settings::get(
                    &core,
                    snapshot.workspace_id.as_ref().unwrap(),
                    &snapshot.view_id,
                    false
                )
                .unwrap()
            )
            .unwrap(),
            settings
        );
        assert_eq!(fs::read(&profile).unwrap(), b"untouched test sentinel");
        let unchanged = knowledge::read_source_with_identity(
            &selected_root,
            &selected_dir,
            "target/probe-moved.html",
        )
        .unwrap();
        assert_eq!(unchanged.data, source.data);
        assert_eq!(unchanged.storage_identity, source.storage_identity);
        assert!(knowledge::scan(&root.join(&name)).unwrap().is_empty());
        assert!(run(&core, &snapshot, folder("", &name)).is_err());
        let nested = run(&core, &snapshot, folder(&name, "nested")).unwrap();
        assert!(nested.warning.is_none(), "{:?}", nested.warning);
        let destination = join(&name, "nested");
        let document = run(&core, &snapshot, html(&name, "Unicode-日本語&title")).unwrap();
        assert!(document.warning.is_none(), "{:?}", document.warning);
        let html_path = document.created_path.unwrap();
        let original =
            knowledge::read_source_with_identity(&selected_root, &selected_dir, &html_path)
                .unwrap();
        assert!(original
            .data
            .windows(b"Unicode-".len())
            .any(|bytes| bytes == b"Unicode-"));
        assert!(original
            .data
            .windows(b"&amp;title".len())
            .any(|bytes| bytes == b"&amp;title"));
        assert!(run(&core, &snapshot, html(&name, "Unicode-日本語&title")).is_err());
        crate::workspace_settings::favorite(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            &html_path,
            true,
        )
        .unwrap();
        let source_tab = core
            .create_tab(
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                &html_path,
            )
            .unwrap();
        let source_url = core
            .open(
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                &source_tab,
                1,
            )
            .unwrap();
        let renamed = run(
            &core,
            &snapshot,
            Mutation::RenameHtml {
                source: html_path.clone(),
                name: "renamed".into(),
            },
        )
        .unwrap();
        assert!(renamed.warning.is_none(), "{:?}", renamed.warning);
        assert!(core.session_for_token(token(&source_url)).is_none());
        let renamed_path = renamed.moves[0].to.clone();
        let moved = run(&core, &snapshot, moving(&renamed_path, &destination)).unwrap();
        assert!(moved.warning.is_none(), "{:?}", moved.warning);
        let moved_path = moved.moves[0].to.clone();
        let retained =
            knowledge::read_source_with_identity(&selected_root, &selected_dir, &moved_path)
                .unwrap();
        assert_eq!(retained.data, original.data);
        assert_eq!(retained.storage_identity, original.storage_identity);
        // A provider-converted resident parent is a distinct case from freshly
        // created ordinary descendants. Touch only this new synthetic leaf.
        let unique = format!("{name}.html");
        let root_document = run(&core, &snapshot, html("", &unique)).unwrap();
        assert!(
            root_document.warning.is_none(),
            "{:?}",
            root_document.warning
        );
        let root_path = root_document.created_path.unwrap();
        let root_source =
            knowledge::read_source_with_identity(&selected_root, &selected_dir, &root_path)
                .unwrap();
        let converted = run(&core, &snapshot, moving(&root_path, "target")).unwrap();
        assert!(converted.warning.is_none(), "{:?}", converted.warning);
        let converted_path = converted.moves[0].to.clone();
        let reopened =
            knowledge::read_source_with_identity(&selected_root, &selected_dir, &converted_path)
                .unwrap();
        assert_eq!(reopened.data, root_source.data);
        assert_eq!(reopened.storage_identity, root_source.storage_identity);
        let returned = run(&core, &snapshot, moving(&converted_path, &destination)).unwrap();
        assert!(returned.warning.is_none(), "{:?}", returned.warning);
        let reopened = knowledge::read_source_with_identity(
            &selected_root,
            &selected_dir,
            &returned.moves[0].to,
        )
        .unwrap();
        assert_eq!(reopened.storage_identity, root_source.storage_identity);
        let empty = run(&core, &snapshot, folder(&name, "empty")).unwrap();
        assert!(empty.warning.is_none());
        let moved_folder = run(
            &core,
            &snapshot,
            moving(&join(&name, "empty"), &destination),
        )
        .unwrap();
        assert!(moved_folder.warning.is_none(), "{:?}", moved_folder.warning);
        assert!(run(&core, &snapshot, moving(&name, "target")).is_err());
        assert!(run(&core, &snapshot, moving(&destination, "target")).is_err());
        assert!(run(&core, &snapshot, folder("../escape", "bad")).is_err());
        assert_eq!(fs::read(&profile).unwrap(), b"untouched test sentinel");
        let unchanged = knowledge::read_source_with_identity(
            &selected_root,
            &selected_dir,
            "target/probe-moved.html",
        )
        .unwrap();
        assert_eq!(unchanged.data, source.data);
        assert_eq!(unchanged.storage_identity, source.storage_identity);
        let restart = Core::new(19201);
        restart.settings_path.set(profile.clone()).unwrap();
        let restored = restart.select(&root, false).unwrap();
        restart.watcher.lock().unwrap().take();
        let restored_settings = crate::workspace_settings::get(
            &restart,
            restored.workspace_id.as_ref().unwrap(),
            &restored.view_id,
            false,
        )
        .unwrap();
        assert!(restored_settings
            .favorites
            .iter()
            .any(|entry| entry.document.relative_path == moved_path
                && Some(&entry.document.identity) == original.storage_identity.as_ref()));
        assert_eq!(
            tree_order::children(&restored.nodes, &name)
                .unwrap()
                .iter()
                .map(|node| &node.name)
                .collect::<Vec<_>>(),
            tree_order::children(&core.snapshot().nodes, &name)
                .unwrap()
                .iter()
                .map(|node| &node.name)
                .collect::<Vec<_>>()
        );
        assert!(knowledge::validate_cache_path(&root).is_err());
        assert!(LockedDir::open(core.workspace.lock().unwrap().dir.as_ref().unwrap(), "").is_err());
        println!("product nested/HTML creation, rename, HTML/empty-folder move and FileID verified; collision/nonempty/escape rejected; source/profile preserved; subtree {name}");
    }
    #[test]
    fn ordinary_watch_events_without_matching_echo_do_not_probe_file_metadata() {
        let (_tmp, core, _snapshot, _root) = fixture();
        let mut state = core.workspace.lock().unwrap();
        let paths = vec!["a.html".into(), "Folder/nested.html".into()];
        let mut probes = 0;
        let output = filter_echoes_with(&mut state, paths.clone(), |_, _| {
            probes += 1;
            Err(())
        });
        assert_eq!(output, paths);
        assert_eq!(probes, 0);
        state.mutation_echoes.push(Echo {
            path: "unrelated.html".into(),
            value: None,
            expires: Instant::now() + Duration::from_secs(1),
        });
        let output = filter_echoes_with(&mut state, paths.clone(), |_, _| {
            probes += 1;
            Err(())
        });
        assert_eq!(output, paths);
        assert_eq!(probes, 0);
        state.mutation_echoes.push(Echo {
            path: "a.html".into(),
            value: None,
            expires: Instant::now() + Duration::from_secs(1),
        });
        let output = filter_echoes_with(&mut state, paths.clone(), |_, _| {
            probes += 1;
            Err(())
        });
        assert_eq!(output, paths);
        assert_eq!(probes, 1);
        assert!(state
            .mutation_echoes
            .iter()
            .all(|echo| echo.path != "a.html"));
    }

    fn run(
        core: &Arc<Core>,
        snapshot: &Snapshot,
        mutation: Mutation,
    ) -> Result<MutationResult, String> {
        perform(
            core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            mutation,
        )
    }
    fn html(parent: &str, name: &str) -> Mutation {
        Mutation::CreateHtml {
            parent: parent.into(),
            name: name.into(),
        }
    }
    fn folder(parent: &str, name: &str) -> Mutation {
        Mutation::CreateFolder {
            parent: parent.into(),
            name: name.into(),
        }
    }
    fn moving(source: &str, parent: &str) -> Mutation {
        Mutation::Move {
            source: source.into(),
            parent: parent.into(),
            anchor: None,
            after: false,
        }
    }
    fn reorder(source: &str, anchor: &str, after: bool) -> Mutation {
        Mutation::Reorder {
            source: source.into(),
            anchor: anchor.into(),
            after,
        }
    }
    fn rename(source: &str, name: &str) -> Mutation {
        Mutation::RenameHtml {
            source: source.into(),
            name: name.into(),
        }
    }
    fn names(nodes: &[knowledge::TreeNode]) -> Vec<&str> {
        nodes.iter().map(|node| node.name.as_str()).collect()
    }
    fn token(url: &str) -> &str {
        url.split("/s/").nth(1).unwrap().split('/').next().unwrap()
    }
    #[test]
    fn rename_preserves_extension_contents_order_and_revokes_only_affected_grants() {
        for extension in ["html", "HTM", "HtMl"] {
            let (tmp, core, snapshot, root) = fixture();
            let source = format!("Folder/日本語.{extension}");
            fs::write(root.join(&source), "<a href=\"../a.html\">本文</a>").unwrap();
            core.refresh().unwrap();
            core.watcher.lock().unwrap().take();
            let ws = snapshot.workspace_id.as_ref().unwrap();
            let tab = core.create_tab(ws, &snapshot.view_id, &source).unwrap();
            let (browser, browser_request) =
                core.browser_tab(ws, &snapshot.view_id, &source).unwrap();
            let other = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
            let url = core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
            let browser_url = core
                .open(ws, &snapshot.view_id, &browser, browser_request)
                .unwrap();
            let other_url = core.open(ws, &snapshot.view_id, &other, 1).unwrap();
            run(
                &core,
                &snapshot,
                reorder(&source, "Folder/nested.html", false),
            )
            .unwrap();
            let original = fs::read(root.join(&source)).unwrap();
            let result = run(&core, &snapshot, rename(&source, "新しい😀名前")).unwrap();
            let destination = format!("Folder/新しい😀名前.{extension}");
            assert!(!root.join(&source).exists());
            assert_eq!(fs::read(root.join(&destination)).unwrap(), original);
            assert_eq!(result.moves.len(), 1);
            assert_eq!(result.moves[0].from, source);
            assert_eq!(result.moves[0].to, destination);
            assert_eq!(core.workspace.lock().unwrap().tabs[&tab].entry, destination);
            assert_eq!(
                core.workspace.lock().unwrap().tabs[&browser].entry,
                destination
            );
            assert!(core.session_for_token(token(&url)).is_none());
            assert!(core.session_for_token(token(&browser_url)).is_none());
            assert!(core.session_for_token(token(&other_url)).is_some());
            assert_eq!(
                names(tree_order::children(&result.snapshot.nodes, "Folder").unwrap()),
                [format!("新しい😀名前.{extension}"), "nested.html".into()]
            );
            let restart = Core::new(19201);
            restart
                .settings_path
                .set(tmp.path().join("config/settings.json"))
                .unwrap();
            let restored = restart.select(&root, false).unwrap();
            restart.watcher.lock().unwrap().take();
            assert_eq!(
                names(tree_order::children(&restored.nodes, "Folder").unwrap()),
                names(tree_order::children(&result.snapshot.nodes, "Folder").unwrap())
            );
        }
    }
    #[test]
    fn rename_keeps_default_visual_position_after_refresh() {
        let (_tmp, core, snapshot, _root) = fixture();
        let result = run(&core, &snapshot, rename("a.html", "z")).unwrap();
        assert_eq!(
            names(&result.snapshot.nodes),
            ["Folder", "Target", "z.html", "b.html", "c.html"]
        );
        let refreshed = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        assert_eq!(names(&refreshed.nodes), names(&result.snapshot.nodes));
    }
    #[test]
    fn rename_noop_and_rejections_leave_original_grants_and_snapshot_unchanged() {
        let (_tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        let tab = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
        let url = core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = run(&core, &snapshot, rename("a.html", "a")).unwrap();
        assert!(result.moves.is_empty());
        assert_eq!(result.snapshot.revision, snapshot.revision);
        for name in [
            "A", "b", "B", "", ".hidden", "../x", "a/b", "a\\b", "x:y", "CON", "LPT9", "a.", "a ",
            "a\0b",
        ] {
            assert!(
                run(&core, &snapshot, rename("a.html", name)).is_err(),
                "{name}"
            );
        }
        for source in ["Folder", "", "missing.html", "../a.html", "C:/a.html"] {
            assert!(
                run(&core, &snapshot, rename(source, "new")).is_err(),
                "{source}"
            );
        }
        assert!(perform(&core, "old", &snapshot.view_id, rename("a.html", "new")).is_err());
        assert!(perform(&core, ws, "old", rename("a.html", "new")).is_err());
        assert_eq!(fs::read(root.join("a.html")).unwrap(), original);
        assert_eq!(core.snapshot().revision, snapshot.revision);
        assert!(core.session_for_token(token(&url)).is_some());
        assert!(core.workspace.lock().unwrap().order.parents.is_empty());
        assert!(serde_json::from_str::<Mutation>(
            r#"{"kind":"renameHtml","source":"a.html","name":"new","parent":""}"#
        )
        .is_err());
    }
    #[test]
    fn rename_rechecks_destination_after_external_creation_without_overwrite() {
        let (_tmp, core, snapshot, root) = fixture();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = perform_with(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            rename("a.html", "new"),
            || {
                fs::write(root.join("NEW.HTML"), "external writer").unwrap();
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(root.join("a.html")).unwrap(), original);
        assert_eq!(fs::read(root.join("NEW.HTML")).unwrap(), b"external writer");
    }
    #[test]
    fn rename_sidecar_failure_keeps_committed_original_and_reports_warning() {
        let (tmp, core, snapshot, root) = fixture();
        fs::write(tmp.path().join("config"), "blocked directory").unwrap();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = run(&core, &snapshot, rename("a.html", "new")).unwrap();
        assert!(result.warning.unwrap().contains("名前変更は完了"));
        assert_eq!(fs::read(root.join("new.html")).unwrap(), original);
        assert!(!root.join("a.html").exists());
        assert!(knowledge::contains(&result.snapshot.nodes, "new.html"));
        assert_eq!(result.moves[0].to, "new.html");
    }
    #[cfg(unix)]
    #[test]
    fn rename_rejects_source_replacement_between_validation_and_execution() {
        let (_tmp, core, snapshot, root) = fixture();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = perform_with(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            rename("a.html", "new"),
            || {
                fs::rename(root.join("a.html"), root.join("saved.html")).unwrap();
                fs::write(root.join("a.html"), "replacement").unwrap();
            },
        );
        assert!(result.is_err());
        assert!(!root.join("new.html").exists());
        assert_eq!(fs::read(root.join("a.html")).unwrap(), b"replacement");
        assert_eq!(fs::read(root.join("saved.html")).unwrap(), original);
    }
    #[test]
    fn creates_complete_unicode_html_and_folder_without_overwriting() {
        let (_tmp, core, snapshot, root) = fixture();
        let result = run(&core, &snapshot, folder("", "日本語 & folder")).unwrap();
        assert!(result.created_path.is_none());
        let result = run(&core, &snapshot, html("日本語 & folder", "My ' title #%")).unwrap();
        let path = result.created_path.unwrap();
        assert_eq!(path, "日本語 & folder/My ' title #%.html");
        let data = fs::read_to_string(root.join(&path)).unwrap();
        for text in [
            "<!doctype html>",
            "charset=\"utf-8\"",
            "<title>",
            "<body>",
            "</html>",
        ] {
            assert!(data.contains(text));
        }
        assert!(knowledge::contains(&result.snapshot.nodes, &path));
        let previous = fs::read(root.join("a.html")).unwrap();
        assert!(run(&core, &snapshot, html("", "A.HTML")).is_err());
        assert_eq!(fs::read(root.join("a.html")).unwrap(), previous);
        assert!(run(&core, &snapshot, folder("", "TARGET")).is_err());
        assert!(!fs::read_dir(root.join("日本語 & folder"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.')));
    }
    #[test]
    fn invalid_names_extensions_paths_and_old_contexts_cannot_write() {
        let (_tmp, core, snapshot, root) = fixture();
        for name in [
            "",
            ".hidden",
            ".my-knowledge-0123456789abcdef.tmp",
            "../outside",
            "a/b",
            "a\\b",
            "x:y",
            "CON",
            "COM0",
            "LPT0.html",
            "COM¹.txt",
            "LPT9",
            "a.",
            "a ",
            "a\0b",
            "line\nend",
        ] {
            assert!(run(&core, &snapshot, html("", name)).is_err(), "{name}");
        }
        for parent in ["../", "/", "file:///", "C:/", "missing"] {
            assert!(run(&core, &snapshot, folder(parent, "New")).is_err());
        }
        let list = fs::read_dir(&root).unwrap().count();
        assert!(perform(&core, "old", &snapshot.view_id, html("", "New")).is_err());
        assert!(perform(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            "old",
            html("", "New")
        )
        .is_err());
        assert_eq!(fs::read_dir(root).unwrap().count(), list);
        assert!(
            serde_json::from_str::<Mutation>("{\"kind\":\"remove\",\"source\":\"a.html\"}")
                .is_err()
        );
        assert!(serde_json::from_str::<Mutation>(
            "{\"kind\":\"createHtml\",\"parent\":\"\",\"name\":\"x\",\"absolutePath\":\"x\"}"
        )
        .is_err());
    }
    #[test]
    fn reorder_persists_across_refresh_restart_and_retains_external_children() {
        let (tmp, core, snapshot, root) = fixture();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = run(&core, &snapshot, reorder("c.html", "a.html", false)).unwrap();
        assert_eq!(result.snapshot.scan_duration_ms, 0.0);
        assert_eq!(
            names(&result.snapshot.nodes),
            ["Folder", "Target", "c.html", "a.html", "b.html"]
        );
        fs::write(root.join("new.html"), "external").unwrap();
        core.apply_change(
            snapshot.workspace_id.as_ref().unwrap(),
            vec!["new.html".into()],
            true,
            None,
        );
        assert_eq!(
            names(&core.snapshot().nodes),
            ["Folder", "Target", "c.html", "a.html", "b.html", "new.html"]
        );
        assert_eq!(fs::read(root.join("a.html")).unwrap(), original);
        let refreshed = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        assert_eq!(names(&refreshed.nodes), names(&core.snapshot().nodes));
        let restart = Core::new(19201);
        restart
            .settings_path
            .set(tmp.path().join("config/settings.json"))
            .unwrap();
        let restored = restart.select(&root, false).unwrap();
        restart.watcher.lock().unwrap().take();
        assert_eq!(names(&restored.nodes), names(&core.snapshot().nodes));
        let size: usize = fs::read_dir(tmp.path().join("config/tree-order"))
            .unwrap()
            .map(|entry| fs::metadata(entry.unwrap().path()).unwrap().len() as usize)
            .sum();
        assert!(size < 1024);
    }
    #[test]
    fn move_file_and_folder_follow_all_descendant_tabs_and_revoke_only_moved_grants() {
        let (_tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        let ids: Vec<_> = ["a.html", "Folder/nested.html", "b.html"]
            .iter()
            .map(|path| core.create_tab(ws, &snapshot.view_id, path).unwrap())
            .collect();
        let urls: Vec<_> = ids
            .iter()
            .map(|id| core.open(ws, &snapshot.view_id, id, 1).unwrap())
            .collect();
        let original = fs::read(root.join("a.html")).unwrap();
        let result = run(&core, &snapshot, moving("a.html", "Target")).unwrap();
        assert_eq!(result.moves[0].to, "Target/a.html");
        assert!(!root.join("a.html").exists());
        assert_eq!(fs::read(root.join("Target/a.html")).unwrap(), original);
        assert!(core.session_for_token(token(&urls[0])).is_none());
        assert!(core.session_for_token(token(&urls[2])).is_some());
        run(&core, &snapshot, moving("Folder", "Target")).unwrap();
        assert_eq!(
            core.workspace.lock().unwrap().tabs[&ids[1]].entry,
            "Target/Folder/nested.html"
        );
        assert!(core.session_for_token(token(&urls[1])).is_none());
        assert!(core
            .open(ws, &snapshot.view_id, &ids[1], 2)
            .unwrap()
            .contains("/Target/Folder/nested%2Ehtml"));
    }
    #[test]
    fn failed_move_keeps_source_tabs_grants_and_order_unchanged() {
        let (_tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        let tab = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
        let url = core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
        fs::write(root.join("Target/A.HTML"), "do not overwrite").unwrap();
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        assert!(root.join("a.html").is_file());
        assert_eq!(
            fs::read_to_string(root.join("Target/A.HTML")).unwrap(),
            "do not overwrite"
        );
        assert!(core.session_for_token(token(&url)).is_some());
        assert_eq!(core.workspace.lock().unwrap().tabs[&tab].entry, "a.html");
        assert!(core.workspace.lock().unwrap().order.parents.is_empty());
        for request in [
            moving("", "Target"),
            moving("Folder", "Folder"),
            moving("Folder", "Folder/sub"),
            moving("a.html", ""),
        ] {
            assert!(run(&core, &snapshot, request).is_err());
        }
    }
    #[test]
    fn sidecar_failure_after_move_reports_partial_success_and_rescans_without_rollback() {
        let (tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        let tab = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
        let url = core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
        fs::write(tmp.path().join("config"), "blocked directory").unwrap();
        let result = run(&core, &snapshot, moving("a.html", "Target")).unwrap();
        assert!(result.warning.unwrap().contains("移動は完了"));
        assert!(root.join("Target/a.html").is_file());
        assert!(!root.join("a.html").exists());
        assert!(knowledge::contains(&result.snapshot.nodes, "Target/a.html"));
        assert_eq!(
            core.workspace.lock().unwrap().tabs[&tab].entry,
            "Target/a.html"
        );
        assert!(core.session_for_token(token(&url)).is_none());
        let before = names(&result.snapshot.nodes);
        let result = run(&core, &snapshot, reorder("c.html", "b.html", false)).unwrap();
        assert!(result.warning.unwrap().contains("適用せず"));
        assert_eq!(names(&result.snapshot.nodes), before);
    }
    #[test]
    fn duplicate_native_watch_notifications_do_not_revoke_or_reload_again_but_external_updates_do()
    {
        let (_tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        run(&core, &snapshot, moving("a.html", "Target")).unwrap();
        let revision = core.snapshot().revision;
        core.apply_change(
            ws,
            vec!["a.html".into(), "Target/a.html".into()],
            true,
            None,
        );
        assert_eq!(core.snapshot().revision, revision);
        fs::write(
            root.join("Target/a.html"),
            "externally changed with a different size",
        )
        .unwrap();
        core.apply_change(ws, vec!["Target/a.html".into()], false, None);
        assert!(core.snapshot().revision > revision);
    }
    #[test]
    fn an_observed_external_recreation_invalidates_the_old_missing_path_echo() {
        for scan in ["event", "refresh", "forced"] {
            let (_tmp, core, snapshot, root) = fixture();
            let ws = snapshot.workspace_id.as_ref().unwrap();
            run(&core, &snapshot, moving("a.html", "Target")).unwrap();
            fs::write(root.join("a.html"), "external recreation").unwrap();
            match scan {
                "event" => core.apply_change(ws, vec!["a.html".into()], true, None),
                "refresh" => {
                    core.refresh().unwrap();
                    core.watcher.lock().unwrap().take();
                }
                _ => core.apply_rescan(ws, vec!["a.html".into()], None),
            }
            assert!(knowledge::contains(&core.snapshot().nodes, "a.html"));
            let tab = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
            let url = core.open(ws, &snapshot.view_id, &tab, 1).unwrap();
            fs::remove_file(root.join("a.html")).unwrap();
            core.apply_change(ws, vec!["a.html".into()], true, None);
            assert!(!knowledge::contains(&core.snapshot().nodes, "a.html"));
            assert!(core.session_for_token(token(&url)).is_none());
        }
    }
    #[test]
    fn cross_folder_anchor_persists_drop_position_without_changing_contents() {
        let (_tmp, core, snapshot, root) = fixture();
        fs::write(root.join("Target/first.html"), "first").unwrap();
        fs::write(root.join("Target/last.html"), "last").unwrap();
        core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        let before = fs::read(root.join("a.html")).unwrap();
        let result = run(
            &core,
            &snapshot,
            Mutation::Move {
                source: "a.html".into(),
                parent: "Target".into(),
                anchor: Some("Target/first.html".into()),
                after: true,
            },
        )
        .unwrap();
        assert_eq!(
            names(tree_order::children(&result.snapshot.nodes, "Target").unwrap()),
            ["first.html", "a.html", "last.html"]
        );
        assert_eq!(fs::read(root.join("Target/a.html")).unwrap(), before);
        let next = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        assert_eq!(
            names(tree_order::children(&next.nodes, "Target").unwrap()),
            ["first.html", "a.html", "last.html"]
        );
    }
    #[test]
    fn moved_order_overrides_stale_destination_subtree_settings() {
        let mut order = tree_order::Order::default();
        order
            .parents
            .insert("A".into(), vec!["b.html".into(), "a.html".into()]);
        order
            .parents
            .insert("Target/A".into(), vec!["a.html".into(), "b.html".into()]);
        order
            .parents
            .insert("Target/A/old".into(), vec!["stale.html".into()]);
        tree_order::remap(&mut order, "A", "Target/A");
        assert_eq!(order.parents["Target/A"], ["b.html", "a.html"]);
        assert!(!order.parents.contains_key("Target/A/old"));
    }
    #[test]
    fn registration_waits_for_the_mutation_snapshot_commit() {
        let (_tmp, core, snapshot, _root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap().clone();
        let view = snapshot.view_id.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let other = core.clone();
        let result = perform_with(&core, &ws, &view, moving("a.html", "Target"), || {
            let ws = ws.clone();
            let view = view.clone();
            std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                result_tx
                    .send(other.create_tab(&ws, &view, "a.html"))
                    .unwrap();
            });
            started_rx.recv().unwrap();
            assert!(result_rx.try_recv().is_err());
        })
        .unwrap();
        assert!(result_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err());
        assert!(knowledge::contains(&result.snapshot.nodes, "Target/a.html"));
    }
    #[test]
    fn forced_watch_rescan_is_not_suppressed_by_a_matching_echo() {
        let (_tmp, core, snapshot, root) = fixture();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        run(&core, &snapshot, moving("a.html", "Target")).unwrap();
        fs::write(root.join("external.html"), "external").unwrap();
        core.apply_rescan(ws, vec!["Target/a.html".into()], None);
        assert!(knowledge::contains(&core.snapshot().nodes, "external.html"));
    }
    #[test]
    #[ignore = "explicit 10001-file performance run, not a correctness threshold"]
    fn large_tree_mutation_measurements() {
        let (tmp, core, _snapshot, root) = fixture();
        for index in 0..10000 {
            fs::write(
                root.join("Folder").join(format!("{index:05}.html")),
                "<!doctype html><meta charset=\"utf-8\"><body></body>",
            )
            .unwrap();
        }
        let start = Instant::now();
        let snapshot = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        let first_scan = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        let warm_scan = start.elapsed().as_secs_f64() * 1000.0;
        let mut reorder_times = Vec::new();
        let mut reorder_scan_ms = Vec::new();
        for _ in 0..10 {
            let start = Instant::now();
            let result = run(
                &core,
                &snapshot,
                reorder("Folder/09999.html", "Folder/00000.html", false),
            )
            .unwrap();
            reorder_scan_ms.push(result.snapshot.scan_duration_ms);
            reorder_times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        let json_bytes = fs::metadata(
            fs::read_dir(tmp.path().join("config/tree-order"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path(),
        )
        .unwrap()
        .len();
        let start = Instant::now();
        run(&core, &snapshot, moving("Folder/00000.html", "Target")).unwrap();
        let move_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(reorder_scan_ms.iter().all(|duration| *duration == 0.0));
        println!(
            "ISSUE6_PERF {}",
            serde_json::json!({"html_in_folder":10001,"new_files":10000,"first_fixture_scan_ms":first_scan,"warm_scan_ms":warm_scan,"reorder_ms":reorder_times,"reorder_scan_ms":reorder_scan_ms,"move_rescan_ms":move_ms,"json_bytes":json_bytes,"profile":"debug","platform":std::env::consts::OS})
        );
    }
    #[cfg(unix)]
    #[test]
    fn root_parent_and_source_swaps_between_validation_and_execution_fail_closed() {
        for kind in ["root", "parent", "source"] {
            let (_tmp, core, snapshot, root) = fixture();
            let result = perform_with(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                moving("Folder/nested.html", "Target"),
                || match kind {
                    "root" => {
                        fs::rename(&root, root.with_file_name("old-root")).unwrap();
                        fs::create_dir(&root).unwrap();
                    }
                    "parent" => {
                        fs::rename(root.join("Folder"), root.join("old-folder")).unwrap();
                        fs::create_dir(root.join("Folder")).unwrap();
                        fs::write(root.join("Folder/nested.html"), "replacement").unwrap();
                    }
                    _ => {
                        fs::rename(
                            root.join("Folder/nested.html"),
                            root.join("Folder/old.html"),
                        )
                        .unwrap();
                        fs::write(root.join("Folder/nested.html"), "replacement").unwrap();
                    }
                },
            );
            assert!(result.is_err(), "{kind}");
            assert!(!root.join("Target/nested.html").exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_fifo_and_link_subtrees_are_rejected_without_touching_targets() {
        use std::os::unix::fs::symlink;
        let (tmp, core, snapshot, root) = fixture();
        let outside = tmp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.html"), "secret").unwrap();
        fs::remove_file(root.join("a.html")).unwrap();
        symlink(outside.join("secret.html"), root.join("a.html")).unwrap();
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        fs::remove_file(root.join("a.html")).unwrap();
        crate::test_fixtures::create_fifo(&root.join("a.html"), 0o600).unwrap();
        let start = Instant::now();
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        symlink(&outside, root.join("Folder/link")).unwrap();
        assert!(run(&core, &snapshot, moving("Folder", "Target")).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.html")).unwrap(),
            "secret"
        );
    }
    #[cfg(unix)]
    #[test]
    fn permission_failures_do_not_create_or_move_data() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, core, snapshot, root) = fixture();
        let parent = root.join("Target");
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(run(&core, &snapshot, html("Target", "New")).is_err());
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        assert!(root.join("a.html").is_file());
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(fs::read_dir(parent).unwrap().next().is_none());
    }
    #[test]
    fn atomic_rename_never_overwrites_a_destination_created_after_validation() {
        let (_tmp, core, _snapshot, root) = fixture();
        let dir = core.workspace.lock().unwrap().dir.clone().unwrap();
        let parent = LockedDir::open(&dir, "").unwrap();
        let source = write_fs::open_at(parent.dir(), "a.html", false, false, true).unwrap();
        let old = fs::read(root.join("a.html")).unwrap();
        fs::write(root.join("raced.html"), "raced writer").unwrap();
        assert!(write_fs::rename_noreplace(
            parent.dir(),
            "a.html",
            parent.dir(),
            "raced.html",
            &source
        )
        .is_err());
        assert_eq!(fs::read(root.join("a.html")).unwrap(), old);
        assert_eq!(
            fs::read_to_string(root.join("raced.html")).unwrap(),
            "raced writer"
        );
    }
    #[cfg(windows)]
    #[test]
    fn windows_junction_parents_and_subtrees_cannot_create_or_move() {
        let (tmp, core, snapshot, root) = fixture();
        let outside = tmp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.html"), "secret").unwrap();
        let link = root.join("Folder").join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "cannot create disposable junction fixture"
        );
        assert!(run(&core, &snapshot, moving("Folder", "Target")).is_err());
        assert!(root.join("Folder/nested.html").is_file());
        assert!(!root.join("Target/Folder").exists());
        fs::remove_dir(&link).unwrap();

        fs::remove_dir(root.join("Target")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("Target"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "cannot create disposable junction fixture"
        );
        assert!(run(&core, &snapshot, html("Target", "New")).is_err());
        assert!(run(&core, &snapshot, folder("Target", "New")).is_err());
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        assert!(root.join("a.html").is_file());
        assert_eq!(fs::read(outside.join("secret.html")).unwrap(), b"secret");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        fs::remove_dir(root.join("Target")).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_sharing_violation_leaves_source_and_destination_unchanged() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_tmp, core, snapshot, root) = fixture();
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(root.join("a.html"))
            .unwrap();
        assert!(run(&core, &snapshot, moving("a.html", "Target")).is_err());
        assert!(!root.join("Target/a.html").exists());
        assert!(run(&core, &snapshot, rename("a.html", "new")).is_err());
        assert!(!root.join("new.html").exists());
    }
    #[test]
    fn malformed_sidecar_falls_back_without_hiding_new_children() {
        let (tmp, core, snapshot, root) = fixture();
        run(&core, &snapshot, reorder("c.html", "a.html", false)).unwrap();
        let path = fs::read_dir(tmp.path().join("config/tree-order"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(path, "{invalid").unwrap();
        fs::write(root.join("new.html"), "new").unwrap();
        let result = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        assert!(result.watch_error.unwrap().contains("順序JSON"));
        assert!(knowledge::contains(&result.nodes, "new.html"));
    }
    #[cfg(unix)]
    #[test]
    fn sidecar_fifo_and_symlink_are_rejected_without_blocking_or_following() {
        let (tmp, core, snapshot, _root) = fixture();
        run(&core, &snapshot, reorder("c.html", "a.html", false)).unwrap();
        let path = fs::read_dir(tmp.path().join("config/tree-order"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let original = fs::read(&path).unwrap();
        let outside = tmp.path().join("outside.json");
        fs::write(&outside, &original).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(
            tree_order::load(&core, core.workspace.lock().unwrap().root.as_ref().unwrap()).is_err()
        );
        fs::remove_file(&path).unwrap();
        crate::test_fixtures::create_fifo(&path, 0o600).unwrap();
        let start = Instant::now();
        let next = core.refresh().unwrap();
        core.watcher.lock().unwrap().take();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(next.watch_error.is_some());
        assert_eq!(fs::read(outside).unwrap(), original);
    }
}
