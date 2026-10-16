use mogledge_lib::{core::Core, knowledge};
use std::{
    fs,
    sync::{mpsc, Arc},
    time::Duration,
};

#[test]
fn ai_handoff_permissions_remain_scoped_to_local_main_without_document_bridge() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], serde_json::json!(["main"]));
    assert!(capability.get("remote").is_none());
    let permissions = capability["permissions"].as_array().unwrap();
    for command in ["prepare_ai_handoff", "perform_ai_handoff"] {
        assert!(permissions
            .iter()
            .any(|permission| { permission == &format!("allow-{}", command.replace('_', "-")) }));
        assert!(include_str!("../build.rs").contains(command));
        for document_source in [
            include_str!("../src/document_server/storage.rs"),
            include_str!("../src/document_server/keyboard.js"),
            include_str!("../src/document_server/links.js"),
        ] {
            assert!(!document_source.contains(command));
        }
    }
}

#[test]
fn asset_usage_permission_is_read_only_and_scoped_to_local_main() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], serde_json::json!(["main"]));
    assert!(capability.get("remote").is_none());
    assert!(capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|permission| permission == "allow-get-asset-usage"));
    let manifest = include_str!("../build.rs");
    assert!(manifest.contains("\"get_asset_usage\""));
    let commands = include_str!("../src/commands/mod.rs");
    assert!(
        commands.contains("pub fn get_asset_usage(core: State<'_, Arc<Core>>)")
            && commands.contains("core.asset_admission.report()")
    );
    assert!(!include_str!("../src/document_server/storage.rs").contains("get_asset_usage"));
    assert!(!include_str!("../src/document_server/keyboard.js").contains("get_asset_usage"));
    assert!(!include_str!("../src/document_server/links.js").contains("get_asset_usage"));
    assert!(
        include_str!("../../tests/fixtures/knowledge/Security/Isolation.html")
            .contains("\"get_asset_usage\"")
    );
}

#[test]
fn recovery_permissions_remain_scoped_to_the_bundled_main_ui() {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], serde_json::json!(["main"]));
    assert!(capability.get("remote").is_none());
    let permissions = capability["permissions"].as_array().unwrap();
    for permission in [
        "allow-get-document-state-recovery",
        "allow-recover-document-state",
    ] {
        assert!(permissions.iter().any(|value| value == permission));
    }
}

#[test]
fn native_watcher_observes_create_atomic_save_and_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::new(19000);
    let (tx, rx) = mpsc::channel();
    *core.sink.lock().unwrap() = Some(Arc::new(move |event| {
        let _ = tx.send(event);
    }));
    let snapshot = core.select(tmp.path(), false).unwrap();
    fs::write(tmp.path().join("new.html"), "first").unwrap();
    let event = rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(event.workspace_id, snapshot.workspace_id.unwrap());
    assert!(
        event.watch_error.is_none(),
        "Debounce timeout is not a watcher failure"
    );
    assert!(knowledge::contains(&core.snapshot().nodes, "new.html"));
    fs::write(tmp.path().join("atomic.tmp"), "second").unwrap();
    fs::remove_file(tmp.path().join("new.html")).unwrap();
    fs::rename(tmp.path().join("atomic.tmp"), tmp.path().join("new.html")).unwrap();
    rx.recv_timeout(Duration::from_secs(8)).unwrap();
    let (root, dir) = knowledge::open_root(tmp.path()).unwrap();
    assert_eq!(knowledge::read(&root, &dir, "new.html").unwrap(), b"second");
    fs::remove_file(tmp.path().join("new.html")).unwrap();
    rx.recv_timeout(Duration::from_secs(8)).unwrap();
    assert!(!knowledge::contains(&core.snapshot().nodes, "new.html"));
}

#[test]
fn stale_workspace_and_document_requests_are_rejected() {
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    fs::write(one.path().join("a.html"), "a").unwrap();
    fs::write(two.path().join("b.html"), "b").unwrap();
    let core = Core::new(19001);
    let first = core.select(one.path(), false).unwrap();
    let workspace = first.workspace_id.as_ref().unwrap();
    let tab = core
        .create_tab(workspace, &first.view_id, "a.html")
        .unwrap();
    core.open(workspace, &first.view_id, &tab, 2).unwrap();
    assert_eq!(
        core.open(workspace, &first.view_id, &tab, 1).unwrap_err(),
        "Superseded"
    );
    let second = core.select(two.path(), false).unwrap();
    assert_ne!(first.workspace_id, second.workspace_id);
    assert_eq!(
        core.open(workspace, &first.view_id, &tab, 3).unwrap_err(),
        "WorkspaceChanged"
    );
    assert!(core.workspace.lock().unwrap().tabs.is_empty());
}

