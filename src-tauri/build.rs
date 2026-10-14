mod updater_build_config;

fn main() {
    // Tauri codegen defaults this bundle-only field in the embedded Config.
    // Preserve the same typed, merged build decision instead of reading runtime env.
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=updater_build_config.rs");
    let target = tauri_utils::platform::Target::from_triple(
        &std::env::var("TARGET").expect("Cargo target is required"),
    );
    let (config, paths) = tauri_utils::config::parse::read_from(
        target,
        &std::env::current_dir().expect("Cargo build directory is required"),
    )
    .expect("Tauri build configuration could not be read");
    for path in paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let selected = std::env::var("TAURI_CONFIG").ok();
    let enabled = updater_build_config::signed_artifacts_enabled(config, selected.as_deref())
        .expect("Tauri updater build configuration is invalid");
    println!("cargo:rustc-env=MOGLEDGE_SIGNED_UPDATE_BUILD={enabled}");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "storage_transition_request",
            "storage_transition_pick_directory",
            "open_storage_identity_transition",
            "choose_knowledge_root",
            "get_knowledge_tree",
            "get_asset_usage",
            "save_html_artifact",
            "choose_state_transfer_file",
            "prepare_state_transfer",
            "confirm_state_transfer",
            "cancel_state_transfer",
            "verify_state_transfer",
            "get_storage_limits",
            "set_storage_limits",
            "inspect_saved_state",
            "list_saved_state_recovery",
            "prepare_saved_state_management",
            "confirm_saved_state_management",
            "cancel_saved_state_management",
            "verify_saved_state_management",
            "open_document",
            "refresh_knowledge",
            "retry_saved_root",
            "get_index_status",
            "search_documents",
            "rebuild_search_index",
            "begin_document_view",
            "create_document_tab",
            "close_document_tab",
            "get_document_state_recovery",
            "recover_document_state",
            "perform_file_action",
            "perform_root_action",
            "get_html_authoring_status",
            "preview_html_authoring_kit",
            "cancel_html_authoring_kit",
            "install_html_authoring_kit",
            "set_html_authoring_enabled",
            "prepare_ai_handoff",
            "perform_ai_handoff",
            "resolve_document_link",
            "validate_document_navigation",
            "open_external_document_link",
            "mutate_tree",
            "confirm_tab_session_flush",
            "get_tab_session",
            "capture_tab_session",
            "get_workspace_sets",
            "capture_workspace_set",
            "edit_workspace_set",
            "assign_workspace_set_shortcut",
            "resolve_workspace_set",
            "get_workspace_lists",
            "set_document_favorite",
            "validate_workspace_document",
            "validate_workspace_folder",
            "record_document_display",
            "get_window_chrome",
            "perform_window_action",
            "set_window_shortcut_scope",
            "get_resident_status",
            "update_resident_preferences",
            "resolve_resident_target",
            "get_app_update_status",
            "check_app_update",
            "download_app_update",
            "cancel_app_update",
            "restart_app_update",
        ]),
    ))
    .expect("Tauri build configuration failed");
}
