//! Main-confirmed generated artifacts, separate from persisted-input export.
//! Native paths originate only in a picker; documents propose bounded bytes.
use crate::{core::Core, knowledge, state_transfer::files::Location};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ENCODED_BYTES: usize = MAX_BYTES.div_ceil(3) * 4;
const COOLDOWN: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(crate) struct Service(Mutex<Admission>);
#[derive(Default)]
struct Admission {
    busy: bool,
    last: Option<Instant>,
}
struct Flight(Arc<Service>);
impl Drop for Flight {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.busy = false;
        }
    }
}
impl Service {
    fn claim(self: &Arc<Self>) -> Result<Flight, String> {
        let mut state = self.0.lock().map_err(|_| "ArtifactUnavailable")?;
        if state.busy {
            return Err("ArtifactBusy".into());
        }
        if state.last.is_some_and(|last| last.elapsed() < COOLDOWN) {
            return Err("ArtifactCooldown".into());
        }
        state.busy = true;
        state.last = Some(Instant::now());
        Ok(Flight(self.clone()))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub workspace_id: String,
    pub view_id: String,
    pub tab_id: String,
    pub request: u64,
    pub revision: u64,
    pub token: String,
}
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Jpeg,
    Csv,
    Json,
    Text,
}
impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Csv => "csv",
            Self::Json => "json",
            Self::Text => "txt",
        }
    }
    fn validate(self, bytes: &[u8]) -> Result<(), String> {
        let valid = match self {
            Self::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            Self::Jpeg => bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]),
            // IgnoredAny validates without building a second JSON value tree.
            // Its iterative nesting scratch is bounded by the 5 MiB input.
            Self::Json => serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok(),
            Self::Csv | Self::Text => std::str::from_utf8(bytes).is_ok() && !bytes.contains(&0),
        };
        if valid {
            Ok(())
        } else {
            Err("ArtifactFormatInvalid".into())
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub context: Context,
    pub format: Format,
    pub name: String,
    pub data: String,
}
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Receipt {
    Saved { name: String, bytes: usize },
    Cancelled,
}

pub struct Prepared {
    context: Context,
    format: Format,
    pub name: String,
    bytes: Vec<u8>,
    // Kept across the dialog and worker; no thread-bound metadata guard crosses await.
    _flight: Flight,
}
impl Prepared {
    pub fn extension(&self) -> &'static str {
        self.format.extension()
    }
}

fn sanitized_name(name: &str, format: Format) -> Result<String, String> {
    if name.len() > 1024 {
        return Err("ArtifactNameInvalid".into());
    }
    let mut stem = String::new();
    for ch in name.chars() {
        let ch = if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
            '_'
        } else {
            ch
        };
        if stem.len() + ch.len_utf8() > 160 {
            break;
        }
        stem.push(ch);
    }
    let stem = stem.trim_matches([' ', '.']);
    let stem = if stem.is_empty() { "artifact" } else { stem };
    let name = format!("{stem}.{}", format.extension());
    if crate::tree_mutations::valid_name(&name).is_ok() {
        return Ok(name);
    }
    let name = format!("artifact-{name}");
    crate::tree_mutations::valid_name(&name).map_err(|_| "ArtifactNameInvalid")?;
    Ok(name)
}

// Strict canonical padded base64; no new dependency or data URL/remote fetch.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > MAX_ENCODED_BYTES || !data.len().is_multiple_of(4) {
        return Err("ArtifactTooLargeOrInvalid".into());
    }
    let value = |byte| match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut bytes = Vec::with_capacity((data.len() / 4 * 3).min(MAX_BYTES));
    for (index, chunk) in data.as_bytes().as_chunks::<4>().0.iter().enumerate() {
        let last = (index + 1) * 4 == data.len();
        let a = value(chunk[0]).ok_or("ArtifactEncodingInvalid")?;
        let b = value(chunk[1]).ok_or("ArtifactEncodingInvalid")?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            value(chunk[2]).ok_or("ArtifactEncodingInvalid")?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            value(chunk[3]).ok_or("ArtifactEncodingInvalid")?
        };
        let padding = if chunk[2] == b'=' {
            2
        } else if chunk[3] == b'=' {
            1
        } else {
            0
        };
        if padding != 0
            && (!last
                || chunk[3] != b'='
                || (padding == 2 && b & 15 != 0)
                || (padding == 1 && c & 3 != 0))
        {
            return Err("ArtifactEncodingInvalid".into());
        }
        if bytes.len() + 3 - padding > MAX_BYTES {
            return Err("ArtifactTooLargeOrInvalid".into());
        }
        bytes.push((a << 2) | (b >> 4));
        if padding < 2 {
            bytes.push((b << 4) | (c >> 2));
        }
        if padding == 0 {
            bytes.push((c << 6) | d);
        }
    }
    Ok(bytes)
}

