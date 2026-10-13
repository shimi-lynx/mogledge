use my_knowledge_backend_tests::{
    core::Core,
    document_links::{self, LinkTarget},
    document_server,
    document_state::DocumentState,
};
use std::{fs, sync::Arc};

fn fixture() -> (tempfile::TempDir, Arc<Core>, String, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir(tmp.path().join("日本語 folder")).unwrap();
    fs::write(tmp.path().join("日本語 folder/source.html"), "source").unwrap();
    fs::write(tmp.path().join("日本語 folder/other page.html"), "target").unwrap();
    fs::write(tmp.path().join("data.json"), "{}").unwrap();
    let core = Core::new(19357);
    core.document_state
        .set(DocumentState::new(tmp.path().join("state")).unwrap())
        .ok()
        .unwrap();
    let snapshot = core.select(tmp.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let view = snapshot.view_id;
    let tab = core
        .create_tab(&workspace, &view, "日本語 folder/source.html")
        .unwrap();
    let source = core.open(&workspace, &view, &tab, 1).unwrap();
    (tmp, core, workspace, view, tab, source)
}

#[test]
fn resolves_scoped_html_and_anchor_without_reading_saved_json() {
    let (_tmp, core, workspace, view, _tab, source) = fixture();
    assert_eq!(
        document_links::resolve(
            &core,
            &workspace,
            &view,
            &source,
            &(source.clone() + "#%E7%AB%A0")
        )
        .unwrap(),
        LinkTarget::Page {
            fragment: "#%E7%AB%A0".into()
        }
    );
    let sibling = source.rsplit_once('/').unwrap().0.to_owned() + "/other%20page.html#section";
    assert_eq!(
        document_links::resolve(&core, &workspace, &view, &source, &sibling).unwrap(),
        LinkTarget::Document {
            relative_path: "日本語 folder/other page.html".into(),
            fragment: "#section".into()
        }
    );
    let encoded = serde_json::to_value(
        document_links::resolve(&core, &workspace, &view, &source, &sibling).unwrap(),
    )
    .unwrap();
    assert_eq!(encoded["relativePath"], "日本語 folder/other page.html");
}

#[test]
fn rejects_special_schemes_other_grants_and_root_escapes() {
    let (_tmp, core, workspace, view, _tab, source) = fixture();
    let (token, _) =
        document_server::decode_path(source.strip_prefix(&core.origin).unwrap()).unwrap();
    for href in [
        "javascript:alert(1)".to_owned(),
        "file:///outside.html".into(),
        "mailto:a@example.com".into(),
        "https://user:secret@example.com/".into(),
        "https://example.com:99999/".into(),
        "https://example.com/\"".into(),
        "https://example.com/\\payload".into(),
        "https://example.com/<script>".into(),
        "https://example.com/\nsecret".into(),
        format!("{}/s/{token}/%2e%2e/outside.html", core.origin),
        format!("{}/s/{token}/x%2fother.html", core.origin),
        format!("{}/s/{token}/x%5cother.html", core.origin),
        format!("{}/s/{token}/data.json", core.origin),
        format!("{}/s/{token}/missing.html", core.origin),
        format!(
            "{}/s/{}/%E6%97%A5%E6%9C%AC%E8%AA%9E%20folder/other%20page.html",
            core.origin,
            "a".repeat(64)
        ),
    ] {
        assert!(
            document_links::resolve(&core, &workspace, &view, &source, &href).is_err(),
            "{href}"
        );
    }
    let mut dispatched = false;
    assert!(
        document_links::open_external(&core, &workspace, &view, &source, &source, |_| {
            dispatched = true;
            Ok(())
        })
        .is_err()
    );
    assert!(!dispatched);
}

#[test]
fn external_dispatch_preserves_query_fragment_and_holds_lifecycle_gate() {
    let (_tmp, core, workspace, view, _tab, source) = fixture();
    let href = "https://example.com/?q=%E6%97%A5%E6%9C%AC&x=%22%5C#section";
    assert_eq!(
        document_links::resolve(&core, &workspace, &view, &source, href).unwrap(),
        LinkTarget::External { url: href.into() }
    );
    for valid in [
        "https://example.com:443/",
        "http://[::1]/",
        "http://[::1]:8080/",
    ] {
        assert!(document_links::resolve(&core, &workspace, &view, &source, valid).is_ok());
    }
    let mut count = 0;
    document_links::open_external(&core, &workspace, &view, &source, href, |target| {
        assert_eq!(target.target, href);
        assert!(core.gate.try_lock().is_err());
        count += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(count, 1);
    assert!(document_links::resolve(
        &core,
        &workspace,
        &view,
        &source,
        &("https://example.com/".to_owned() + &"a".repeat(8192))
    )
    .is_err());
}

#[test]
fn revocation_and_wrong_context_block_confirmation_dispatch() {
    let (_tmp, core, workspace, view, tab, source) = fixture();
    let href = "https://example.com/";
    document_links::resolve(&core, &workspace, &view, &source, href).unwrap();
    core.open(&workspace, &view, &tab, 2).unwrap();
    let mut count = 0;
    for (workspace, view) in [
        (workspace.as_str(), view.as_str()),
        ("old-workspace", view.as_str()),
        (workspace.as_str(), "old-view"),
    ] {
        assert!(
            document_links::open_external(&core, workspace, view, &source, href, |_| {
                count += 1;
                Ok(())
            })
            .is_err()
        );
    }
    assert_eq!(count, 0);
}

#[test]
fn replacing_source_identity_blocks_links() {
    let (tmp, core, workspace, view, _tab, source) = fixture();
    let relative = tmp.path().join("日本語 folder/source.html");
    fs::rename(&relative, tmp.path().join("previous.html")).unwrap();
    fs::write(&relative, "replacement").unwrap();
    assert!(
        document_links::resolve(&core, &workspace, &view, &source, "https://example.com/").is_err()
    );
}

#[test]
fn selected_root_cannot_be_replaced_or_used_after_replacement() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("source.html"), "source").unwrap();
    let core = Core::new(19358);
    let snapshot = core.select(&root, false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let view = snapshot.view_id;
    let tab = core.create_tab(&workspace, &view, "source.html").unwrap();
    let source = core.open(&workspace, &view, &tab, 1).unwrap();
    #[cfg(windows)]
    {
        // The retained root capability deliberately excludes FILE_SHARE_DELETE.
        assert_eq!(
            fs::rename(&root, tmp.path().join("old-root"))
                .unwrap_err()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(fs::read(root.join("source.html")).unwrap(), b"source");
        assert!(
            document_links::resolve(&core, &workspace, &view, &source, "https://example.com/")
                .is_ok()
        );
    }
    #[cfg(not(windows))]
    {
        fs::rename(&root, tmp.path().join("old-root")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("source.html"), "replacement").unwrap();
        let mut dispatched = false;
        assert!(document_links::open_external(
            &core,
            &workspace,
            &view,
            &source,
            "https://example.com/",
            |_| {
                dispatched = true;
                Ok(())
            }
        )
        .is_err());
        assert!(!dispatched);
    }
}

#[cfg(windows)]
#[test]
fn junction_replacement_cannot_escape_selected_root() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    let external = tmp.path().join("external");
    fs::create_dir_all(root.join("targets")).unwrap();
    fs::create_dir(&external).unwrap();
    fs::write(root.join("source.html"), "source").unwrap();
    fs::write(root.join("targets/other.html"), "inside").unwrap();
    fs::write(external.join("other.html"), "outside").unwrap();
    let core = Core::new(19359);
    let snapshot = core.select(&root, false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let view = snapshot.view_id;
    let tab = core.create_tab(&workspace, &view, "source.html").unwrap();
    let source = core.open(&workspace, &view, &tab, 1).unwrap();
    let sibling = source.rsplit_once('/').unwrap().0.to_owned() + "/targets/other.html";
    document_links::resolve(&core, &workspace, &view, &source, &sibling).unwrap();
    fs::rename(root.join("targets"), root.join("previous-targets")).unwrap();
    let status = std::process::Command::new("cmd.exe")
        .args(["/C", "mklink", "/J"])
        .arg(root.join("targets"))
        .arg(&external)
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(document_links::resolve(&core, &workspace, &view, &source, &sibling).is_err());
}

#[test]
fn navigation_validates_root_target_and_live_session_without_new_grants() {
    let (_tmp, core, workspace, view, tab, _source) = fixture();
    let target = "日本語 folder/source.html";
    let reference = document_links::validate_navigation(
        &core,
        &workspace,
        &view,
        target,
        "#%E7%AB%A0",
        Some(&tab),
    )
    .unwrap();
    assert_eq!(reference.relative_path, target);
    assert_eq!(reference.identity.len(), 64);
    assert_eq!(core.workspace.lock().unwrap().tabs.len(), 1);
    for (w, v, p, f, t) in [
        ("old", view.as_str(), target, "", None),
        (workspace.as_str(), "old", target, "", None),
        (
            workspace.as_str(),
            view.as_str(),
            "../outside.html",
            "",
            None,
        ),
        (workspace.as_str(), view.as_str(), "data.json", "", None),
        (
            workspace.as_str(),
            view.as_str(),
            "https://example.com/",
            "",
            None,
        ),
        (
            workspace.as_str(),
            view.as_str(),
            target,
            "not-a-fragment",
            None,
        ),
        (workspace.as_str(), view.as_str(), target, "#\n", None),
        (workspace.as_str(), view.as_str(), target, "", Some("wrong")),
        (
            workspace.as_str(),
            view.as_str(),
            "日本語 folder/other page.html",
            "",
            Some(tab.as_str()),
        ),
    ] {
        assert!(document_links::validate_navigation(&core, w, v, p, f, t).is_err());
    }
    assert!(document_links::validate_navigation(
        &core,
        &workspace,
        &view,
        target,
        &format!("#{}", "a".repeat(8192)),
        None
    )
    .is_err());
}

#[test]
fn navigation_rejects_replaced_live_identity_and_deleted_target() {
    let (tmp, core, workspace, view, tab, _source) = fixture();
    let target = "日本語 folder/source.html";
    fs::rename(tmp.path().join(target), tmp.path().join("old.html")).unwrap();
    fs::write(tmp.path().join(target), "replacement").unwrap();
    assert!(
        document_links::validate_navigation(&core, &workspace, &view, target, "", Some(&tab))
            .is_err()
    );
    assert!(
        document_links::validate_navigation(&core, &workspace, &view, target, "", None).is_ok()
    );
    fs::remove_file(tmp.path().join(target)).unwrap();
    assert!(
        document_links::validate_navigation(&core, &workspace, &view, target, "", None).is_err()
    );
}
