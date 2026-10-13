//! Keep the old registration until publication; release failures restore the file.
#[cfg(any(test, target_os = "macos"))]
pub fn press_edge(pressed: &std::sync::atomic::AtomicBool, down: bool) -> bool {
    pressed.swap(down, std::sync::atomic::Ordering::AcqRel) != down && down
}
pub struct Failure<T, E> {
    pub error: E,
    pub rollback: Option<E>,
    pub cleanup: Option<E>,
    pub pending: Option<T>,
}
pub fn replace<T, E>(
    active: &mut Option<T>,
    mut candidate: Option<T>,
    mut release: impl FnMut(&mut T) -> Result<(), E>,
    mut save: impl FnMut(bool) -> Result<(), E>,
) -> Result<(), Failure<T, E>> {
    let failure = match save(true) {
        Err(error) => Some((error, None)),
        Ok(()) => match active.as_mut().map(&mut release).transpose() {
            Err(error) => Some((error, save(false).err())),
            Ok(_) => None,
        },
    };
    if let Some((error, rollback)) = failure {
        let cleanup = candidate.as_mut().map(release).transpose().err();
        return Err(Failure {
            error,
            rollback,
            pending: cleanup.is_some().then_some(candidate).flatten(),
            cleanup,
        });
    }
    *active = candidate;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn mac_press_release_cycle_ignores_repeats_and_allows_next_press() {
        let pressed = std::sync::atomic::AtomicBool::new(false);
        let recalls =
            [true, true, true, false, false, true, false].map(|down| press_edge(&pressed, down));
        assert_eq!(recalls, [true, false, false, false, false, true, false]);
    }
    #[test]
    fn save_failure_keeps_old_registration_and_releases_only_candidate() {
        let mut active = Some("old");
        let released = RefCell::new(Vec::new());
        let result = replace(
            &mut active,
            Some("new"),
            |value| {
                released.borrow_mut().push(*value);
                Ok(())
            },
            |_| Err("save"),
        );
        assert!(matches!(
            result,
            Err(Failure {
                error: "save",
                rollback: None,
                cleanup: None,
                ..
            })
        ));
        assert_eq!(active, Some("old"));
        assert_eq!(*released.borrow(), ["new"]);
    }
    #[test]
    fn release_failure_restores_persisted_setting_and_keeps_active_registration() {
        for candidate in [Some("new"), None] {
            let mut active = Some("old");
            let saves = RefCell::new(Vec::new());
            let result = replace(
                &mut active,
                candidate,
                |value| {
                    if *value == "old" {
                        Err("release")
                    } else {
                        Ok(())
                    }
                },
                |desired| {
                    saves.borrow_mut().push(desired);
                    Ok(())
                },
            );
            assert!(matches!(
                result,
                Err(Failure {
                    rollback: None,
                    cleanup: None,
                    ..
                })
            ));
            assert_eq!(active, Some("old"));
            assert_eq!(*saves.borrow(), [true, false]);
        }
    }
    #[test]
    fn failed_rollback_and_cleanup_are_exposed_without_losing_handles() {
        let mut active = Some("old");
        let result = replace(
            &mut active,
            Some("new"),
            |_| Err("release"),
            |desired| if desired { Ok(()) } else { Err("rollback") },
        );
        assert!(matches!(
            result,
            Err(Failure {
                rollback: Some("rollback"),
                cleanup: Some("release"),
                pending: Some("new"),
                ..
            })
        ));
        assert_eq!(active, Some("old"));
    }
    #[test]
    fn success_publishes_before_retiring_and_off_removes_registration() {
        for candidate in [Some("new"), None] {
            let mut active = Some("old");
            let operations = RefCell::new(Vec::new());
            let result = replace(
                &mut active,
                candidate,
                |_| {
                    operations.borrow_mut().push("release");
                    Ok::<(), &'static str>(())
                },
                |desired| {
                    assert!(desired);
                    operations.borrow_mut().push("save");
                    Ok(())
                },
            );
            assert!(result.is_ok());
            assert_eq!(active, candidate);
            assert_eq!(*operations.borrow(), ["save", "release"]);
        }
    }
}
