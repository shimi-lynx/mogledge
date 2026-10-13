use crate::{
    core::Core, document_server, file_actions::ActionTarget, file_actions::FileAction, knowledge,
};
use axum::http::Uri;
use serde::Serialize;

const MAX_LINK_BYTES: usize = 8192;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinkTarget {
    Page {
        fragment: String,
    },
    Document {
        relative_path: String,
        fragment: String,
    },
    External {
        url: String,
    },
}

fn http_uri(url: &str) -> Result<(Uri, String), String> {
    if url.len() > MAX_LINK_BYTES
        || url.chars().any(|ch| {
            ch.is_control() || ch.is_whitespace() || matches!(ch, '"' | '<' | '>' | '\\' | '`')
        })
    {
        return Err("リンクURLが無効です".into());
    }
    let (address, fragment) = url
        .split_once('#')
        .map_or((url, ""), |(address, fragment)| (address, fragment));
    let uri: Uri = address.parse().map_err(|_| "リンクURLが無効です")?;
    let authority = uri.authority().ok_or("リンクURLが無効です")?;
    // Authority::port also returns None for an invalid port; detect its syntax separately.
    let explicit_port = if authority.as_str().starts_with('[') {
        authority
            .as_str()
            .split_once(']')
            .is_some_and(|(_, tail)| !tail.is_empty())
    } else {
        authority.as_str().contains(':')
    };
    if !matches!(uri.scheme_str(), Some("http" | "https"))
        || authority.host().is_empty()
        || authority.as_str().contains(['@', '%', '\\'])
        || (explicit_port && authority.port_u16().is_none())
    {
        return Err("HTTP/HTTPSのリンクだけを開けます".into());
    }
    Ok((
        uri,
        if fragment.is_empty() {
            String::new()
        } else {
            format!("#{fragment}")
        },
    ))
}

fn same_origin(core: &Core, uri: &Uri) -> bool {
    uri.scheme_str() == Some("http")
        && uri.authority().is_some_and(|authority| {
            Some(authority.as_str()) == core.origin.strip_prefix("http://")
        })
}

fn resolve_locked(
    core: &Core,
    workspace: &str,
    view: &str,
    source_url: &str,
    href: &str,
) -> Result<LinkTarget, String> {
    let (source, _) = http_uri(source_url)?;
    if !same_origin(core, &source) {
        return Err("リンクの送信元が無効です".into());
    }
    let (token, path) =
        document_server::decode_path(source.path()).ok_or("リンクの送信元が無効です")?;
    {
        let state = core
            .workspace
            .lock()
            .map_err(|_| "リンクを確認できません")?;
        if state.snapshot.workspace_id.as_deref() != Some(workspace)
            || state.snapshot.view_id != view
        {
            return Err("WorkspaceChanged".into());
        }
    }
    let session = core.session_for_token(&token).ok_or("DocumentChanged")?;
    if session.entry != path {
        return Err("DocumentChanged".into());
    }
    knowledge::validate_cached_path(&session.root, &session.dir, &session.entry)?;
    if let Some(identity) = &session.storage_identity {
        if &knowledge::storage_identity(&session.root, &session.dir, &session.entry)? != identity {
            return Err("DocumentChanged".into());
        }
    }
    let (target, fragment) = http_uri(href)?;
    if !same_origin(core, &target) {
        return Ok(LinkTarget::External {
            url: href.to_owned(),
        });
    }
    let (target_token, relative) =
        document_server::decode_path(target.path()).ok_or("このリンク先は開けません")?;
    if target_token != token {
        return Err("このリンク先は開けません".into());
    }
    if relative == session.entry {
        return Ok(LinkTarget::Page { fragment });
    }
    if !knowledge::contains(
        &core
            .workspace
            .lock()
            .map_err(|_| "リンクを確認できません")?
            .snapshot
            .nodes,
        &relative,
    ) {
        return Err("選択フォルダー内のHTMLだけを開けます".into());
    }
    knowledge::validate_cached_path(&session.root, &session.dir, &relative)?;
    Ok(LinkTarget::Document {
        relative_path: relative,
        fragment,
    })
}

pub fn resolve(
    core: &Core,
    workspace: &str,
    view: &str,
    source_url: &str,
    href: &str,
) -> Result<LinkTarget, String> {
    let _gate = core.gate.lock().map_err(|_| "リンクを確認できません")?;
    resolve_locked(core, workspace, view, source_url, href)
}

pub fn open_external(
    core: &Core,
    workspace: &str,
    view: &str,
    source_url: &str,
    href: &str,
    execute: impl FnOnce(&ActionTarget) -> Result<(), String>,
) -> Result<(), String> {
    // Only bundled main UI can call this command. A document message merely
    // proposes a URL; main requires a trusted confirmation click. Revalidate
    // the source and target while holding the lifecycle gate through dispatch.
    let _gate = core.gate.lock().map_err(|_| "リンクを確認できません")?;
    let LinkTarget::External { url } = resolve_locked(core, workspace, view, source_url, href)?
    else {
        return Err("外部HTTP/HTTPSリンクだけを開けます".into());
    };
    execute(&ActionTarget {
        action: FileAction::OpenBrowser,
        target: url,
    })
}

/// Trusted main UI validates a history reference immediately before display.
/// This opens guarded metadata only; it issues no grant and reads no HTML.
pub fn validate_navigation(
    core: &Core,
    workspace: &str,
    view: &str,
    relative: &str,
    fragment: &str,
    tab_id: Option<&str>,
) -> Result<crate::workspace_settings::DocumentRef, String> {
    if fragment.len() > MAX_LINK_BYTES
        || (!fragment.is_empty() && !fragment.starts_with('#'))
        || fragment.chars().any(char::is_control)
    {
        return Err("fragmentが無効です".into());
    }
    let _gate = core.gate.lock().map_err(|_| "履歴を確認できません")?;
    let state = core.workspace.lock().map_err(|_| "履歴を確認できません")?;
    Core::check_view(&state, workspace, view)?;
    if !knowledge::contains(&state.snapshot.nodes, relative) {
        return Err("HTMLが見つかりません".into());
    }
    let root = state.root.as_ref().ok_or("WorkspaceChanged")?;
    let dir = state.dir.as_ref().ok_or("WorkspaceChanged")?;
    let identity = knowledge::storage_identity(root, dir, relative)?;
    if let Some(tab_id) = tab_id {
        let tab = state
            .tabs
            .get(tab_id)
            .filter(|tab| !tab.browser && tab.entry == relative)
            .ok_or("TabClosed")?;
        let session = tab.session.as_ref().ok_or("DocumentChanged")?;
        if session.storage_identity.as_deref() != Some(&identity) {
            return Err("DocumentChanged".into());
        }
    }
    Ok(crate::workspace_settings::DocumentRef {
        relative_path: relative.into(),
        identity,
    })
}