#[test]
fn unicode_spaces_and_file_limits() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join("日本語の資料")).unwrap();
    fs::write(
        tmp.path().join("日本語の資料/with space.HTML"),
        "こんにちは",
    )
    .unwrap();
    let (root, dir) = knowledge::open_root(tmp.path()).unwrap();
    assert_eq!(
        knowledge::read(&root, &dir, "日本語の資料/with space.HTML").unwrap(),
        "こんにちは".as_bytes()
    );
    let file = fs::File::create(tmp.path().join("large.json")).unwrap();
    file.set_len(32 * 1024 * 1024 + 1).unwrap();
    assert!(knowledge::read(&root, &dir, "large.json").is_err());
}

#[test]
fn links_cannot_expose_another_directory() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.html"), "secret").unwrap();
    let link = root.path().join("link");
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success(), "Could not create test junction");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    let (canonical, dir) = knowledge::open_root(root.path()).unwrap();
    assert!(knowledge::scan(&canonical).unwrap().is_empty());
    assert!(knowledge::read(&canonical, &dir, "link/secret.html").is_err());
}

#[test]
fn view_restart_and_tab_close_revoke_pending_and_live_sessions() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("a.html"), "a").unwrap();
    let core = Core::new(19002);
    let first = core.select(tmp.path(), false).unwrap();
    let workspace = first.workspace_id.as_ref().unwrap();
    let tab = core
        .create_tab(workspace, &first.view_id, "a.html")
        .unwrap();
    core.open(workspace, &first.view_id, &tab, 1).unwrap();
    core.close_tab(workspace, &first.view_id, &tab).unwrap();
    assert_eq!(
        core.open(workspace, &first.view_id, &tab, 2).unwrap_err(),
        "TabClosed"
    );
    let new_tab = core
        .create_tab(workspace, &first.view_id, "a.html")
        .unwrap();
    assert_ne!(tab, new_tab);
    let second = core.begin_view();
    assert_ne!(first.view_id, second.view_id);
    assert_eq!(
        core.create_tab(workspace, &first.view_id, "a.html")
            .unwrap_err(),
        "ViewChanged"
    );
    assert_eq!(
        core.close_tab(workspace, &first.view_id, &new_tab)
            .unwrap_err(),
        "ViewChanged"
    );
    assert!(core.workspace.lock().unwrap().tabs.is_empty());
}

#[test]
fn refreshing_the_same_root_retains_tabs_and_grants() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("a.html"), "a").unwrap();
    let core = Core::new(19003);
    let snapshot = core.select(tmp.path(), false).unwrap();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    let tab = core
        .create_tab(workspace, &snapshot.view_id, "a.html")
        .unwrap();
    let url = core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
    let (token, _) =
        mogledge_lib::document_server::decode_path(url.strip_prefix(&core.origin).unwrap())
            .unwrap();
    let refreshed = core.refresh().unwrap();
    assert_eq!(snapshot.workspace_id, refreshed.workspace_id);
    assert_eq!(snapshot.view_id, refreshed.view_id);
    assert!(core.session_for_token(&token).is_some());
}

#[cfg(unix)]
#[test]
fn root_replacement_is_rejected_then_refresh_opens_the_new_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("knowledge");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.html"), "old").unwrap();
    let core = Core::new(19004);
    let snapshot = core.select(&root, false).unwrap();
    let workspace = snapshot.workspace_id.as_ref().unwrap();
    let tab = core
        .create_tab(workspace, &snapshot.view_id, "a.html")
        .unwrap();
    core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
    fs::rename(&root, tmp.path().join("old")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.html"), "new").unwrap();
    let old = core.workspace.lock().unwrap().dir.clone().unwrap();
    assert!(knowledge::read(&root, &old, "a.html").is_err());
    let refreshed = core.refresh().unwrap();
    assert_ne!(refreshed.workspace_id, snapshot.workspace_id);
    assert!(core.workspace.lock().unwrap().tabs.is_empty());
    let dir = core.workspace.lock().unwrap().dir.clone().unwrap();
    assert_eq!(knowledge::read(&root, &dir, "a.html").unwrap(), b"new");
}
