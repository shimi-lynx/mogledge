//! Transactional explicit registration; a saved preference is not OS truth.
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
