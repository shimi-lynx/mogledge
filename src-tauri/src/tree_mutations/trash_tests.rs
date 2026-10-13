use super::*;
use std::{fs, path::PathBuf};

fn fixture() -> (tempfile::TempDir, Arc<Core>, Snapshot, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("knowledge");
    fs::create_dir_all(root.join("日本語 & folder/child")).unwrap();
    fs::write(root.join("a.html"), "retained").unwrap();
    fs::write(root.join("日本語 & folder/child/b.html"), "nested").unwrap();
    fs::write(root.join("日本語 & folder/.hidden"), "hidden").unwrap();
    fs::write(root.join("日本語 & folder/resource.json"), "asset").unwrap();
    let core = Core::new(19310);
    let snapshot = core.select(&root, false).unwrap();
    core.watcher.lock().unwrap().take();
    (tmp, core, snapshot, root)
}
fn operation(snapshot: &Snapshot, source: &str) -> Mutation {
    Mutation::Trash {
        source: source.into(),
        revision: snapshot.revision,
    }
}

#[test]
fn trash_rejects_root_outside_unlisted_stale_and_missing_without_dispatch() {
    let (_tmp, core, snapshot, root) = fixture();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    for source in [
        "",
        ".",
        "..",
        "../a.html",
        "/a.html",
        "C:/a.html",
        "日本語 & folder/resource.json",
        "missing.html",
    ] {
        assert!(perform_with_trash(
            &core,
            workspace,
            &snapshot.view_id,
            operation(&snapshot, source),
            || {},
            |_| panic!("invalid target dispatched")
        )
        .is_err());
    }
    for (workspace, view, revision) in [
        ("old", snapshot.view_id.as_str(), snapshot.revision),
        (workspace.as_str(), "old", snapshot.revision),
        (
            workspace.as_str(),
            snapshot.view_id.as_str(),
            snapshot.revision + 1,
        ),
    ] {
        assert!(perform_with_trash(
            &core,
            workspace,
            view,
            Mutation::Trash {
                source: "a.html".into(),
                revision
            },
            || {},
            |_| panic!("stale target dispatched")
        )
        .is_err());
    }
    fs::rename(root.join("a.html"), root.join("retained.html")).unwrap();
    assert!(perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "a.html"),
        || {},
        |_| panic!("missing dispatched")
    )
    .is_err());
    assert_eq!(fs::read(root.join("retained.html")).unwrap(), b"retained");
}

#[test]
fn trash_failure_preserves_snapshot_tabs_grants_and_source() {
    let (_tmp, core, snapshot, root) = fixture();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    let tab = core
        .create_tab(workspace, &snapshot.view_id, "a.html")
        .unwrap();
    let url = core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
    let token = crate::document_server::decode_path(url.strip_prefix(&core.origin).unwrap())
        .unwrap()
        .0;
    let error = perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "a.html"),
        || {},
        |_| Err("recycle unavailable".into()),
    )
    .err()
    .unwrap();
    assert_eq!(error, "recycle unavailable");
    assert_eq!(core.snapshot().revision, snapshot.revision);
    assert!(core.session_for_token(&token).is_some());
    assert_eq!(fs::read(root.join("a.html")).unwrap(), b"retained");
}

#[test]
fn trash_folder_revokes_descendants_retains_other_grants_and_saved_input() {
    let (tmp, core, snapshot, root) = fixture();
    core.document_state
        .set(crate::document_state::DocumentState::new(tmp.path().join("state")).unwrap())
        .ok()
        .unwrap();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    let grant = |path| {
        let tab = core.create_tab(workspace, &snapshot.view_id, path).unwrap();
        let url = core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
        crate::document_server::decode_path(url.strip_prefix(&core.origin).unwrap())
            .unwrap()
            .0
    };
    let nested = grant("日本語 & folder/child/b.html");
    let retained = grant("a.html");
    let request = serde_json::from_value(
        serde_json::json!({"version":1,"op":"write","key":"fixture","value":{"saved":true}}),
    )
    .unwrap();
    crate::document_state::operate(&core, &nested, request).unwrap();
    let database = tmp.path().join("state/state.sqlite");
    let stored = || {
        rusqlite::Connection::open(&database)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM documents", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    assert_eq!(stored(), 1);
    let recovered = tmp.path().join("fixture-recovery");
    let result = perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "日本語 & folder"),
        || {},
        |path| {
            assert_eq!(
                path,
                fs::canonicalize(&root).unwrap().join("日本語 & folder")
            );
            fs::rename(path, &recovered).map_err(|error| error.to_string())
        },
    )
    .unwrap();
    assert!(!knowledge::contains(
        &result.snapshot.nodes,
        "日本語 & folder/child/b.html"
    ));
    assert!(core.session_for_token(&nested).is_none());
    assert!(core.session_for_token(&retained).is_some());
    assert_eq!(stored(), 1);
    assert_eq!(fs::read(recovered.join(".hidden")).unwrap(), b"hidden");
    assert_eq!(fs::read(recovered.join("resource.json")).unwrap(), b"asset");
    fs::rename(&recovered, root.join("日本語 & folder")).unwrap();
    core.refresh().unwrap();
    assert!(core.session_for_token(&nested).is_none());
    assert_eq!(stored(), 1);
}

