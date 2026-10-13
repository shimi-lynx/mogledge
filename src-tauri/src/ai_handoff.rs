//! Path references only: no file reads, caller URLs, commands, or permission overrides.
use crate::{core::Core, file_actions};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Destination {
    CodexApp,
    ClaudeApp,
    CodexCli,
    ClaudeCli,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub selected_path: String,
    pub working_directory: String,
    pub revision: u64,
    pub kind: TargetKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guide_instruction: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    File,
    Folder,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentContext {
    pub workspace_id: String,
    pub view_id: String,
    pub relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RootTarget {
    Root,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RootContext {
    pub workspace_id: String,
    pub view_id: String,
    pub target: RootTarget,
}

// Existing document payloads remain unchanged. The root route cannot carry an
// empty relative path or caller-selected absolute path, even as an extra field.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Context {
    Document(DocumentContext),
    Root(RootContext),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub context: Context,
    pub preview: Preview,
    pub instruction: String,
    pub destination: Destination,
    pub copy: bool,
}

enum ReferenceGuard {
    Document(crate::knowledge::PathReferenceGuard),
    Root(crate::knowledge::RootReferenceGuard),
}

impl ReferenceGuard {
    fn revalidate(&self, root: &std::path::Path, dir: &cap_std::fs::Dir) -> Result<(), String> {
        match self {
            Self::Document(guard) => guard.revalidate(root, dir),
            Self::Root(guard) => guard.revalidate(root, dir),
        }
    }
}

fn preview_locked(core: &Core, context: &Context) -> Result<(Preview, ReferenceGuard), String> {
    let (mut preview, guard) = match context {
        Context::Document(context) => document_preview_locked(core, context),
        Context::Root(
            context @ RootContext {
                target: RootTarget::Root,
                ..
            },
        ) => {
            let (root, dir, revision) = {
                let state = core.workspace.lock().unwrap();
                if state.snapshot.workspace_id.as_deref() != Some(&context.workspace_id) {
                    return Err("WorkspaceChanged".into());
                }
                if state.snapshot.view_id != context.view_id {
                    return Err("ViewChanged".into());
                }
                (
                    state.root.clone().ok_or("WorkspaceChanged")?,
                    state.dir.clone().ok_or("WorkspaceChanged")?,
                    state.snapshot.revision,
                )
            };
            let guard = crate::knowledge::RootReferenceGuard::open(&root, &dir)?;
            let path = file_actions::os_path(&root)?;
            validate_local_path(&path)?;
            guard.revalidate(&root, &dir)?;
            Ok((
                Preview {
                    selected_path: path.clone(),
                    working_directory: path,
                    revision,
                    kind: TargetKind::Folder,
                    guide_instruction: None,
                },
                ReferenceGuard::Root(guard),
            ))
        }
    }?;
    let (workspace, view, cwd) = match context {
        Context::Root(context) => (&context.workspace_id, &context.view_id, ""),
        Context::Document(context) => (
            &context.workspace_id,
            &context.view_id,
            if preview.kind == TargetKind::Folder {
                context.relative_path.as_str()
            } else {
                context
                    .relative_path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or("")
            },
        ),
    };
    preview.guide_instruction =
        crate::html_authoring::guide_instruction_locked(core, workspace, view, cwd)?;
    Ok((preview, guard))
}

fn document_preview_locked(
    core: &Core,
    context: &DocumentContext,
) -> Result<(Preview, ReferenceGuard), String> {
    let (path, folder, _guard) = file_actions::validate(
        core,
        &context.workspace_id,
        &context.view_id,
        &context.relative_path,
    )?;
    let selected_path = file_actions::os_path(&path)?;
    let working_directory = file_actions::os_path(if folder {
        &path
    } else {
        path.parent().ok_or("親フォルダーを解決できません")?
    })?;
    validate_local_path(&selected_path)?;
    validate_local_path(&working_directory)?;
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    let path_guard =
        crate::knowledge::PathReferenceGuard::open(&root, &dir, &context.relative_path, folder)?;
    path_guard.revalidate(&root, &dir)?;
    let revision = core.workspace.lock().unwrap().snapshot.revision;
    Ok((
        Preview {
            selected_path,
            working_directory,
            revision,
            kind: if folder {
                TargetKind::Folder
            } else {
                TargetKind::File
            },
            guide_instruction: None,
        },
        ReferenceGuard::Document(path_guard),
    ))
}

pub fn prepare(core: &Core, context: &Context) -> Result<Preview, String> {
    let _gate = core.gate.lock().unwrap();
    preview_locked(core, context).map(|(preview, _guard)| preview)
}

fn invisible(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{00ad}' | '\u{061c}' | '\u{180e}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}'
        )
}

