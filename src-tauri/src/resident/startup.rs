//! Transactional explicit registration; a saved preference is not OS truth.
#[cfg(any(target_os = "macos", test))]
const LEGACY_AGENT: &str = "My Knowledge.plist";
#[cfg(any(target_os = "macos", test))]
const STARTUP_UNAVAILABLE: &str = "ResidentStartupUnavailable";
#[cfg(any(target_os = "macos", test))]
const LEGACY_REGISTRATION: &str = "ResidentStartupLegacyRegistration";

/// Detect only the exact old OS registration, without discovering or transferring app data.
#[cfg(any(target_os = "macos", test))]
pub fn check_legacy_launch_agent(
    launch_agents: &std::path::Path,
    executable: &std::path::Path,
) -> Result<(), &'static str> {
    use std::{io::Read, path::Component};

    let macos = executable.parent().ok_or(STARTUP_UNAVAILABLE)?;
    let contents = macos.parent().ok_or(STARTUP_UNAVAILABLE)?;
    let bundle = contents.parent().ok_or(STARTUP_UNAVAILABLE)?;
    if !executable.is_absolute()
        || executable
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || executable.file_name() != Some(std::ffi::OsStr::new("mogledge"))
        || macos.file_name() != Some(std::ffi::OsStr::new("MacOS"))
        || contents.file_name() != Some(std::ffi::OsStr::new("Contents"))
        || bundle.extension() != Some(std::ffi::OsStr::new("app"))
    {
        return Err(STARTUP_UNAVAILABLE);
    }
    let Some(directory) = crate::identifier_migration::directory(launch_agents, false)
        .map_err(|_| STARTUP_UNAVAILABLE)?
    else {
        return Ok(());
    };
    let metadata = match directory.symlink_metadata(LEGACY_AGENT) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(STARTUP_UNAVAILABLE),
    };
    const MAX_AGENT_BYTES: u64 = 16 * 1024;
    if !metadata.is_file() || metadata.len() > MAX_AGENT_BYTES {
        return Err(STARTUP_UNAVAILABLE);
    }
    // Existing adapters open every ancestor and leaf without following links, reject
    // special/multiply-linked files, and do not create a missing directory or file.
    let file = crate::identifier_migration::read_file(&directory, LEGACY_AGENT, false)
        .map_err(|_| STARTUP_UNAVAILABLE)?;
    let mut bytes = Vec::new();
    file.take(MAX_AGENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| STARTUP_UNAVAILABLE)?;
    let old_executable = executable.with_file_name("my-knowledge");
    let old_executable = old_executable.to_str().ok_or(STARTUP_UNAVAILABLE)?;
    // auto-launch 0.6.0's LaunchAgent template, as used by autostart 2.7.0 with
    // no arguments, associated bundle identifiers or extra configuration. Broader
    // plist parsing would risk claiming another registration; preserve it instead.
    let expected = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
        <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
        <plist version=\"1.0\">\n  \
        <dict>\n  \
        <key>Label</key>\n  \
        <string>My Knowledge</string>\n  \
        <key>AssociatedBundleIdentifiers</key>\n  \
        <array></array>\n  \
        <key>ProgramArguments</key>\n  \
        <array><string>{old_executable}</string></array>\n  \
        <key>RunAtLoad</key>\n  \
        <true/>\n  \
        </dict>\n\
        </plist>"
    );
    if bytes.as_slice() == expected.as_bytes() {
        Err(LEGACY_REGISTRATION)
    } else {
        Err(STARTUP_UNAVAILABLE)
    }
}

