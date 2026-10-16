use crate::core::Core;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Weak,
    },
    thread,
    time::{Duration, Instant},
};

pub struct WatchHandle {
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}
impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

pub fn start(core: Weak<Core>, root: PathBuf, id: String) -> Result<WatchHandle, String> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .map_err(|_| "ファイル監視を開始できません。再走査で再試行してください".to_owned())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|_| "knowledgeを監視できません。再走査で再試行してください".to_owned())?;
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            let first = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => event,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => {
                    if !stop.load(Ordering::Acquire) {
                        if let Some(core) = core.upgrade() {
                            core.apply_change(
                                &id,
                                Vec::new(),
                                true,
                                Some("ファイル監視が停止しました。再走査してください".into()),
                            );
                        }
                    }
                    break;
                }
            };
            let began = Instant::now();
            let mut events = vec![first];
            loop {
                if stop.load(Ordering::Acquire) {
                    return;
                }
                let remaining = Duration::from_secs(1).saturating_sub(began.elapsed());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(250).min(remaining)) {
                    Ok(event) => events.push(event),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !stop.load(Ordering::Acquire) {
                            if let Some(core) = core.upgrade() {
                                core.apply_change(
                                    &id,
                                    Vec::new(),
                                    true,
                                    Some("ファイル監視が停止しました。再走査してください".into()),
                                );
                            }
                        }
                        break;
                    }
                }
            }
            if stop.load(Ordering::Acquire) {
                return;
            }
            let Some(core) = core.upgrade() else {
                return;
            };
            apply_events(&core, &root, &id, events);
        }
    });
    Ok(WatchHandle {
        _watcher: watcher,
        stopped,
    })
}

fn apply_events(core: &Core, root: &Path, id: &str, events: Vec<notify::Result<Event>>) {
    let mut paths = BTreeSet::new();
    let mut structure = false;
    let mut force_rescan = false;
    let mut error = None;
    let mut structural_only = true;
    for result in events {
        match result {
            Ok(event) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                let relevant = event
                    .paths
                    .iter()
                    .filter_map(|path| {
                        path.strip_prefix(root).ok().map(|p| {
                            p.components()
                                .map(|v| v.as_os_str().to_string_lossy())
                                .collect::<Vec<_>>()
                                .join("/")
                        })
                    })
                    .filter(|path| !path.split('/').any(|s| s.starts_with('.')))
                    .collect::<Vec<_>>();
                if event.need_rescan() {
                    structure = true;
                    force_rescan = true;
                }
                if relevant.is_empty() {
                    continue;
                }
                if matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Any
                        | EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) || event.need_rescan()
                {
                    structure = true;
                }
                // A coalesced batch may contain a native create/rename
                // and an external same-size edit of the same path.
                // Only known structural kinds can use metadata echoes.
                if !matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(notify::event::ModifyKind::Name(_))
                ) {
                    structural_only = false;
                }
                paths.extend(relevant);
            }
            Err(_) => {
                structure = true;
                error = Some("ファイル監視でエラーが発生しました。再走査してください".into());
            }
        }
    }
    if paths.is_empty() && error.is_none() && !structure {
        return;
    }
    if force_rescan {
        core.apply_rescan(id, paths.into_iter().collect(), error);
    } else if !structural_only {
        core.apply_content_change(id, paths.into_iter().collect(), structure, error);
    } else {
        core.apply_change(id, paths.into_iter().collect(), structure, error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        core::Snapshot,
        tree_mutations::{self, Mutation},
    };
    use notify::event::{CreateKind, DataChange, MetadataKind, ModifyKind};

    fn native_rename() -> (tempfile::TempDir, Arc<Core>, Snapshot, PathBuf) {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("documents");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("before.html"), "<title>external fixture</title>").unwrap();
        let core = Core::new(19072);
        core.settings_path
            .set(temporary.path().join("config/settings.json"))
            .unwrap();
        let snapshot = core.select(&root, false).unwrap();
        drop(core.watcher.lock().unwrap().take());
        let result = tree_mutations::perform(
            &core,
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            Mutation::RenameHtml {
                source: "before.html".into(),
                name: "Echo".into(),
            },
        )
        .unwrap();
        assert!(result.warning.is_none());
        assert!(!core.workspace.lock().unwrap().mutation_echoes.is_empty());
        (temporary, core, result.snapshot, root)
    }
    fn event(root: &Path, kind: EventKind) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(root.join("Echo.html")))
    }

    #[test]
    fn mixed_create_and_data_batch_preserves_content_notification_in_either_order() {
        for data_first in [false, true] {
            let (_temporary, core, snapshot, root) = native_rename();
            let workspace = snapshot.workspace_id.as_deref().unwrap();
            let create = event(&root, EventKind::Create(CreateKind::File));
            let data = event(
                &root,
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
            );
            let events = if data_first {
                vec![data, create]
            } else {
                vec![create, data]
            };
            // File metadata is still exactly the native rename fingerprint.
            apply_events(&core, &root, workspace, events);
            assert_eq!(core.snapshot().revision, snapshot.revision + 1);
            assert!(core.workspace.lock().unwrap().mutation_echoes.is_empty());
            // The old native echo must not hide a subsequent matching event.
            apply_events(
                &core,
                &root,
                workspace,
                vec![event(&root, EventKind::Create(CreateKind::File))],
            );
            assert_eq!(core.snapshot().revision, snapshot.revision + 2);
        }
    }

    #[test]
    fn content_metadata_and_ambiguous_kinds_bypass_matching_echoes() {
        for kind in [
            EventKind::Modify(ModifyKind::Data(DataChange::Any)),
            EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
            EventKind::Modify(ModifyKind::Any),
            EventKind::Modify(ModifyKind::Other),
            EventKind::Any,
            EventKind::Other,
        ] {
            let (_temporary, core, snapshot, root) = native_rename();
            let workspace = snapshot.workspace_id.as_deref().unwrap();
            std::fs::write(root.join("unreported.html"), "external").unwrap();
            apply_events(&core, &root, workspace, vec![event(&root, kind)]);
            assert_eq!(core.snapshot().revision, snapshot.revision + 1, "{kind:?}");
            assert!(core.workspace.lock().unwrap().mutation_echoes.is_empty());
            // Pure content/metadata keep the existing incremental tree path;
            // Any retains the existing structural rescan requirement.
            assert_eq!(
                crate::knowledge::contains(&core.snapshot().nodes, "unreported.html"),
                kind == EventKind::Any
            );
        }
    }

    #[test]
    fn explicit_structural_only_rename_echo_still_avoids_duplicate_publication() {
        let (_temporary, core, snapshot, root) = native_rename();
        apply_events(
            &core,
            &root,
            snapshot.workspace_id.as_deref().unwrap(),
            vec![event(&root, EventKind::Create(CreateKind::File))],
        );
        assert_eq!(core.snapshot().revision, snapshot.revision);
    }
}