// These links select local workspaces. Reject UNC/network forms and ambiguous
// display paths rather than sending a directory the receiving tool may ignore.
fn validate_local_path(path: &str) -> Result<(), String> {
    if path.starts_with('\\')
        || path.starts_with("//")
        || path.contains("://")
        || path.split(['/', '\\']).any(|part| part == "..")
        || path.chars().any(invisible)
        || !(path.starts_with('/')
            || (path.as_bytes().get(1) == Some(&b':')
                && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && path
                    .as_bytes()
                    .get(2)
                    .is_some_and(|ch| *ch == b'\\' || *ch == b'/')))
    {
        return Err(
            "ローカルの絶対パスが必要です。ネットワーク・不可視文字を含むパスは利用できません"
                .into(),
        );
    }
    Ok(())
}

fn validate_instruction(instruction: &str) -> Result<(), String> {
    // Count UTF-16 conservatively, including astral characters as two units.
    if instruction.encode_utf16().count() > 64 * 1024
        || instruction
            .chars()
            .any(|ch| invisible(ch) && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err("依頼文は65,536文字以内にし、不可視制御文字を除いてください".into());
    }
    Ok(())
}

pub fn draft(preview: &Preview, instruction: &str) -> Result<String, String> {
    validate_instruction(instruction)?;
    // Clipboard payloads have no separate cwd. Retain the selected path even
    // for a folder, including Codex CLI's copy-only workflow.
    Ok(if instruction.is_empty() {
        preview.selected_path.clone()
    } else {
        format!("{}\n\n{}", preview.selected_path, instruction)
    })
}

fn link_draft(preview: &Preview, instruction: &str) -> Result<String, String> {
    if preview.kind == TargetKind::File {
        draft(preview, instruction)
    } else {
        validate_instruction(instruction)?;
        // Folder selection is already carried by the fixed cwd parameter.
        // Preserve the user's text exactly, including whitespace and paths.
        Ok(instruction.into())
    }
}

pub fn deep_link(
    preview: &Preview,
    instruction: &str,
    destination: Destination,
) -> Result<String, String> {
    validate_local_path(&preview.selected_path)?;
    validate_local_path(&preview.working_directory)?;
    let prompt = link_draft(preview, instruction)?;
    let limit = match destination {
        // Desktop documents an approximate truncation threshold, so leave a
        // margin instead of implying that exactly 14,000 is lossless.
        Destination::ClaudeApp => 12_000,
        Destination::ClaudeCli => 5_000,
        Destination::CodexApp => 64 * 1024,
        Destination::CodexCli => {
            return Err("Codex CLIには本文をコピーして手動で貼り付けてください".into())
        }
    };
    if prompt.encode_utf16().count() > limit {
        return Err(format!(
            "この連携先の下書き本文は{limit}文字以内です。短くするか本文をコピーしてください"
        ));
    }
    let cwd = utf8_percent_encode(&preview.working_directory, NON_ALPHANUMERIC);
    let has_prompt = !prompt.is_empty();
    let prompt = utf8_percent_encode(&prompt, NON_ALPHANUMERIC);
    let (mut url, prompt_key) = match destination {
        Destination::CodexApp => (format!("codex://new?path={cwd}"), "prompt"),
        Destination::ClaudeApp => (format!("claude://code/new?folder={cwd}"), "q"),
        Destination::ClaudeCli => (format!("claude-cli://open?cwd={cwd}"), "q"),
        Destination::CodexCli => unreachable!(),
    };
    if has_prompt {
        url.push_str(&format!("&{prompt_key}={prompt}"));
    }
    // Encoded Japanese can reach OS URL limits well before a prompt limit.
    if url.len() > 30_000 {
        return Err("エンコード後のリンクが長すぎます。短くするか本文をコピーしてください".into());
    }
    Ok(url)
}