pub enum Failure<E> {
    Read(E),
    Write(E),
    Save {
        error: E,
        rollback: Option<E>,
        actual: Option<bool>,
    },
}
pub fn update<E>(
    desired: bool,
    read: impl FnOnce() -> Result<bool, E>,
    mut write: impl FnMut(bool) -> Result<(), E>,
    save: impl FnOnce() -> Result<(), E>,
) -> Result<bool, Failure<E>> {
    let actual = read().map_err(Failure::Read)?;
    let changed = desired != actual;
    if changed {
        write(desired).map_err(Failure::Write)?;
    }
    if let Err(error) = save() {
        let rollback = if changed { write(actual).err() } else { None };
        let known = rollback.is_none().then_some(actual);
        return Err(Failure::Save {
            error,
            rollback,
            actual: known,
        });
    }
    Ok(desired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn legacy_fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        String,
    ) {
        let temporary = tempfile::tempdir().unwrap();
        // macOS temp roots can contain /var -> /private/var; the production
        // nofollow directory guard deliberately requires the canonical path.
        let root = temporary.path().canonicalize().unwrap();
        let agents = root.join("LaunchAgents");
        std::fs::create_dir(&agents).unwrap();
        let executable = root.join("Mogledge.app/Contents/MacOS/mogledge");
        let old = executable.with_file_name("my-knowledge");
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>My Knowledge</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>ProgramArguments</key>\n  <array><string>{}</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>",
            old.display()
        );
        (temporary, agents, executable, plist)
    }

    #[test]
    fn legacy_launch_agent_blocks_changes_and_preserves_both_registrations() {
        let (_temporary, agents, executable, plist) = legacy_fixture();
        let old = agents.join(LEGACY_AGENT);
        let current = agents.join("Mogledge.plist");
        std::fs::write(&old, &plist).unwrap();
        std::fs::write(&current, b"current registration sentinel").unwrap();
        for desired in [true, false] {
            let result = update(
                desired,
                || check_legacy_launch_agent(&agents, &executable).map(|()| false),
                |_| panic!("legacy registration must prevent OS writes"),
                || panic!("legacy registration must prevent preference writes"),
            );
            assert!(matches!(result, Err(Failure::Read(LEGACY_REGISTRATION))));
            assert_eq!(std::fs::read(&old).unwrap(), plist.as_bytes());
            assert_eq!(
                std::fs::read(&current).unwrap(),
                b"current registration sentinel"
            );
        }
    }

    #[test]
    fn absent_legacy_agent_allows_current_registration_without_creating_old_locations() {
        let (_temporary, agents, executable, _plist) = legacy_fixture();
        std::fs::write(agents.join("Mogledge.plist"), b"untouched").unwrap();
        assert_eq!(check_legacy_launch_agent(&agents, &executable), Ok(()));
        let missing = agents.join("missing");
        assert_eq!(check_legacy_launch_agent(&missing, &executable), Ok(()));
        assert!(!missing.exists());
        assert_eq!(std::fs::read_dir(&agents).unwrap().count(), 1);
    }

    #[test]
    fn foreign_corrupt_or_oversized_agents_are_preserved_without_claiming_ownership() {
        let (_temporary, agents, executable, plist) = legacy_fixture();
        let old = agents.join(LEGACY_AGENT);
        for bytes in [
            b"bplist00".to_vec(),
            plist
                .replace(
                    "<string>My Knowledge</string>",
                    "<string>Other App</string>",
                )
                .into_bytes(),
            plist
                .replace("my-knowledge</string>", "another-app</string>")
                .into_bytes(),
            plist
                .replace(
                    "</string></array>",
                    "</string><string>--flag</string></array>",
                )
                .into_bytes(),
            plist.replace("<true/>", "<false/>").into_bytes(),
            vec![b'x'; 16 * 1024 + 1],
        ] {
            std::fs::write(&old, &bytes).unwrap();
            assert_eq!(
                check_legacy_launch_agent(&agents, &executable),
                Err(STARTUP_UNAVAILABLE)
            );
            assert_eq!(std::fs::read(&old).unwrap(), bytes);
        }
        std::fs::remove_file(&old).unwrap();
        std::fs::create_dir(&old).unwrap();
        assert_eq!(
            check_legacy_launch_agent(&agents, &executable),
            Err(STARTUP_UNAVAILABLE)
        );
        assert!(old.is_dir());
    }

    #[test]
    fn legacy_agent_for_another_bundle_is_not_claimed() {
        let (_temporary, agents, executable, plist) = legacy_fixture();
        std::fs::write(agents.join(LEGACY_AGENT), &plist).unwrap();
        let another = executable
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .with_file_name("Another.app")
            .join("Contents/MacOS/mogledge");
        assert_eq!(
            check_legacy_launch_agent(&agents, &another),
            Err(STARTUP_UNAVAILABLE)
        );
    }

    #[cfg(unix)]
    #[test]
    fn linked_legacy_agent_or_parent_is_never_followed() {
        use std::os::unix::fs::symlink;
        let (temporary, agents, executable, plist) = legacy_fixture();
        let outside = temporary.path().join("outside.plist");
        std::fs::write(&outside, &plist).unwrap();
        let old = agents.join(LEGACY_AGENT);
        symlink(&outside, &old).unwrap();
        assert_eq!(
            check_legacy_launch_agent(&agents, &executable),
            Err(STARTUP_UNAVAILABLE)
        );
        std::fs::remove_file(&old).unwrap();
        std::fs::hard_link(&outside, &old).unwrap();
        assert_eq!(
            check_legacy_launch_agent(&agents, &executable),
            Err(STARTUP_UNAVAILABLE)
        );
        let linked_parent = temporary.path().join("linked-agents");
        symlink(&agents, &linked_parent).unwrap();
        assert_eq!(
            check_legacy_launch_agent(&linked_parent, &executable),
            Err(STARTUP_UNAVAILABLE)
        );
        assert_eq!(std::fs::read(outside).unwrap(), plist.as_bytes());
    }

    #[test]
    fn failed_save_restores_actual_os_state_independent_of_stored_preference() {
        for actual in [true, false] {
            let calls = RefCell::new(Vec::new());
            let result = update(
                !actual,
                || Ok(actual),
                |value| {
                    calls.borrow_mut().push(value);
                    Ok(())
                },
                || Err("save"),
            );
            assert!(
                matches!(result, Err(Failure::Save { actual: Some(value), rollback: None, .. }) if value == actual)
            );
            assert_eq!(*calls.borrow(), [!actual, actual]);
        }
    }
    #[test]
    fn matching_os_state_is_not_changed_even_when_save_fails() {
        let result = update(true, || Ok(true), |_| panic!("no OS write"), || Err("save"));
        assert!(matches!(
            result,
            Err(Failure::Save {
                actual: Some(true),
                rollback: None,
                ..
            })
        ));
    }
    #[test]
    fn failed_rollback_is_unknown_and_read_failure_never_writes_or_saves() {
        let mut writes = 0;
        let result = update(
            true,
            || Ok(false),
            |_| {
                writes += 1;
                if writes == 2 {
                    Err("rollback")
                } else {
                    Ok(())
                }
            },
            || Err("save"),
        );
        assert!(matches!(
            result,
            Err(Failure::Save {
                actual: None,
                rollback: Some("rollback"),
                ..
            })
        ));
        let result = update(
            true,
            || Err("read"),
            |_| panic!("no OS write"),
            || panic!("no save"),
        );
        assert!(matches!(result, Err(Failure::Read("read"))));
    }
}
