//! Finite, process-local update state. No timers, settings writes or install paths.
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Disabled,
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    UpToDate,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub phase: Phase,
    pub current_version: String,
    pub disabled_reason: Option<&'static str>,
    pub release: Option<Release>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<&'static str>,
}

pub struct Session {
    pub snapshot: Snapshot,
    operation: u64,
}

impl Session {
    pub fn new(version: String, disabled_reason: Option<&'static str>) -> Self {
        Self {
            snapshot: Snapshot {
                revision: 0,
                phase: if disabled_reason.is_some() {
                    Phase::Disabled
                } else {
                    Phase::Idle
                },
                current_version: version,
                disabled_reason,
                release: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
            },
            operation: 0,
        }
    }

    pub fn check(&mut self) -> Result<u64, &'static str> {
        if matches!(self.snapshot.phase, Phase::Disabled) {
            return Err("UpdateDisabled");
        }
        if matches!(
            self.snapshot.phase,
            Phase::Checking | Phase::Downloading | Phase::Installing | Phase::Ready
        ) {
            return Err("UpdateBusy");
        }
        self.snapshot.release = None;
        self.snapshot.downloaded_bytes = 0;
        self.snapshot.total_bytes = None;
        Ok(self.begin(Phase::Checking))
    }

    pub fn download(&mut self) -> Result<u64, &'static str> {
        if self.snapshot.phase != Phase::Available {
            return Err("UpdateNotAvailable");
        }
        Ok(self.begin(Phase::Downloading))
    }

    fn begin(&mut self, phase: Phase) -> u64 {
        self.operation += 1;
        self.snapshot.error = None;
        self.change(phase);
        self.operation
    }

    pub fn is_active(&self, operation: u64, phase: Phase) -> bool {
        self.operation == operation && self.snapshot.phase == phase
    }

    pub fn checked(&mut self, operation: u64, release: Option<Release>) -> bool {
        if !self.is_active(operation, Phase::Checking) {
            return false;
        }
        let phase = if release.is_some() {
            Phase::Available
        } else {
            Phase::UpToDate
        };
        self.snapshot.release = release;
        self.change(phase);
        true
    }

    pub fn progress(&mut self, operation: u64, chunk: u64, total: Option<u64>) -> bool {
        if !self.is_active(operation, Phase::Downloading) {
            return false;
        }
        self.snapshot.downloaded_bytes = self.snapshot.downloaded_bytes.saturating_add(chunk);
        self.snapshot.total_bytes = total.filter(|value| *value > 0);
        self.snapshot.revision += 1;
        true
    }

    pub fn downloaded(&mut self, operation: u64) -> bool {
        if !self.is_active(operation, Phase::Downloading) {
            return false;
        }
        self.change(Phase::Ready);
        true
    }

    pub fn failed(&mut self, operation: u64, error: &'static str) -> bool {
        if self.operation != operation
            || !matches!(
                self.snapshot.phase,
                Phase::Checking | Phase::Downloading | Phase::Installing
            )
        {
            return false;
        }
        self.snapshot.error = Some(error);
        self.change(Phase::Error);
        true
    }

    pub fn cancel(&mut self) -> Result<(), &'static str> {
        if matches!(self.snapshot.phase, Phase::Disabled | Phase::Installing) {
            return Err("UpdateCannotCancel");
        }
        self.operation += 1; // Invalidate late network completion and progress callbacks.
        self.snapshot.release = None;
        self.snapshot.downloaded_bytes = 0;
        self.snapshot.total_bytes = None;
        self.snapshot.error = None;
        self.change(Phase::Cancelled);
        Ok(())
    }

    pub fn install(&mut self, saved_confirmed: bool) -> Result<u64, &'static str> {
        if !saved_confirmed {
            return Err("UpdateSaveConfirmationRequired");
        }
        if self.snapshot.phase != Phase::Ready {
            return Err("UpdateNotReady");
        }
        Ok(self.begin(Phase::Installing))
    }

    fn change(&mut self, phase: Phase) {
        self.snapshot.phase = phase;
        self.snapshot.revision += 1;
    }
}

pub fn main_host(label: &str) -> Result<(), &'static str> {
    if label == "main" {
        Ok(())
    } else {
        Err("UpdateMainRequired")
    }
}