pub fn perform(
    core: &Core,
    request: &Request,
    execute: impl FnOnce(&file_actions::ActionTarget) -> Result<(), String>,
) -> Result<(), String> {
    let _gate = core.gate.lock().unwrap();
    let (current, path_guard) = preview_locked(core, &request.context)?;
    if current != request.preview {
        return Err("対象が変更されました。確認画面を開き直してください".into());
    }
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    // Retain root or leaf/ancestor metadata handles through dispatch. A file's
    // cwd is its parent; explicit roots use the selected root for both paths.
    let instruction = match &current.guide_instruction {
        Some(guide) if request.instruction.is_empty() => guide.clone(),
        Some(guide) => format!("{}\n\n{}", request.instruction, guide),
        None => request.instruction.clone(),
    };
    let (action, target) = if request.copy {
        (
            file_actions::FileAction::CopyPath,
            draft(&current, &instruction)?,
        )
    } else {
        (
            file_actions::FileAction::OpenFolder,
            deep_link(&current, &instruction, request.destination)?,
        )
    };
    path_guard.revalidate(&root, &dir)?;
    execute(&file_actions::ActionTarget { action, target })
}

#[cfg(test)]
mod tests {
    use super::*;
    use percent_encoding::percent_decode_str;

    fn preview() -> Preview {
        Preview {
            selected_path: "/fixture/日本語 & #?%/a.html".into(),
            working_directory: "/fixture/日本語 & #?%".into(),
            revision: 1,
            kind: TargetKind::File,
            guide_instruction: None,
        }
    }

    #[test]
    fn encoded_links_round_trip_path_and_inert_prompt_without_extra_parameters() {
        let preview = preview();
        let instruction = "依頼文\n&folder=/evil? #%'\" $(do-not-run) ;";
        for (destination, prefix, directory_key, prompt_key) in [
            (Destination::CodexApp, "codex://new?", "path", "prompt"),
            (Destination::ClaudeApp, "claude://code/new?", "folder", "q"),
            (Destination::ClaudeCli, "claude-cli://open?", "cwd", "q"),
        ] {
            let url = deep_link(&preview, instruction, destination).unwrap();
            let query = url.strip_prefix(prefix).unwrap();
            let pairs: Vec<_> = query.split('&').collect();
            assert_eq!(pairs.len(), 2);
            for (pair, key, expected) in [
                (pairs[0], directory_key, preview.working_directory.clone()),
                (pairs[1], prompt_key, draft(&preview, instruction).unwrap()),
            ] {
                let (actual_key, value) = pair.split_once('=').unwrap();
                assert_eq!(actual_key, key);
                assert_eq!(percent_decode_str(value).decode_utf8().unwrap(), expected);
            }
        }
        assert_eq!(draft(&preview, "").unwrap(), preview.selected_path);
        assert_eq!(
            draft(&preview, " \n").unwrap(),
            format!("{}\n\n \n", preview.selected_path)
        );
        assert!(deep_link(&preview, "", Destination::CodexCli).is_err());
    }

    #[test]
    fn lengths_include_selected_path_and_utf16_and_never_truncate() {
        let preview = preview();
        for (destination, limit) in [
            (Destination::ClaudeCli, 5_000),
            (Destination::ClaudeApp, 12_000),
        ] {
            let remaining = limit - preview.selected_path.encode_utf16().count() - 2;
            assert!(deep_link(&preview, &"a".repeat(remaining), destination).is_ok());
            assert!(deep_link(&preview, &"a".repeat(remaining + 1), destination).is_err());
        }
        assert!(deep_link(&preview, &"😀".repeat(2_500), Destination::ClaudeCli).is_err());
        assert!(deep_link(&preview, &"語".repeat(4_000), Destination::ClaudeCli).is_err());
        assert_eq!(
            draft(&preview, &"語".repeat(5_000))
                .unwrap()
                .chars()
                .count(),
            preview.selected_path.chars().count() + 5_002
        );
        assert!(draft(&preview, &"a".repeat(65_537)).is_err());
        assert!(draft(&preview, "nul\0or\u{202e}bidi").is_err());
    }