fn validate_context(
    core: &Core,
    context: &Context,
) -> Result<(std::path::PathBuf, Arc<cap_std::fs::Dir>, String), String> {
    if [
        &context.workspace_id,
        &context.view_id,
        &context.tab_id,
        &context.token,
    ]
    .iter()
    .any(|id| id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("ArtifactContextInvalid".into());
    }
    let (root, dir, entry, expected_identity) = {
        let state = core.workspace.lock().map_err(|_| "ArtifactUnavailable")?;
        Core::check_view(&state, &context.workspace_id, &context.view_id)
            .map_err(|_| "ArtifactSourceChanged")?;
        if state.snapshot.revision != context.revision {
            return Err("ArtifactSourceChanged".into());
        }
        let tab = state
            .tabs
            .get(&context.tab_id)
            .ok_or("ArtifactSourceChanged")?;
        let session = tab.session.as_ref().ok_or("ArtifactSourceChanged")?;
        if tab.browser
            || tab.latest_request != context.request
            || session.token != context.token
            || session.storage_identity.is_none()
            || session.entry != tab.entry
        {
            return Err("ArtifactSourceChanged".into());
        }
        (
            session.root.clone(),
            session.dir.clone(),
            session.entry.clone(),
            session
                .storage_identity
                .clone()
                .ok_or("ArtifactSourceChanged")?,
        )
    };
    let identity =
        knowledge::storage_identity(&root, &dir, &entry).map_err(|_| "ArtifactSourceChanged")?;
    if identity != expected_identity {
        return Err("ArtifactSourceChanged".into());
    }
    Ok((root, dir, entry))
}

pub fn prepare(core: &Core, request: Request) -> Result<Prepared, String> {
    let flight = core.artifact_export.claim()?;
    let _gate = core.gate.lock().map_err(|_| "ArtifactUnavailable")?;
    validate_context(core, &request.context)?;
    let name = sanitized_name(&request.name, request.format)?;
    let bytes = decode(&request.data)?;
    request.format.validate(&bytes)?;
    Ok(Prepared {
        context: request.context,
        format: request.format,
        name,
        bytes,
        _flight: flight,
    })
}

