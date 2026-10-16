use mogledge_backend_tests::{core::Core, document_state::DocumentState, knowledge};

#[test]
fn fresh_profile_can_persist_and_replace_chosen_root() {
    let fixture = tempfile::tempdir().unwrap();
    let profile = fixture.path().join("profile");
    let root = fixture.path().join("knowledge");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&root).unwrap();
    let core = Core::new(0);
    core.settings_path
        .set(profile.join("settings.json"))
        .unwrap();
    core.select(&root, true)
        .expect("persist a newly chosen root");
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.join("settings.json")).unwrap()).unwrap();
    assert!(settings["knowledgeRoot"].as_str().is_some());
    assert_eq!(
        settings["knowledgeRootIdentity"].as_str().unwrap(),
        knowledge::storage_root_identity(&knowledge::open_root(&root).unwrap().1).unwrap()
    );
    let mut settings = settings;
    settings["language"] = serde_json::json!("en");
    std::fs::write(
        profile.join("settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
    let other = fixture.path().join("other-knowledge");
    std::fs::create_dir(&other).unwrap();
    core.select(&other, true)
        .expect("replace a previously chosen root");
    let settings: serde_json::Value =
        serde_json::from_slice(&std::fs::read(profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(
        std::path::PathBuf::from(settings["knowledgeRoot"].as_str().unwrap()),
        other.canonicalize().unwrap()
    );
    assert_eq!(settings["language"], "en");
}

#[test]
fn fresh_document_database_initializes_and_reopens() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("document-state");
    let store = DocumentState::new(path.clone()).expect("initialize fresh document database");
    drop(store);
    DocumentState::new(path).expect("reopen initialized document database");
}
