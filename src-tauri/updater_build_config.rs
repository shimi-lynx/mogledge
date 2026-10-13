//! Retain Tauri's typed bundle decision before codegen elides bundle-only fields.
use serde_json::Value;
use tauri_utils::config::{Config, Updater};

pub fn signed_artifacts_enabled(
    mut config: Value,
    selected: Option<&str>,
) -> Result<bool, serde_json::Error> {
    // Match tauri-build's RFC 7396 merge, including explicit false/null overrides.
    if let Some(selected) = selected {
        json_patch::merge(&mut config, &serde_json::from_str(selected)?);
    }
    let config: Config = serde_json::from_value(config)?;
    Ok(config.identifier == "com.shimilynx.myknowledge"
        && config.bundle.create_updater_artifacts == Updater::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        serde_json::from_str(include_str!("tauri.conf.json")).unwrap()
    }

    #[test]
    fn ordinary_build_is_not_enrolled() {
        assert!(!signed_artifacts_enabled(base(), None).unwrap());
        assert!(!signed_artifacts_enabled(base(), Some("{}")).unwrap());
    }

    #[test]
    fn explicit_boolean_true_is_retained() {
        assert!(signed_artifacts_enabled(
            base(),
            Some(r#"{"bundle":{"createUpdaterArtifacts":true}}"#),
        )
        .unwrap());
    }

    #[test]
    fn foreign_identifiers_cannot_enroll() {
        for identifier in [
            "com.shimilynx.mogledge.updaterqa",
            "com.shimilynx.aiwiki",
            "com.shimilynx.myknowledge.custom",
        ] {
            let selected = serde_json::json!({
                "identifier": identifier,
                "bundle": { "createUpdaterArtifacts": true },
            });
            assert!(!signed_artifacts_enabled(base(), Some(&selected.to_string())).unwrap());
        }
    }

    #[test]
    fn selected_false_and_null_disable_inherited_enrollment() {
        let mut enabled = base();
        enabled["bundle"]["createUpdaterArtifacts"] = Value::Bool(true);
        for selected in [
            r#"{"bundle":{"createUpdaterArtifacts":false}}"#,
            r#"{"bundle":{"createUpdaterArtifacts":null}}"#,
        ] {
            assert!(!signed_artifacts_enabled(enabled.clone(), Some(selected)).unwrap());
        }
    }

    #[test]
    fn malformed_or_untyped_selection_fails_closed() {
        for selected in [
            "{",
            r#"{"bundle":{"createUpdaterArtifacts":"true"}}"#,
            r#"{"bundle":{"createUpdaterArtifacts":1}}"#,
            r#"{"bundle":{"unknownUpdaterSetting":true}}"#,
        ] {
            assert!(signed_artifacts_enabled(base(), Some(selected)).is_err());
        }
    }

    #[test]
    fn legacy_artifact_format_does_not_enroll() {
        assert!(!signed_artifacts_enabled(
            base(),
            Some(r#"{"bundle":{"createUpdaterArtifacts":"v1Compatible"}}"#),
        )
        .unwrap());
    }
}