/// `selected` must come from the Native picker, never from an IPC path argument.
pub fn finish(core: &Core, prepared: Prepared, selected: Option<&Path>) -> Result<Receipt, String> {
    let Some(path) = selected else {
        return Ok(Receipt::Cancelled);
    };
    let _gate = core.gate.lock().map_err(|_| "ArtifactUnavailable")?;
    let (root, dir, entry) = validate_context(core, &prepared.context)?;
    let source_guard = knowledge::PathReferenceGuard::open(&root, &dir, &entry, false)
        .map_err(|_| "ArtifactSourceChanged")?;
    if path.extension().and_then(|ext| ext.to_str()) != Some(prepared.format.extension()) {
        return Err("ArtifactExtensionInvalid".into());
    }
    let profile = core.document_state.get().ok_or("ArtifactUnavailable")?;
    let profile = crate::identifier_migration::directory(profile.profile_directory(), false)
        .map_err(|_| "ArtifactUnavailable")?
        .ok_or("ArtifactUnavailable")?;
    let location = Location::open(path, &profile).map_err(|_| "ArtifactDestinationInvalid")?;
    let mut published = false;
    let result = location.write_new_tracked(
        &prepared.bytes,
        || {
            source_guard
                .revalidate(&root, &dir)
                .map_err(|_| crate::state_transfer::failure("source_changed"))?;
            validate_context(core, &prepared.context)
                .map_err(|_| crate::state_transfer::failure("source_changed"))?;
            Ok(())
        },
        &mut published,
    );
    match result {
        Ok(()) => Ok(Receipt::Saved {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("ArtifactDestinationInvalid")?
                .into(),
            bytes: prepared.bytes.len(),
        }),
        Err(_) if published => Err("ArtifactPublishedUnconfirmed".into()),
        Err(_error) => {
            #[cfg(test)]
            eprintln!("artifact export failed: {_error:?}");
            Err("ArtifactSaveFailed".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_state::DocumentState;
    fn fixture() -> (tempfile::TempDir, Arc<Core>, Context) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let profile = temp.path().join("profile");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::write(root.join("entry.html"), "<p>fixture</p>").unwrap();
        let core = Core::new(19190);
        let state = DocumentState::new(profile.join("document-state")).unwrap();
        assert!(core.document_state.set(state).is_ok());
        let snapshot = core.select(&root, false).unwrap();
        let workspace_id = snapshot.workspace_id.unwrap();
        let tab_id = core
            .create_tab(&workspace_id, &snapshot.view_id, "entry.html")
            .unwrap();
        core.open(&workspace_id, &snapshot.view_id, &tab_id, 1)
            .unwrap();
        let token = core.workspace.lock().unwrap().tabs[&tab_id]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone();
        let context = Context {
            workspace_id,
            view_id: snapshot.view_id,
            tab_id,
            request: 1,
            revision: snapshot.revision,
            token,
        };
        (temp, core, context)
    }
    fn request(context: Context) -> Request {
        Request {
            context,
            format: Format::Text,
            name: "日本語 report".into(),
            data: "aGVsbG8=".into(),
        }
    }
    #[test]
    fn writes_confirmed_new_file_and_reports_only_basename() {
        let (temp, core, context) = fixture();
        let output = temp.path().join("report.txt");
        let prepared = prepare(&core, request(context)).unwrap();
        assert_eq!(prepared.name, "日本語 report.txt");
        let result = finish(&core, prepared, Some(&output)).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"status":"saved","name":"report.txt","bytes":5})
        );
        assert_eq!(std::fs::read(output).unwrap(), b"hello");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 3);
    }
    #[test]
    fn existing_files_and_selected_extension_changes_are_rejected() {
        for existing in [false, true] {
            let (temp, core, context) = fixture();
            let output = temp.path().join(if existing {
                "report.txt"
            } else {
                "report.html"
            });
            if existing {
                std::fs::write(&output, "preserved").unwrap();
            }
            assert!(finish(
                &core,
                prepare(&core, request(context)).unwrap(),
                Some(&output)
            )
            .is_err());
            if existing {
                assert_eq!(std::fs::read(&output).unwrap(), b"preserved");
            } else {
                assert!(!output.exists());
            }
            assert_eq!(
                std::fs::read_dir(temp.path()).unwrap().count(),
                if existing { 3 } else { 2 }
            );
        }
    }
    #[test]
    fn cancellation_releases_flight_without_any_file_or_state_change() {
        let (temp, core, context) = fixture();
        let prepared = prepare(&core, request(context.clone())).unwrap();
        assert!(matches!(
            finish(&core, prepared, None).unwrap(),
            Receipt::Cancelled
        ));
        let state = core.artifact_export.0.lock().unwrap();
        assert!(!state.busy);
        drop(state);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
        assert_eq!(
            core.workspace.lock().unwrap().tabs[&context.tab_id]
                .session
                .as_ref()
                .unwrap()
                .token,
            context.token
        );
    }
    #[test]
    fn one_flight_and_cooldown_are_per_core_and_end_on_drop() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Core>();
        assert_send_sync::<Prepared>();
        let (_temp, core, context) = fixture();
        let first = prepare(&core, request(context.clone())).unwrap();
        assert_eq!(
            prepare(&core, request(context.clone())).err().unwrap(),
            "ArtifactBusy"
        );
        drop(first);
        assert_eq!(
            prepare(&core, request(context.clone())).err().unwrap(),
            "ArtifactCooldown"
        );
        core.artifact_export.0.lock().unwrap().last =
            Some(Instant::now() - COOLDOWN - Duration::from_millis(1));
        assert!(prepare(&core, request(context)).is_ok());
    }
    #[test]
    fn stale_token_request_view_revision_and_browser_sessions_are_rejected() {
        for mutation in 0..6 {
            let (_temp, core, mut context) = fixture();
            match mutation {
                0 => context.token = "f".repeat(64),
                1 => context.request += 1,
                2 => context.view_id = "f".repeat(64),
                3 => context.revision += 1,
                4 => {
                    core.workspace
                        .lock()
                        .unwrap()
                        .tabs
                        .get_mut(&context.tab_id)
                        .unwrap()
                        .browser = true
                }
                _ => {
                    core.workspace
                        .lock()
                        .unwrap()
                        .tabs
                        .get_mut(&context.tab_id)
                        .unwrap()
                        .session
                        .as_mut()
                        .unwrap()
                        .storage_identity = None
                }
            }
            assert_eq!(
                prepare(&core, request(context)).err().unwrap(),
                "ArtifactSourceChanged"
            );
        }
    }
    #[test]
    fn picker_wait_cannot_export_after_close_reload_or_root_switch() {
        for mutation in 0..3 {
            let (temp, core, context) = fixture();
            let prepared = prepare(&core, request(context.clone())).unwrap();
            match mutation {
                0 => core
                    .close_tab(&context.workspace_id, &context.view_id, &context.tab_id)
                    .unwrap(),
                1 => {
                    core.open(&context.workspace_id, &context.view_id, &context.tab_id, 2)
                        .unwrap();
                }
                _ => {
                    core.select(&temp.path().join("root"), false).unwrap();
                }
            }
            let output = temp.path().join("stale.txt");
            assert_eq!(
                finish(&core, prepared, Some(&output)).err().unwrap(),
                "ArtifactSourceChanged"
            );
            assert!(!output.exists());
        }
    }
    // Unix permits atomic replacement while the grant holds the old inode.
    // Windows no-delete handles have a different replacement boundary.
    #[cfg(unix)]
    #[test]
    fn physical_source_replacement_is_rejected_without_reading_html() {
        let (temp, core, context) = fixture();
        let prepared = prepare(&core, request(context)).unwrap();
        let replacement = temp.path().join("new.html");
        std::fs::write(&replacement, "new identity").unwrap();
        std::fs::rename(replacement, temp.path().join("root/entry.html")).unwrap();
        let output = temp.path().join("stale.txt");
        assert!(finish(&core, prepared, Some(&output)).is_err());
        assert!(!output.exists());
    }
    #[cfg(unix)]
    #[test]
    fn fifo_source_before_prepare_or_after_picker_never_holds_the_lifecycle_gate() {
        for after_picker in [false, true] {
            let (temp, core, context) = fixture();
            core.watcher.lock().unwrap().take();
            let prepared = after_picker.then(|| prepare(&core, request(context.clone())).unwrap());
            let source = temp.path().join("root/entry.html");
            std::fs::remove_file(&source).unwrap();
            crate::test_fixtures::create_fifo(&source, 0o600).unwrap();
            let output = temp.path().join("report.txt");
            let selected = output.clone();
            let worker_core = core.clone();
            let (send, receive) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = match prepared {
                    Some(prepared) => finish(&worker_core, prepared, Some(&selected)).map(|_| ()),
                    None => prepare(&worker_core, request(context)).map(drop),
                };
                send.send(result).unwrap();
            });
            assert_eq!(
                receive
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap()
                    .unwrap_err(),
                "ArtifactSourceChanged"
            );
            worker.join().unwrap();
            assert!(core.gate.try_lock().is_ok());
            assert!(!core.artifact_export.0.lock().unwrap().busy);
            assert!(!output.exists());
        }
    }
    #[test]
    fn profile_destinations_and_parent_symlinks_are_rejected() {
        let (temp, core, context) = fixture();
        let output = temp.path().join("profile/export.txt");
        assert_eq!(
            finish(
                &core,
                prepare(&core, request(context)).unwrap(),
                Some(&output)
            )
            .err()
            .unwrap(),
            "ArtifactDestinationInvalid"
        );
        assert!(!output.exists());
        #[cfg(unix)]
        {
            let (temp, core, context) = fixture();
            let alias = temp.path().join("alias");
            std::os::unix::fs::symlink(temp.path(), &alias).unwrap();
            assert!(finish(
                &core,
                prepare(&core, request(context)).unwrap(),
                Some(&alias.join("file.txt"))
            )
            .is_err());
            assert!(!temp.path().join("file.txt").exists());
        }
    }
    #[test]
    fn canonical_base64_rejects_noncanonical_padding_and_enforces_boundary() {
        assert_eq!(decode("aGVsbG8=").unwrap(), b"hello");
        for value in [
            "A",
            "====",
            "AB==",
            "AAA=AAAA",
            "AA=A",
            "AAF=",
            "aGVsbG8=\n",
            "data:aGVsbG8=",
        ] {
            assert!(decode(value).is_err(), "{value}");
        }
        let mut max = "AAAA".repeat(MAX_BYTES / 3);
        max.push_str("AAA=");
        assert_eq!(decode(&max).unwrap().len(), MAX_BYTES);
        let too_large = "AAAA".repeat(MAX_BYTES.div_ceil(3));
        assert!(decode(&too_large).is_err());
    }
    #[test]
    fn formats_require_signature_or_valid_utf8_json_and_reject_markup_types() {
        assert!(Format::Png.validate(b"\x89PNG\r\n\x1a\n").is_ok());
        assert!(Format::Jpeg
            .validate(&[0xff, 0xd8, 0xff, 0, 0xff, 0xd9])
            .is_ok());
        assert!(Format::Json.validate(br#"{"hello":"world"}"#).is_ok());
        assert!(Format::Json.validate(b"{}").is_ok());
        assert!(Format::Json.validate(b"{} trailing").is_err());
        assert!(Format::Text.validate(&[0xff]).is_err());
        assert!(Format::Csv.validate(b"a\0b").is_err());
        for format in ["html", "svg", "binary", "mp4"] {
            assert!(serde_json::from_value::<Format>(serde_json::json!(format)).is_err());
        }
        assert!(Format::Png.validate(b"<svg/>").is_err());
        assert!(Format::Jpeg.validate(b"<html/>").is_err());
    }
    #[test]
    fn names_are_bounded_basename_suggestions_with_fixed_extension() {
        assert_eq!(
            sanitized_name("../report.html", Format::Png).unwrap(),
            "_report.html.png"
        );
        assert_eq!(
            sanitized_name("CON", Format::Text).unwrap(),
            "artifact-CON.txt"
        );
        assert_eq!(sanitized_name("...", Format::Text).unwrap(), "artifact.txt");
        assert_eq!(sanitized_name("a/b:c", Format::Jpeg).unwrap(), "a_b_c.jpg");
        assert!(sanitized_name(&"x".repeat(1025), Format::Text).is_err());
        assert!(
            sanitized_name(&"日".repeat(200), Format::Text)
                .unwrap()
                .len()
                <= 164
        );
    }
    #[test]
    fn strict_request_does_not_accept_paths_urls_extra_or_duplicate_fields() {
        let (_, _, context) = fixture();
        let value = serde_json::json!({"context":{"workspaceId":context.workspace_id,"viewId":context.view_id,"tabId":context.tab_id,"request":1,"revision":1,"token":context.token},"format":"text","name":"a","data":""});
        assert!(serde_json::from_value::<Request>(value.clone()).is_ok());
        let mut value = value;
        value["path"] = serde_json::json!("/untrusted/file.txt");
        assert!(serde_json::from_value::<Request>(value).is_err());
        assert!(serde_json::from_str::<Context>(r#"{"workspaceId":"a","workspaceId":"b","viewId":"c","tabId":"d","request":1,"revision":1,"token":"e"}"#).is_err());
    }
}
