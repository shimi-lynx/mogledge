#[cfg(windows)]
use crate::knowledge::ReadOnlyDirectoryGuard as FolderGuard;
#[cfg(not(windows))]
use crate::write_fs::LockedDir as FolderGuard;
use crate::{core::Core, knowledge, tree_order};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileAction {
    CopyPath,
    OpenFolder,
    OpenBrowser,
}

// Root actions are explicit and cannot create document/browser grants.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RootAction {
    CopyPath,
    OpenFolder,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTarget {
    pub action: FileAction,
    pub target: String,
}

// Inputs are a current workspace/view and a tree-relative HTML/folder path. Neither a
// caller-provided absolute path nor a URL/command line reaches the OS adapter.
pub(crate) fn validate(
    core: &Core,
    workspace: &str,
    view: &str,
    relative: &str,
) -> Result<(PathBuf, bool, Option<FolderGuard>), String> {
    let (root, dir, folder) = {
        let state = core.workspace.lock().unwrap();
        if state.snapshot.workspace_id.as_deref() != Some(workspace) {
            return Err("WorkspaceChanged".into());
        }
        if state.snapshot.view_id != view {
            return Err("ViewChanged".into());
        }
        let (parent, _) = crate::tree_mutations::split(relative);
        let node = tree_order::children(&state.snapshot.nodes, parent)
            .and_then(|nodes| nodes.iter().find(|node| node.relative_path == relative))
            .ok_or("対象が見つかりません")?;
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
            node.kind == "folder",
        )
    };
    let (_, current) = knowledge::open_root(&root)?;
    if !knowledge::same_directory(&dir, &current)? {
        return Err("knowledgeフォルダが置き換えられました。再走査してください".into());
    }
    let relative_path = knowledge::validate_relative(relative)?;
    // Path actions need metadata, not a content open that could acquire a
    // placeholder. Browser grants still use the shared guarded source reader.
    let folder_guard = if folder {
        #[cfg(windows)]
        let target = FolderGuard::open(&root, &dir, relative)?;
        #[cfg(not(windows))]
        let target = FolderGuard::open(&dir, relative)?;
        target.revalidate(&root, &dir)?;
        Some(target)
    } else {
        knowledge::validate_cached_path(&root, &dir, relative)?;
        None
    };
    let path = root.join(relative_path);
    Ok((path, folder, folder_guard))
}

pub fn perform(
    core: &Core,
    workspace: &str,
    view: &str,
    relative: &str,
    action: FileAction,
    execute: impl FnOnce(&ActionTarget) -> Result<(), String>,
) -> Result<(), String> {
    // Root changes and watcher rescans cannot cross validation/OS dispatch.
    let _gate = core.gate.lock().unwrap();
    let (path, folder, _folder_guard) = validate(core, workspace, view, relative)?;
    if folder && action == FileAction::OpenBrowser {
        return Err("フォルダーはブラウザーで表示できません".into());
    }
    let mut browser = None;
    let target = match action {
        FileAction::CopyPath => os_path(&path)?,
        FileAction::OpenFolder => os_path(if folder {
            &path
        } else {
            path.parent().ok_or("親フォルダを解決できません")?
        })?,
        FileAction::OpenBrowser => {
            let (tab, request) = core.browser_tab(workspace, view, relative)?;
            let url = match core.open_locked(workspace, view, &tab, request) {
                Ok(url) => url,
                Err(error) => {
                    let _ = core.close_tab_locked(workspace, view, &tab);
                    return Err(error);
                }
            };
            browser = Some(tab);
            url
        }
    };
    let result = execute(&ActionTarget { action, target });
    if result.is_err() {
        if let Some(tab) = browser {
            let _ = core.close_tab_locked(workspace, view, &tab);
        }
    }
    result
}

pub fn perform_root(
    core: &Core,
    context: &crate::ai_handoff::RootContext,
    action: RootAction,
    execute: impl FnOnce(&ActionTarget) -> Result<(), String>,
) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        if state.snapshot.workspace_id.as_deref() != Some(context.workspace_id.as_str()) {
            return Err("WorkspaceChanged".into());
        }
        if state.snapshot.view_id != context.view_id {
            return Err("ViewChanged".into());
        }
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    // Keep the operation-local root handle alive through OS dispatch; do not
    // weaken the tree-relative action route by accepting an empty relative path.
    let guard = knowledge::RootReferenceGuard::open(&root, &dir)?;
    let target = os_path(&root)?;
    guard.revalidate(&root, &dir)?;
    execute(&ActionTarget {
        action: match action {
            RootAction::CopyPath => FileAction::CopyPath,
            RootAction::OpenFolder => FileAction::OpenFolder,
        },
        target,
    })
}