    #[test]
    fn folder_links_carry_cwd_without_an_automatic_prompt_path_and_copy_retains_it() {
        let folder = Preview {
            selected_path: "/fixture/日本語 & #?%".into(),
            working_directory: "/fixture/日本語 & #?%".into(),
            revision: 1,
            kind: TargetKind::Folder,
            guide_instruction: None,
        };
        for (destination, prefix, cwd_key, prompt_key) in [
            (Destination::CodexApp, "codex://new?", "path", "prompt"),
            (Destination::ClaudeApp, "claude://code/new?", "folder", "q"),
            (Destination::ClaudeCli, "claude-cli://open?", "cwd", "q"),
        ] {
            for instruction in [
                "",
                " \n\t",
                "/fixture/日本語 & #?%\nこのパスを残す &cwd=/evil? #%'\"",
            ] {
                let url = deep_link(&folder, instruction, destination).unwrap();
                let query = url.strip_prefix(prefix).unwrap();
                let pairs: Vec<_> = query.split('&').collect();
                assert_eq!(pairs.len(), if instruction.is_empty() { 1 } else { 2 });
                let (key, value) = pairs[0].split_once('=').unwrap();
                assert_eq!(key, cwd_key);
                assert_eq!(
                    percent_decode_str(value).decode_utf8().unwrap(),
                    folder.working_directory
                );
                if !instruction.is_empty() {
                    let (key, value) = pairs[1].split_once('=').unwrap();
                    assert_eq!(key, prompt_key);
                    assert_eq!(
                        percent_decode_str(value).decode_utf8().unwrap(),
                        instruction
                    );
                }
                assert_eq!(
                    draft(&folder, instruction).unwrap(),
                    if instruction.is_empty() {
                        folder.selected_path.clone()
                    } else {
                        format!("{}\n\n{instruction}", folder.selected_path)
                    }
                );
            }
        }
        for (destination, limit) in [
            (Destination::ClaudeCli, 5_000),
            (Destination::ClaudeApp, 12_000),
        ] {
            assert!(deep_link(&folder, &"a".repeat(limit), destination).is_ok());
            assert!(deep_link(&folder, &"a".repeat(limit + 1), destination).is_err());
        }
        assert!(deep_link(&folder, &"語".repeat(4_000), Destination::ClaudeCli).is_err());
        for invalid in ["nul\0", "bidi\u{202e}"] {
            assert!(deep_link(&folder, invalid, Destination::CodexApp).is_err());
            assert!(draft(&folder, invalid).is_err());
        }
        assert!(deep_link(&folder, &"a".repeat(65_537), Destination::CodexApp).is_err());
        assert!(deep_link(&folder, "", Destination::CodexCli).is_err());
    }

    #[test]
    fn local_directory_constraints_reject_network_traversal_and_hidden_characters() {
        for path in [
            "relative",
            "//server/share",
            r"\\server\share",
            r"\\?\UNC\server\share",
            "/a/../b",
            r"C:\a\..\b",
            "/a/\u{200b}b",
            "/a/\u{202e}b",
            "/a/line\nb",
            "smb://server/share",
        ] {
            assert!(validate_local_path(path).is_err(), "{path:?}");
        }
        for path in [
            "/fixture/日本語 & #?%",
            r"C:\fixture\日本語 &",
            "/fixture/folder..name",
        ] {
            assert!(validate_local_path(path).is_ok());
        }
        assert!(serde_json::from_str::<Destination>("\"evilScheme\"").is_err());
    }