/// Reject bypass settings even if introduced through a configuration overlay.
pub fn secure_config(value: &serde_json::Value) -> bool {
    let unsafe_options = [
        "dangerousInsecureTransportProtocol",
        "dangerous-insecure-transport-protocol",
        "dangerousAcceptInvalidCerts",
        "dangerous-accept-invalid-certs",
        "dangerousAcceptInvalidHostnames",
        "dangerous-accept-invalid-hostnames",
        "allowDowngrades",
        "allow-downgrades",
    ];
    unsafe_options
        .iter()
        .all(|name| value.get(name).is_none_or(|v| v == false))
        && value
            .get("pubkey")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.trim().is_empty())
        && value.get("requireSignedVersion").is_some_and(|v| v == true)
        && value
            .get("endpoints")
            .and_then(|v| v.as_array())
            .is_some_and(|urls| {
                !urls.is_empty()
                    && urls
                        .iter()
                        .all(|v| v.as_str().is_some_and(|url| url.starts_with("https://")))
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn enabled() -> Session {
        Session::new("0.7.5".into(), None)
    }
    fn available() -> Session {
        let mut session = enabled();
        let id = session.check().unwrap();
        session.checked(
            id,
            Some(Release {
                version: "0.8.0".into(),
                notes: "Test".into(),
            }),
        );
        session
    }
    #[test]
    fn disabled_and_foreign_hosts_cannot_update() {
        assert!(Session::new("0.7.5".into(), Some("selfBuild"))
            .check()
            .is_err());
        for host in ["document", "storage-transition", "", "main-child"] {
            assert!(main_host(host).is_err());
        }
        assert!(main_host("main").is_ok());
    }
    #[test]
    fn no_update_and_failure_are_distinct_and_retryable() {
        let mut s = enabled();
        let id = s.check().unwrap();
        assert!(s.check().is_err());
        s.checked(id, None);
        assert_eq!(s.snapshot.phase, Phase::UpToDate);
        let id = s.check().unwrap();
        s.failed(id, "UpdateCheckFailed");
        assert_eq!(s.snapshot.phase, Phase::Error);
        assert!(s.check().is_ok());
    }
    #[test]
    fn cancellation_invalidates_old_results_during_a_new_check() {
        let mut s = enabled();
        let old = s.check().unwrap();
        s.cancel().unwrap();
        let new = s.check().unwrap();
        assert!(!s.checked(old, None));
        assert!(!s.failed(old, "late"));
        assert!(s.checked(new, None));
    }
    #[test]
    fn cancelled_download_cannot_become_ready() {
        let mut s = available();
        let id = s.download().unwrap();
        s.progress(id, 128, None);
        assert_eq!(s.snapshot.total_bytes, None);
        assert!(s.download().is_err());
        s.cancel().unwrap();
        assert!(!s.progress(id, 256, Some(384)));
        assert!(!s.downloaded(id));
        assert!(s.install(true).is_err());
    }
    #[test]
    fn signature_failure_never_allows_install() {
        let mut s = available();
        let id = s.download().unwrap();
        s.failed(id, "UpdateSignatureInvalid");
        assert!(s.install(true).is_err());
        assert_eq!(s.snapshot.error, Some("UpdateSignatureInvalid"));
    }
    #[test]
    fn install_needs_ready_and_explicit_save_acknowledgement_and_cannot_run_twice() {
        let mut s = available();
        assert!(s.install(true).is_err());
        let id = s.download().unwrap();
        s.progress(id, 64, Some(128));
        s.downloaded(id);
        assert!(s.check().is_err());
        assert!(s.install(false).is_err());
        s.install(true).unwrap();
        assert!(s.install(true).is_err());
        assert!(s.cancel().is_err());
    }
    #[test]
    fn insecure_unconfigured_or_downgrade_settings_are_rejected() {
        let valid = serde_json::json!({"pubkey":"test-fixture-only", "endpoints":["https://updates.invalid/fixture"], "requireSignedVersion":true});
        assert!(secure_config(&valid));
        assert!(!secure_config(&serde_json::json!({})));
        for name in [
            "dangerousInsecureTransportProtocol",
            "dangerous-accept-invalid-certs",
            "allowDowngrades",
        ] {
            let mut v = valid.clone();
            v[name] = true.into();
            assert!(!secure_config(&v));
        }
        for url in ["http://updates.invalid", "file:///update", ""] {
            let mut v = valid.clone();
            v["endpoints"] = serde_json::json!([url]);
            assert!(!secure_config(&v));
        }
    }
}
