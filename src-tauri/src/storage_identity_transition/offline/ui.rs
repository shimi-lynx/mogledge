//! The standalone bundled UI holds one stopped-profile session. Cancellation
//! never waits for its mutex, so hashing/copying/SQLite validation can stop.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

pub struct Service {
    profile: PathBuf,
    config: PathBuf,
    session: Mutex<Option<Session>>,
    cancel: Arc<AtomicBool>,
}
impl Service {
    pub fn new(profile: PathBuf, config: PathBuf) -> Self {
        Self {
            profile,
            config,
            session: Mutex::new(None),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn request(&self, request: Value) -> Result<Value, String> {
        if !super::super::enabled() && !cfg!(test) {
            return Ok(
                json!({"error":"native_identity_disabled","existingDataRetained":true,"retryRequiresNewPreview":true}),
            );
        }
        let command =
            serde_json::from_value::<Request>(request).map_err(|_| "invalid_command".to_owned())?;
        if matches!(command, Request::Cancel) {
            self.cancel.store(true, Ordering::Release);
            if let Ok(mut session) = self.session.try_lock() {
                if let Some(session) = session.as_mut() {
                    session.plan = None;
                }
            }
            return Ok(json!({"status":"cancel_requested","existingDataRetained":true}));
        }
        let mut slot = self
            .session
            .try_lock()
            .map_err(|_| "state_busy".to_owned())?;
        self.cancel.store(false, Ordering::Release);
        super::super::budget::with_cancellation(self.cancel.clone(), || {
            let result = (|| {
                if let Request::OpenSession {
                    root_path,
                    backup_parent,
                } = command
                {
                    // Reopening releases only this tool's previous lease.
                    slot.take();
                    let mut config = self.config.clone();
                    let store = identifier_migration::open_management_profile(&self.profile)?;
                    if store.uses_identifier_bundle() {
                        config = self.profile.join("identifier-migration-v1/config");
                    }
                    drop(store);
                    let session = Session::open(
                        &self.profile,
                        &config,
                        Path::new(&root_path),
                        Path::new(&backup_parent),
                    )?;
                    let result = session.inspect()?;
                    *slot = Some(session);
                    return Ok(result);
                }
                if matches!(command, Request::Quit) {
                    slot.take();
                    return Ok(json!({"status":"closed"}));
                }
                let session = slot.as_mut().ok_or(MigrationError::Unavailable)?;
                match command {
                    Request::Inspect => session.inspect(),
                    Request::PrepareRoot => session.prepare(None, None),
                    Request::PrepareDocument {
                        relative_path,
                        source_identity,
                    } => session.prepare(Some(&relative_path), source_identity.as_deref()),
                    Request::Confirm {
                        plan_id,
                        confirmation,
                    } => session.confirm(&plan_id, &confirmation),
                    Request::OperationStatus { operation_id } => {
                        session.operation_status(&operation_id)
                    }
                    Request::PreparePreferences {
                        source_root_identity,
                    } => session.prepare_preferences(&source_root_identity),
                    Request::PrepareRollback { backup_directory } => {
                        session.prepare_rollback(&backup_directory)
                    }
                    _ => Err(MigrationError::Unavailable),
                }
            })();
            // Native command rejection has a fixed code; no settings/payloads
            // or ambiguous success envelope are exposed on a known failure.
            Ok(match result {
                Ok(value) => value,
                Err(error) => {
                    json!({"error":state_inspection::backend_error(error).code,"existingDataRetained":true,"retryRequiresNewPreview":true})
                }
            })
        })
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    #[serde(rename_all = "camelCase")]
    OpenSession {
        root_path: String,
        backup_parent: String,
    },
    Inspect,
    PrepareRoot,
    PrepareDocument {
        relative_path: String,
        source_identity: Option<String>,
    },
    Confirm {
        plan_id: String,
        confirmation: String,
    },
    OperationStatus {
        operation_id: String,
    },
    PreparePreferences {
        source_root_identity: String,
    },
    PrepareRollback {
        backup_directory: String,
    },
    Cancel,
    Quit,
}