pub(crate) fn os_path(path: &std::path::Path) -> Result<String, String> {
    #[cfg(windows)]
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            if !shell_component(
                name.to_str()
                    .ok_or("このパスの文字コードは利用できません")?,
            ) {
                return Err("OSで同じ対象を扱えないファイル名です".into());
            }
        }
    }
    let path = path
        .to_str()
        .ok_or("このパスの文字コードは利用できません")?;
    // Explorer/clipboard consumers expect DOS/UNC paths rather than Rust's
    // canonical verbatim prefix. This changes only the OS-facing representation.
    #[cfg(windows)]
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return Ok(format!(r"\\{unc}"));
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(path)
    };
    Ok(path.into())
}

#[cfg(any(windows, test))]
fn shell_component(name: &str) -> bool {
    if name.ends_with(['.', ' ']) || name.chars().any(|ch| ch < ' ' || "<>:\"|?*".contains(ch)) {
        return false;
    }
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str()) {
        return false;
    }
    !(base
        .strip_prefix("COM")
        .or_else(|| base.strip_prefix("LPT"))
        .is_some_and(|suffix| {
            ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix)
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_server::decode_path;
    use std::fs;
    fn root_context(snapshot: &crate::core::Snapshot) -> crate::ai_handoff::RootContext {
        crate::ai_handoff::RootContext {
            workspace_id: snapshot.workspace_id.clone().unwrap(),
            view_id: snapshot.view_id.clone(),
            target: crate::ai_handoff::RootTarget::Root,
        }
    }

    #[test]
    fn root_actions_preserve_unicode_absolute_root_and_os_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("日本語 空白 & # % (é-e\u{301}) 😀");
        fs::create_dir(&root).unwrap();
        let core = Core::new(19110);
        let snapshot = core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        let expected = os_path(&root.canonicalize().unwrap()).unwrap();
        for (action, dispatched) in [
            (RootAction::CopyPath, FileAction::CopyPath),
            (RootAction::OpenFolder, FileAction::OpenFolder),
        ] {
            let result = perform_root(&core, &root_context(&snapshot), action, |target| {
                assert_eq!(target.action, dispatched);
                assert_eq!(target.target, expected);
                assert!(
                    core.gate.try_lock().is_err(),
                    "workspace gate held through dispatch"
                );
                Err("OS rejected 日本語".into())
            });
            assert_eq!(result.unwrap_err(), "OS rejected 日本語");
        }
        assert!(perform(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            "",
            FileAction::CopyPath,
            |_| panic!("empty child path dispatched")
        )
        .is_err());
    }

    #[test]
    fn root_actions_reject_empty_stale_workspace_and_view_without_dispatch() {
        let core = Core::new(19111);
        let mut context = crate::ai_handoff::RootContext {
            workspace_id: String::new(),
            view_id: String::new(),
            target: crate::ai_handoff::RootTarget::Root,
        };
        assert!(
            perform_root(&core, &context, RootAction::CopyPath, |_| panic!(
                "empty dispatched"
            ))
            .is_err()
        );
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = core.select(tmp.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        context = root_context(&snapshot);
        context.workspace_id = "stale".into();
        assert_eq!(
            perform_root(&core, &context, RootAction::CopyPath, |_| panic!(
                "stale workspace dispatched"
            ))
            .unwrap_err(),
            "WorkspaceChanged"
        );
        context = root_context(&snapshot);
        core.begin_view();
        assert_eq!(
            perform_root(&core, &context, RootAction::OpenFolder, |_| panic!(
                "stale view dispatched"
            ))
            .unwrap_err(),
            "ViewChanged"
        );
    }

    #[cfg(unix)]
    #[test]
    fn root_actions_reject_deleted_replaced_and_symlink_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("日本語 root");
        fs::create_dir(&root).unwrap();
        let core = Core::new(19112);
        let snapshot = core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        let context = root_context(&snapshot);
        fs::rename(&root, tmp.path().join("old")).unwrap();
        assert!(
            perform_root(&core, &context, RootAction::CopyPath, |_| panic!(
                "deleted dispatched"
            ))
            .is_err()
        );
        fs::create_dir(&root).unwrap();
        assert!(
            perform_root(&core, &context, RootAction::OpenFolder, |_| panic!(
                "replacement dispatched"
            ))
            .is_err()
        );
        fs::remove_dir(&root).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("old"), &root).unwrap();
        assert!(
            perform_root(&core, &context, RootAction::CopyPath, |_| panic!(
                "symlink dispatched"
            ))
            .is_err()
        );
    }

    #[test]
    fn root_action_payload_cannot_supply_browser_command_or_path() {
        assert!(serde_json::from_str::<RootAction>(r#""openBrowser""#).is_err());
        assert!(serde_json::from_str::<RootAction>(r#""shell""#).is_err());
        let valid = serde_json::json!({"workspaceId":"w","viewId":"v","target":"root"});
        assert!(serde_json::from_value::<crate::ai_handoff::RootContext>(valid.clone()).is_ok());
        for field in ["absolutePath", "relativePath", "url", "command"] {
            let mut payload = valid.clone();
            payload[field] = serde_json::json!("arbitrary");
            assert!(serde_json::from_value::<crate::ai_handoff::RootContext>(payload).is_err());
        }
        assert!(serde_json::from_value::<crate::ai_handoff::RootContext>(
            serde_json::json!({"workspaceId":"w","viewId":"v"})
        )
        .is_err());
    }

    #[test]
    fn unicode_file_and_folder_copy_targets_preserve_actual_path_names() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = "日本語 空白 & # % (é-e\u{301}) 😀";
        let file = "日本語 é e\u{301} 😀.html";
        fs::create_dir(tmp.path().join(folder)).unwrap();
        fs::write(tmp.path().join(folder).join(file), "fixture").unwrap();
        let core = Core::new(19107);
        let snapshot = core.select(tmp.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        for relative in [folder.to_owned(), format!("{folder}/{file}")] {
            let expected = fs::canonicalize(tmp.path().join(&relative)).unwrap();
            let expected = expected.to_str().unwrap();
            #[cfg(windows)]
            let expected = expected.strip_prefix(r"\\?\").unwrap_or(expected);
            let error = perform(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                &relative,
                FileAction::CopyPath,
                |target| {
                    assert_eq!(target.target, expected);
                    Err("clipboard rejected".into())
                },
            )
            .expect_err("OS rejection must propagate");
            assert_eq!(error, "clipboard rejected");
            assert_eq!(
                fs::read(tmp.path().join(folder).join(file)).unwrap(),
                b"fixture"
            );
        }
    }
    #[test]
    fn folder_actions_dispatch_the_folder_itself_without_browser_grants() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("日本語 & folder/child")).unwrap();
        let core = Core::new(19106);
        let snapshot = core.select(tmp.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        for action in [FileAction::CopyPath, FileAction::OpenFolder] {
            perform(
                &core,
                workspace,
                &snapshot.view_id,
                "日本語 & folder",
                action,
                |target| {
                    assert_eq!(
                        target.target,
                        os_path(&tmp.path().join("日本語 & folder").canonicalize().unwrap())
                            .unwrap()
                    );
                    Ok(())
                },
            )
            .unwrap();
        }
        assert!(perform(
            &core,
            workspace,
            &snapshot.view_id,
            "日本語 & folder",
            FileAction::OpenBrowser,
            |_| panic!("folder browser dispatched")
        )
        .is_err());
        assert!(perform(
            &core,
            workspace,
            &snapshot.view_id,
            "",
            FileAction::OpenFolder,
            |_| panic!("root dispatched")
        )
        .is_err());
        fs::rename(tmp.path().join("日本語 & folder"), tmp.path().join("old")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(tmp.path().join("old"), tmp.path().join("日本語 & folder"))
            .unwrap();
        assert!(perform(
            &core,
            workspace,
            &snapshot.view_id,
            "日本語 & folder",
            FileAction::OpenFolder,
            |_| panic!("missing/link folder dispatched")
        )
        .is_err());
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn folder_dispatch_retains_read_locks_until_the_os_adapter_returns() {
        let fixture = tempfile::tempdir().unwrap();
        fs::create_dir_all(fixture.path().join("folder/nested")).unwrap();
        let core = Core::new(19108);
        let snapshot = core.select(fixture.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        for action in [FileAction::CopyPath, FileAction::OpenFolder] {
            perform(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                "folder/nested",
                action,
                |_| {
                    for (source, target) in [("folder", "replaced"), ("folder/nested", "moved")] {
                        let error =
                            fs::rename(fixture.path().join(source), fixture.path().join(target))
                                .unwrap_err();
                        assert_eq!(error.raw_os_error(), Some(32));
                    }
                    Ok(())
                },
            )
            .unwrap();
        }
        fs::rename(
            fixture.path().join("folder/nested"),
            fixture.path().join("moved"),
        )
        .unwrap();
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[test]
    fn actions_use_exact_validated_paths_and_independent_browser_grants() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("日本語 & folder")).unwrap();
        let entry = "日本語 & folder/a ' #%.html";
        fs::write(tmp.path().join(entry), "<h1>ok</h1>").unwrap();
        let core = Core::new(19100);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        perform(
            &core,
            workspace,
            &snapshot.view_id,
            entry,
            FileAction::CopyPath,
            |target| {
                assert_eq!(
                    target.target,
                    os_path(&tmp.path().join(entry).canonicalize().unwrap()).unwrap()
                );
                Ok(())
            },
        )
        .unwrap();
        perform(
            &core,
            workspace,
            &snapshot.view_id,
            entry,
            FileAction::OpenFolder,
            |target| {
                assert_eq!(
                    target.target,
                    os_path(&tmp.path().join("日本語 & folder").canonicalize().unwrap()).unwrap()
                );
                Ok(())
            },
        )
        .unwrap();
        let tab = core
            .create_tab(workspace, &snapshot.view_id, entry)
            .unwrap();
        let ui = core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
        let mut first = String::new();
        perform(
            &core,
            workspace,
            &snapshot.view_id,
            entry,
            FileAction::OpenBrowser,
            |target| {
                first = target.target.clone();
                let (_, path) = decode_path(first.strip_prefix(&core.origin).unwrap()).unwrap();
                assert_eq!(path, entry);
                Ok(())
            },
        )
        .unwrap();
        perform(
            &core,
            workspace,
            &snapshot.view_id,
            entry,
            FileAction::OpenBrowser,
            |_| Ok(()),
        )
        .unwrap();
        let token = |url: &str| {
            decode_path(url.strip_prefix(&core.origin).unwrap())
                .unwrap()
                .0
        };
        assert!(core.session_for_token(&token(&first)).is_none());
        assert!(core.session_for_token(&token(&ui)).is_some());
        assert_eq!(core.workspace.lock().unwrap().tabs.len(), 2);
        core.close_tab(workspace, &snapshot.view_id, &tab).unwrap();
        assert_eq!(core.workspace.lock().unwrap().tabs.len(), 1);
        core.begin_view();
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[test]
    fn invalid_stale_missing_and_link_paths_never_dispatch() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.html"), "a").unwrap();
        let core = Core::new(19101);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        for path in [
            "../a.html",
            "/a.html",
            "https://example.com/a.html",
            "file:///a.html",
            "C:/a.html",
            "a.html;open",
            "missing.html",
        ] {
            assert!(perform(
                &core,
                workspace,
                &snapshot.view_id,
                path,
                FileAction::CopyPath,
                |_| panic!("invalid path dispatched")
            )
            .is_err());
        }
        for action in [
            FileAction::CopyPath,
            FileAction::OpenFolder,
            FileAction::OpenBrowser,
        ] {
            assert!(perform(
                &core,
                "old",
                &snapshot.view_id,
                "a.html",
                action,
                |_| panic!("stale workspace dispatched")
            )
            .is_err());
            assert!(
                perform(&core, workspace, "old", "a.html", action, |_| panic!(
                    "stale view dispatched"
                ))
                .is_err()
            );
        }
        assert!(serde_json::from_str::<FileAction>("\"shell\"").is_err());
        fs::remove_file(tmp.path().join("a.html")).unwrap();
        assert!(perform(
            &core,
            workspace,
            &snapshot.view_id,
            "a.html",
            FileAction::CopyPath,
            |_| panic!("missing file dispatched")
        )
        .is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("secret.html"), "secret").unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("secret.html"),
                tmp.path().join("a.html"),
            )
            .unwrap();
            assert!(perform(
                &core,
                workspace,
                &snapshot.view_id,
                "a.html",
                FileAction::OpenFolder,
                |_| panic!("link dispatched")
            )
            .is_err());
        }
    }
    #[test]
    fn windows_shell_names_cannot_change_target_when_prefix_is_removed() {
        for name in [
            "folder.",
            "folder ",
            "CON",
            "nul.html",
            "COM1.txt",
            "LPT²",
            "x:y",
            "x\"y",
            "line\nend",
        ] {
            assert!(!shell_component(name), "{name}");
        }
        for name in ["日本語 & folder", "a ' #%.html", "COM10.html", "normal"] {
            assert!(shell_component(name));
        }
    }
    #[test]
    fn view_restart_is_serialized_with_explicit_os_dispatch() {
        use std::{sync::mpsc, time::Duration};
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.html"), "a").unwrap();
        let core = Core::new(19103);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let (started, ready) = mpsc::channel();
        let (release, proceed) = mpsc::channel();
        let worker = core.clone();
        let old = snapshot.clone();
        let action = std::thread::spawn(move || {
            perform(
                &worker,
                old.workspace_id.as_ref().unwrap(),
                &old.view_id,
                "a.html",
                FileAction::CopyPath,
                |_| {
                    started.send(()).unwrap();
                    proceed.recv().unwrap();
                    Ok(())
                },
            )
        });
        ready.recv().unwrap();
        let worker = core.clone();
        let (starting, begun) = mpsc::channel();
        let (changed, completed) = mpsc::channel();
        let restart = std::thread::spawn(move || {
            starting.send(()).unwrap();
            changed.send(worker.begin_view()).unwrap();
        });
        begun.recv().unwrap();
        assert!(completed.recv_timeout(Duration::from_millis(30)).is_err());
        release.send(()).unwrap();
        action.join().unwrap().unwrap();
        let current = completed.recv_timeout(Duration::from_secs(5)).unwrap();
        restart.join().unwrap();
        assert_ne!(current.view_id, snapshot.view_id);
        assert!(perform(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            "a.html",
            FileAction::CopyPath,
            |_| panic!("old view dispatched")
        )
        .is_err());
    }
    #[test]
    fn replaced_root_never_dispatches_even_if_the_html_name_is_unchanged() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("knowledge");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.html"), "old").unwrap();
        let core = Core::new(19104);
        let snapshot = core.select(&root, false).unwrap();
        let previous = tmp.path().join("previous");
        #[cfg(windows)]
        {
            // The selected root deliberately excludes FILE_SHARE_DELETE.
            // Replacement is prevented by the retained capability itself.
            let error = fs::rename(&root, &previous).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(32)); // ERROR_SHARING_VIOLATION
            assert!(!previous.exists());
            assert_eq!(fs::read(root.join("a.html")).unwrap(), b"old");
            let mut dispatched = false;
            perform(
                &core,
                snapshot.workspace_id.as_ref().unwrap(),
                &snapshot.view_id,
                "a.html",
                FileAction::CopyPath,
                |_| {
                    dispatched = true;
                    Ok(())
                },
            )
            .unwrap();
            assert!(dispatched, "the locked original root remains usable");
        }
        #[cfg(not(windows))]
        {
            fs::rename(&root, &previous).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("a.html"), "new").unwrap();
            for action in [
                FileAction::CopyPath,
                FileAction::OpenFolder,
                FileAction::OpenBrowser,
            ] {
                assert!(perform(
                    &core,
                    snapshot.workspace_id.as_ref().unwrap(),
                    &snapshot.view_id,
                    "a.html",
                    action,
                    |_| panic!("replaced root dispatched"),
                )
                .is_err());
            }
        }
    }
    #[test]
    fn failed_browser_dispatch_releases_its_grant_and_surfaces_error() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a.html"), "a").unwrap();
        let core = Core::new(19102);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let error = perform(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            "a.html",
            FileAction::OpenBrowser,
            |_| Err("OS起動失敗".into()),
        )
        .unwrap_err();
        assert_eq!(error, "OS起動失敗");
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
}