#[cfg(unix)]
#[test]
fn trash_rejects_subtree_links_fifo_and_validation_races() {
    let (tmp, core, snapshot, root) = fixture();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    let outside = tmp.path().join("outside.html");
    fs::write(&outside, "outside").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("日本語 & folder/link")).unwrap();
    assert!(perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "日本語 & folder"),
        || {},
        |_| panic!("link subtree dispatched")
    )
    .is_err());
    fs::remove_file(root.join("日本語 & folder/link")).unwrap();
    crate::test_fixtures::create_fifo(&root.join("日本語 & folder/pipe"), 0o600).unwrap();
    assert!(perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "日本語 & folder"),
        || {},
        |_| panic!("FIFO dispatched")
    )
    .is_err());
    fs::remove_file(root.join("日本語 & folder/pipe")).unwrap();
    assert!(perform_with_trash(
        &core,
        workspace,
        &snapshot.view_id,
        operation(&snapshot, "a.html"),
        || {
            fs::rename(root.join("a.html"), root.join("previous.html")).unwrap();
            fs::write(root.join("a.html"), "replacement").unwrap();
        },
        |_| panic!("replacement dispatched")
    )
    .is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"outside");
    assert_eq!(fs::read(root.join("a.html")).unwrap(), b"replacement");
    assert_eq!(fs::read(root.join("previous.html")).unwrap(), b"retained");
}

#[cfg(not(any(windows, target_os = "macos")))]
#[test]
fn unsupported_os_trash_never_permanently_deletes() {
    let (_tmp, core, snapshot, root) = fixture();
    assert!(perform(
        &core,
        snapshot.workspace_id.as_ref().unwrap(),
        &snapshot.view_id,
        operation(&snapshot, "a.html")
    )
    .is_err());
    assert_eq!(fs::read(root.join("a.html")).unwrap(), b"retained");
}

#[cfg(unix)]
#[test]
fn trash_revalidates_root_parent_and_new_subtree_links_before_os_dispatch() {
    for change in ["root", "parent", "subtree"] {
        let (tmp, core, snapshot, root) = fixture();
        let result = perform_with_trash(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            operation(&snapshot, "日本語 & folder/child/b.html"),
            || match change {
                "root" => {
                    fs::rename(&root, tmp.path().join("previous-root")).unwrap();
                    fs::create_dir_all(root.join("日本語 & folder/child")).unwrap();
                    fs::write(root.join("日本語 & folder/child/b.html"), "replacement").unwrap();
                }
                "parent" => {
                    fs::rename(root.join("日本語 & folder"), root.join("previous-parent")).unwrap();
                    std::os::unix::fs::symlink(
                        root.join("previous-parent"),
                        root.join("日本語 & folder"),
                    )
                    .unwrap();
                }
                _ => {
                    fs::rename(
                        root.join("日本語 & folder/child/b.html"),
                        root.join("previous.html"),
                    )
                    .unwrap();
                    std::os::unix::fs::symlink(
                        root.join("previous.html"),
                        root.join("日本語 & folder/child/b.html"),
                    )
                    .unwrap();
                }
            },
            |_| panic!("changed root/ancestor/source dispatched"),
        );
        assert!(result.is_err(), "{change}");
        assert_eq!(core.snapshot().revision, snapshot.revision);
    }
}