    #[test]
    fn current_workspace_file_parent_folder_and_failed_dispatch_are_guarded() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("folder")).unwrap();
        std::fs::write(tmp.path().join("folder/a.html"), "fixture").unwrap();
        let core = Core::new(19103);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let mut context = Context::Document(DocumentContext {
            workspace_id: snapshot.workspace_id.unwrap(),
            view_id: snapshot.view_id,
            relative_path: "folder/a.html".into(),
        });
        let file = prepare(&core, &context).unwrap();
        assert_eq!(file.kind, TargetKind::File);
        let Context::Document(document) = &context else {
            unreachable!()
        };
        let mut forged_file = Request {
            context: Context::Document(DocumentContext {
                workspace_id: document.workspace_id.clone(),
                view_id: document.view_id.clone(),
                relative_path: document.relative_path.clone(),
            }),
            preview: file.clone(),
            instruction: "".into(),
            destination: Destination::CodexApp,
            copy: false,
        };
        forged_file.preview.kind = TargetKind::Folder;
        for copy in [true, false] {
            forged_file.copy = copy;
            assert!(perform(&core, &forged_file, |_| panic!(
                "forged file kind dispatched"
            ))
            .is_err());
        }
        assert!(file.selected_path.ends_with("a.html"));
        assert_eq!(
            file.working_directory,
            file_actions::os_path(&tmp.path().join("folder")).unwrap()
        );
        let Context::Document(document) = &mut context else {
            unreachable!()
        };
        document.relative_path = "folder".into();
        let folder = prepare(&core, &context).unwrap();
        assert_eq!(folder.kind, TargetKind::Folder);
        assert_eq!(folder.selected_path, folder.working_directory);
        let mut request = Request {
            context,
            preview: folder,
            instruction: "".into(),
            destination: Destination::CodexApp,
            copy: true,
        };
        request.preview.kind = TargetKind::File;
        for copy in [true, false] {
            request.copy = copy;
            assert!(perform(&core, &request, |_| panic!("forged folder kind dispatched")).is_err());
        }
        request.preview.kind = TargetKind::Folder;
        request.copy = true;
        request.destination = Destination::CodexCli;
        perform(&core, &request, |target| {
            assert_eq!(target.action, file_actions::FileAction::CopyPath);
            assert_eq!(target.target, request.preview.selected_path);
            Ok(())
        })
        .unwrap();
        assert!(perform(&core, &request, |_| Err("fixture OS failure".into())).is_err());
        request.preview.working_directory.push_str("/evil");
        assert!(perform(&core, &request, |_| panic!("unreviewed target dispatched")).is_err());
        request.preview = prepare(&core, &request.context).unwrap();
        let Context::Document(context) = &mut request.context else {
            unreachable!()
        };
        context.view_id = "stale".into();
        assert!(perform(&core, &request, |_| panic!("stale view dispatched")).is_err());
        let Context::Document(context) = &mut request.context else {
            unreachable!()
        };
        context.view_id = core.snapshot().view_id;
        request.preview.revision += 1;
        assert!(perform(&core, &request, |_| panic!("stale revision dispatched")).is_err());
        let Context::Document(context) = &mut request.context else {
            unreachable!()
        };
        context.relative_path = "../outside.html".into();
        assert!(prepare(&core, &request.context).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn path_replaced_by_link_and_root_replaced_after_preview_never_dispatch() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("knowledge");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.html"), "fixture").unwrap();
        let core = Core::new(19104);
        let snapshot = core.select(&root, false).unwrap();
        let context = Context::Document(DocumentContext {
            workspace_id: snapshot.workspace_id.unwrap(),
            view_id: snapshot.view_id,
            relative_path: "a.html".into(),
        });
        let request = Request {
            preview: prepare(&core, &context).unwrap(),
            context,
            instruction: "".into(),
            destination: Destination::CodexApp,
            copy: false,
        };
        std::fs::write(tmp.path().join("outside.html"), "outside").unwrap();
        std::fs::remove_file(root.join("a.html")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside.html"), root.join("a.html")).unwrap();
        assert!(perform(&core, &request, |_| panic!("link dispatched")).is_err());
        std::fs::rename(&root, tmp.path().join("previous")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.html"), "replacement").unwrap();
        assert!(perform(&core, &request, |_| panic!("replaced root dispatched")).is_err());
    }

    #[test]
    fn retained_file_guard_protects_ancestors_and_leaf_until_dispatch_completes() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("folder")).unwrap();
        std::fs::write(tmp.path().join("folder/a.html"), "fixture").unwrap();
        let (root, dir) = crate::knowledge::open_root(tmp.path()).unwrap();
        let guard = crate::knowledge::PathReferenceGuard::open(&root, &dir, "folder/a.html", false)
            .unwrap();
        guard.revalidate(&root, &dir).unwrap();
        #[cfg(windows)]
        {
            assert!(std::fs::rename(root.join("folder"), root.join("previous")).is_err());
            assert!(std::fs::remove_file(root.join("folder/a.html")).is_err());
            drop(guard);
            std::fs::rename(root.join("folder"), root.join("previous")).unwrap();
        }
        #[cfg(unix)]
        {
            std::fs::rename(root.join("folder"), root.join("previous")).unwrap();
            std::fs::create_dir(root.join("folder")).unwrap();
            std::fs::write(root.join("folder/a.html"), "replacement").unwrap();
            assert!(guard.revalidate(&root, &dir).is_err());
        }
    }

    fn root_context(workspace_id: &str, view_id: &str) -> Context {
        Context::Root(RootContext {
            workspace_id: workspace_id.into(),
            view_id: view_id.into(),
            target: RootTarget::Root,
        })
    }

    #[test]
    fn explicit_root_context_rejects_mixed_unknown_and_duplicate_fields() {
        assert!(matches!(
            serde_json::from_str::<Context>(r#"{"workspaceId":"w","viewId":"v","target":"root"}"#)
                .unwrap(),
            Context::Root(_)
        ));
        assert!(matches!(
            serde_json::from_str::<Context>(
                r#"{"workspaceId":"w","viewId":"v","relativePath":"a.html"}"#
            )
            .unwrap(),
            Context::Document(_)
        ));
        for invalid in [
            r#"{"workspaceId":"w","viewId":"v","target":"root","relativePath":""}"#,
            r#"{"workspaceId":"w","viewId":"v","target":"root","relativePath":"folder"}"#,
            r#"{"workspaceId":"w","viewId":"v","target":"root","selectedPath":"/other"}"#,
            r#"{"workspaceId":"w","viewId":"v","target":"root","workingDirectory":"/other"}"#,
            r#"{"workspaceId":"w","viewId":"v","target":"other"}"#,
            r#"{"workspaceId":"w","viewId":"v","target":"root","target":"root"}"#,
            r#"{"workspaceId":"w","workspaceId":"w","viewId":"v","target":"root"}"#,
            r#"{"workspaceId":"w","viewId":"v","viewId":"v","target":"root"}"#,
            r#"{"workspaceId":"w","viewId":"v","relativePath":"a.html","extra":true}"#,
            r#"{"workspaceId":"w","viewId":"v","relativePath":"a.html","relativePath":"folder"}"#,
        ] {
            assert!(
                serde_json::from_str::<Context>(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn explicit_root_prepare_copy_and_dispatch_revalidate_current_root_and_preview() {
        let core = Core::new(19105);
        assert!(prepare(&core, &root_context("missing", "missing")).is_err());
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("日本語ルート");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("folder")).unwrap();
        let snapshot = core.select(&root, false).unwrap();
        let workspace = snapshot.workspace_id.unwrap();
        let context = root_context(&workspace, &snapshot.view_id);
        let preview = prepare(&core, &context).unwrap();
        let root_path = file_actions::os_path(&root).unwrap();
        assert_eq!(preview.selected_path, root_path);
        assert_eq!(preview.working_directory, root_path);
        assert_eq!(preview.kind, TargetKind::Folder);
        assert!(prepare(&core, &root_context("stale", &snapshot.view_id)).is_err());
        assert!(prepare(&core, &root_context(&workspace, "stale")).is_err());
        assert!(crate::knowledge::validate_relative("").is_err());
        assert!(file_actions::validate(&core, &workspace, &snapshot.view_id, "").is_err());
        let empty_document = Context::Document(DocumentContext {
            workspace_id: workspace.clone(),
            view_id: snapshot.view_id.clone(),
            relative_path: "".into(),
        });
        assert!(prepare(&core, &empty_document).is_err());
        let document_context = Context::Document(DocumentContext {
            workspace_id: workspace.clone(),
            view_id: snapshot.view_id.clone(),
            relative_path: "folder".into(),
        });
        let folder_preview = prepare(&core, &document_context).unwrap();
        let mut request = Request {
            context,
            preview: preview.clone(),
            instruction: "日本語の依頼 & ? # %".into(),
            destination: Destination::CodexApp,
            copy: true,
        };
        request.preview.kind = TargetKind::File;
        for copy in [true, false] {
            request.copy = copy;
            assert!(perform(&core, &request, |_| panic!("forged root kind dispatched")).is_err());
        }
        request.preview.kind = TargetKind::Folder;
        request.copy = true;
        perform(&core, &request, |target| {
            assert_eq!(target.action, file_actions::FileAction::CopyPath);
            assert_eq!(
                target.target,
                format!("{root_path}\n\n{}", request.instruction)
            );
            Ok(())
        })
        .unwrap();
        request.instruction.clear();
        perform(&core, &request, |target| {
            assert_eq!(target.target, root_path);
            Ok(())
        })
        .unwrap();
        request.copy = false;
        perform(&core, &request, |target| {
            assert_eq!(target.action, file_actions::FileAction::OpenFolder);
            assert_eq!(
                target.target,
                deep_link(&preview, "", Destination::CodexApp).unwrap()
            );
            #[cfg(windows)]
            assert!(std::fs::rename(&root, fixture.path().join("moved")).is_err());
            Ok(())
        })
        .unwrap();
        assert!(perform(&core, &request, |_| Err("fixture OS failure".into())).is_err());
        request.preview = folder_preview.clone();
        assert!(perform(&core, &request, |_| panic!("folder preview reused as root")).is_err());
        request.context = document_context;
        request.preview = preview.clone();
        assert!(perform(&core, &request, |_| panic!("root preview reused as folder")).is_err());
        request.context = root_context(&workspace, &snapshot.view_id);
        request.preview.revision += 1;
        assert!(perform(&core, &request, |_| panic!("stale revision dispatched")).is_err());
        request.preview = preview.clone();
        request.preview.working_directory.push_str("/folder");
        assert!(perform(&core, &request, |_| panic!("unreviewed cwd dispatched")).is_err());
        request.preview = preview;
        for copy in [true, false] {
            request.copy = copy;
            request.context = root_context("stale", &snapshot.view_id);
            assert!(perform(&core, &request, |_| panic!("stale workspace dispatched")).is_err());
            request.context = root_context(&workspace, "stale");
            assert!(perform(&core, &request, |_| panic!("stale view dispatched")).is_err());
        }
        request.context = root_context(&workspace, &snapshot.view_id);
        let other = tempfile::tempdir().unwrap();
        core.select(other.path(), false).unwrap();
        for copy in [true, false] {
            request.copy = copy;
            assert!(perform(&core, &request, |_| panic!("past root dispatched")).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn explicit_root_replacement_and_symlink_after_preview_never_dispatch() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("knowledge");
        std::fs::create_dir(&root).unwrap();
        let core = Core::new(19106);
        let snapshot = core.select(&root, false).unwrap();
        let context = root_context(&snapshot.workspace_id.unwrap(), &snapshot.view_id);
        let mut request = Request {
            preview: prepare(&core, &context).unwrap(),
            context,
            instruction: "".into(),
            destination: Destination::CodexApp,
            copy: false,
        };
        let (_, dir) = crate::knowledge::open_root(&root).unwrap();
        let guard = crate::knowledge::RootReferenceGuard::open(&root, &dir).unwrap();
        std::fs::rename(&root, fixture.path().join("previous")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(guard.revalidate(&root, &dir).is_err());
        for copy in [true, false] {
            request.copy = copy;
            assert!(perform(&core, &request, |_| panic!("replaced root dispatched")).is_err());
        }
        std::fs::remove_dir(&root).unwrap();
        std::os::unix::fs::symlink(fixture.path().join("previous"), &root).unwrap();
        for copy in [true, false] {
            request.copy = copy;
            assert!(perform(&core, &request, |_| panic!("linked root dispatched")).is_err());
        }
    }
}
