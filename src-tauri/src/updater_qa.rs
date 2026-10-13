//! Compile-time opt-in policy for one disposable, signed Windows update probe.
//! This module is absent from ordinary binaries; no environment toggle enrolls them.
use serde_json::Value;

pub const IDENTIFIER: &str = "com.shimilynx.mogledge.updaterqa";
pub const PRODUCT_NAME: &str = "Mogledge Updater QA";
pub const BINARY_NAME: &str = "mogledge-updater-qa";
pub const MANIFEST_URL: &str = "http://127.0.0.1:47653/latest.json";
pub const ARTIFACT_URL: &str = "http://127.0.0.1:47653/MogledgeUpdaterQA_0.8.0_x64-setup.exe";

pub fn identity(
    identifier: &str,
    product_name: Option<&str>,
    binary_name: Option<&str>,
    executable_name: Option<&str>,
    windows: bool,
    debug: bool,
    e2e: bool,
) -> bool {
    windows
        && !debug
        && !e2e
        && identifier == IDENTIFIER
        && product_name == Some(PRODUCT_NAME)
        && binary_name == Some(BINARY_NAME)
        && executable_name == Some("mogledge-updater-qa.exe")
}

pub fn config(value: &Value) -> bool {
    // The upstream HTTP switch is permitted only for this exact signed fixture.
    // TLS exceptions, downgrade acceptance and alternate spellings remain refused.
    let refused = [
        "dangerous-insecure-transport-protocol",
        "dangerousAcceptInvalidCerts",
        "dangerous-accept-invalid-certs",
        "dangerousAcceptInvalidHostnames",
        "dangerous-accept-invalid-hostnames",
        "allowDowngrades",
        "allow-downgrades",
    ];
    value
        .get("dangerousInsecureTransportProtocol")
        .is_some_and(|option| option == true)
        && refused
            .iter()
            .all(|name| value.get(name).is_none_or(|option| option == false))
        && value
            .get("pubkey")
            .and_then(Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
        && value
            .get("requireSignedVersion")
            .is_some_and(|option| option == true)
        && value.get("endpoints") == Some(&serde_json::json!([MANIFEST_URL]))
        && value.get("windows")
            == Some(&serde_json::json!({"installMode":"passive", "installerArgs":["/NS"]}))
}

pub fn artifact(url: &str) -> bool {
    url == ARTIFACT_URL
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::json!({
            "pubkey": "public-fixture-only",
            "endpoints": [MANIFEST_URL],
            "requireSignedVersion": true,
            "dangerousInsecureTransportProtocol": true,
            "windows": {"installMode":"passive", "installerArgs":["/NS"]}
        })
    }

    #[test]
    fn formal_alias_debug_and_e2e_identities_are_rejected() {
        let valid = |id, debug, e2e, windows| {
            identity(
                id,
                Some(PRODUCT_NAME),
                Some(BINARY_NAME),
                Some("mogledge-updater-qa.exe"),
                windows,
                debug,
                e2e,
            )
        };
        assert!(valid(IDENTIFIER, false, false, true));
        for id in [
            "com.shimilynx.myknowledge",
            "com.shimilynx.aiwiki",
            "COM.SHIMILYNX.MOGLEDGE.UPDATERQA",
            "",
        ] {
            assert!(!valid(id, false, false, true));
        }
        assert!(!valid(IDENTIFIER, true, false, true));
        assert!(!valid(IDENTIFIER, false, true, true));
        assert!(!valid(IDENTIFIER, false, false, false));
        assert!(!identity(
            IDENTIFIER,
            Some("Mogledge"),
            Some(BINARY_NAME),
            Some("my-knowledge.exe"),
            true,
            false,
            false
        ));
    }

    #[test]
    fn only_the_exact_loopback_endpoint_is_accepted() {
        assert!(config(&fixture()));
        for url in [
            "http://localhost:47653/latest.json",
            "http://127.0.0.2:47653/latest.json",
            "http://127.1:47653/latest.json",
            "http://[::1]:47653/latest.json",
            "http://127.0.0.1:47654/latest.json",
            "http://127.0.0.1:47653/other.json",
            "http://user:password@127.0.0.1:47653/latest.json",
            "http://192.168.0.1:47653/latest.json",
            "https://updates.invalid/latest.json",
        ] {
            let mut value = fixture();
            value["endpoints"] = serde_json::json!([url]);
            assert!(!config(&value), "{url}");
        }
        let mut value = fixture();
        value["endpoints"] = serde_json::json!([MANIFEST_URL, MANIFEST_URL]);
        assert!(!config(&value));
    }

    #[test]
    fn signature_tls_and_downgrade_guards_remain_required() {
        for name in ["requireSignedVersion", "dangerousInsecureTransportProtocol"] {
            let mut value = fixture();
            value[name] = false.into();
            assert!(!config(&value));
        }
        for name in [
            "dangerousAcceptInvalidCerts",
            "dangerous-accept-invalid-hostnames",
            "allowDowngrades",
            "dangerous-insecure-transport-protocol",
        ] {
            let mut value = fixture();
            value[name] = true.into();
            assert!(!config(&value));
        }
        let mut value = fixture();
        value["pubkey"] = " ".into();
        assert!(!config(&value));
        let mut value = fixture();
        value["windows"]["installerArgs"] = serde_json::json!(["/D=foreign-install"]);
        assert!(!config(&value));
    }

    #[test]
    fn external_query_and_alternate_artifact_paths_are_rejected() {
        assert!(artifact(ARTIFACT_URL));
        for url in [
            "https://updates.invalid/setup.exe",
            MANIFEST_URL,
            "http://127.0.0.1:47653/MogledgeUpdaterQA_0.8.0_x64-setup.exe?download=1",
            "http://user@127.0.0.1:47653/MogledgeUpdaterQA_0.8.0_x64-setup.exe",
        ] {
            assert!(!artifact(url));
        }
    }
}
