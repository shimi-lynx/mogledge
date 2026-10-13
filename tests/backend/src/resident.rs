//! Exercise the production Windows receiver without creating a Tauri runtime.
pub use crate::resident_sequence as sequence;
#[path = "../../../src-tauri/src/resident/windows.rs"]
pub mod windows;
