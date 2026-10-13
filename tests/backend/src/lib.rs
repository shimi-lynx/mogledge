//! Platform-independent checks of the unchanged production module sources.
#[path = "../../../src-tauri/src/ai_handoff.rs"]
pub mod ai_handoff;
#[path = "../../../src-tauri/src/artifact_export.rs"]
pub mod artifact_export;
#[path = "../../../src-tauri/src/core.rs"]
pub mod core;
#[path = "../../../src-tauri/src/document_links.rs"]
pub mod document_links;
#[path = "../../../src-tauri/src/document_server/mod.rs"]
pub mod document_server;
#[path = "../../../src-tauri/src/document_state.rs"]
pub mod document_state;
#[path = "../../../src-tauri/src/index/mod.rs"]
pub mod index;
#[path = "../../../src-tauri/src/knowledge/mod.rs"]
pub mod knowledge;
#[path = "../../../src-tauri/src/root_recovery.rs"]
pub mod root_recovery;
#[path = "../../../src-tauri/src/storage_identity_transition.rs"]
pub mod storage_identity_transition;
#[path = "../../../src-tauri/src/storage_limits.rs"]
pub mod storage_limits;
#[path = "../../../src-tauri/src/watcher/mod.rs"]
pub mod watcher;

#[path = "../../../src-tauri/src/file_actions.rs"]
pub mod file_actions;
#[path = "../../../src-tauri/src/os_actions.rs"]
pub mod os_actions;
#[path = "../../../src-tauri/src/tree_mutations.rs"]
pub mod tree_mutations;
#[path = "../../../src-tauri/src/tree_order.rs"]
pub mod tree_order;
#[path = "../../../src-tauri/src/write_fs.rs"]
pub mod write_fs;
// Integration tests compile this harness without cfg(test); the application
// exposes the same fixture module only to its Unix unit tests.
#[cfg(unix)]
#[path = "../../../src-tauri/src/test_fixtures.rs"]
pub mod test_fixtures;

#[path = "../../../src-tauri/src/identifier_migration.rs"]
pub mod identifier_migration;
#[path = "../../../src-tauri/src/workspace_settings.rs"]
pub mod workspace_settings;

#[path = "../../../src-tauri/src/state_inspection.rs"]
pub mod state_inspection;

#[path = "../../../src-tauri/src/state_transfer.rs"]
pub mod state_transfer;

#[path = "../../../src-tauri/src/html_authoring.rs"]
pub mod html_authoring;
#[cfg(windows)]
pub mod resident;
#[path = "../../../src-tauri/src/resident/model.rs"]
pub mod resident_model;
#[path = "../../../src-tauri/src/resident/sequence.rs"]
pub mod resident_sequence;
#[path = "../../../src-tauri/src/resident/shortcut_transaction.rs"]
pub mod resident_shortcut_transaction;
#[path = "../../../src-tauri/src/resident/startup.rs"]
pub mod resident_startup;
#[path = "../../../src-tauri/src/updater_model.rs"]
pub mod updater_model;

// Mac input logic is platform-independent; native framework calls remain in the app.
#[path = "../../../src-tauri/src/resident/macos_input.rs"]
pub mod resident_macos_input;
pub use resident_sequence as sequence;
