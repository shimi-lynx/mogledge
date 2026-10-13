use super::*;
use serde_json::{json, Value};

fn source() -> Source {
    Source {
        root_identity: "a".repeat(64),
        document_identity: "b".repeat(64),
        relative_path: "保存/日本語.html".to_owned(),
        revision: 4,
        generation: 7,
    }
}
fn envelope() -> Value {
    json!({"format":FORMAT,"formatVersion":1,"appVersion":"0.5.0-beta.1+fixture","source":source(),"apps":{"fixture":{"schemaVersion":1,"data":{"秘密":"SYNTHETIC_PRIVATE_VALUE","values":[null,true,1,-2,1.5]}}}})
}
fn parse_value(value: &Value) -> Result<ValidatedTransfer, FormatError> {
    parse(&serde_json::to_vec(value).unwrap())
}
fn error(value: &Value) -> FormatError {
    parse_value(value).err().unwrap()
}

#[test]
fn versioned_roundtrip_preserves_values_app_schema_and_provenance() {
    let value = envelope();
    let parsed = parse_value(&value).unwrap();
    assert_eq!(parsed.app_count, 1);
    assert_eq!(parsed.bytes, parsed.canonical_state.len() as i64);
    // Native stores a map of JSON values, whose object keys are canonicalized.
    assert_eq!(parsed.canonical_state, value["apps"].to_string());
    assert_eq!(
        serde_json::from_str::<Value>(&parsed.canonical_state).unwrap(),
        value["apps"]
    );
    let from = from_state("0.5.0", source(), &parsed.canonical_state).unwrap();
    let encoded = encode(&from.file).unwrap();
    let roundtrip = parse(&encoded).unwrap();
    assert_eq!(roundtrip.file.source.root_identity, "a".repeat(64));
    assert_eq!(roundtrip.file.source.document_identity, "b".repeat(64));
    assert_eq!(roundtrip.file.source.relative_path, "保存/日本語.html");
    assert_eq!(roundtrip.file.source.revision, 4);
    assert_eq!(roundtrip.file.source.generation, 7);
    assert_eq!(roundtrip.canonical_state, parsed.canonical_state);
}

#[test]
fn strict_envelope_and_unknown_fields_fail_without_echoing_payloads() {
    for field in ["unknown", "token", "absolutePath"] {
        let mut value = envelope();
        value[field] = json!("SYNTHETIC_PRIVATE_VALUE");
        let failure = error(&value);
        assert_eq!(failure, FormatError::InvalidFormat);
        assert_eq!(failure.to_string(), "invalid_format");
        assert!(!format!("{failure:?}").contains("SYNTHETIC_PRIVATE_VALUE"));
    }
    let mut value = envelope();
    value["source"]["unknown"] = json!(true);
    assert_eq!(error(&value), FormatError::InvalidFormat);
    let mut value = envelope();
    value["apps"]["fixture"]["unknown"] = json!(true);
    assert_eq!(error(&value), FormatError::InvalidFormat);
    let mut value = envelope();
    value.as_object_mut().unwrap().remove("apps");
    assert_eq!(error(&value), FormatError::InvalidFormat);
    for value in [Value::Null, json!([]), json!({"apps":{}})] {
        assert_eq!(error(&value), FormatError::InvalidFormat);
    }
}

#[test]
fn malformed_utf8_json_nonfinite_numbers_trailing_values_and_depth_are_rejected() {
    for input in [
        b"".as_slice(),
        b"{",
        b"[] garbage",
        b"{} {}",
        b"{\"x\":NaN}",
        b"{\"x\":1e400}",
        b"\xff",
    ] {
        assert_eq!(parse(input).err(), Some(FormatError::InvalidFormat));
    }
    let mut value = envelope();
    let data = format!("{}null{}", "[".repeat(150), "]".repeat(150));
    let input = serde_json::to_string(&value)
        .unwrap()
        .replace("\"SYNTHETIC_PRIVATE_VALUE\"", &data);
    assert_eq!(
        parse(input.as_bytes()).err(),
        Some(FormatError::InvalidFormat)
    );
    value["apps"]["fixture"]["data"] = json!(null);
    assert!(parse_value(&value).is_ok());
}

#[test]
fn duplicate_keys_are_rejected_at_every_depth_including_escaped_aliases() {
    let plain = serde_json::to_string(&envelope()).unwrap();
    for input in [
        plain.replacen(
            "\"formatVersion\":1",
            "\"formatVersion\":1,\"formatVersion\":1",
            1,
        ),
        plain.replacen("\"revision\":4", "\"revision\":4,\"revision\":4", 1),
        plain.replacen(
            "\"schemaVersion\":1",
            "\"schemaVersion\":1,\"schemaVersion\":2",
            1,
        ),
        plain.replacen("\"SYNTHETIC_PRIVATE_VALUE\"", "{\"x\":1,\"x\":2}", 1),
        plain.replacen(
            "\"SYNTHETIC_PRIVATE_VALUE\"",
            "[{\"x\":1,\"\\u0078\":1}]",
            1,
        ),
    ] {
        assert_eq!(
            parse(input.as_bytes()).err(),
            Some(FormatError::InvalidFormat)
        );
    }
    assert_eq!(
        from_state(
            "0.5.0",
            source(),
            r#"{"app":{"schemaVersion":1,"data":null},"app":{"schemaVersion":1,"data":null}}"#
        )
        .err(),
        Some(FormatError::InvalidFormat)
    );
    assert_eq!(
        from_state(
            "0.5.0",
            source(),
            r#"{"app":{"schemaVersion":1,"data":{"x":1,"x":1}}}"#
        )
        .err(),
        Some(FormatError::InvalidFormat)
    );
}

#[test]
fn unsupported_format_versions_and_invalid_app_versions_stop() {
    for version in [0, 2, 999] {
        let mut value = envelope();
        value["formatVersion"] = json!(version);
        assert_eq!(error(&value), FormatError::UnsupportedFormat);
    }
    let mut value = envelope();
    value["format"] = json!("other-format");
    assert_eq!(error(&value), FormatError::UnsupportedFormat);
    for version in [
        "",
        "0.5",
        "0.5.x",
        "../../private",
        "0.5.0\nprivate",
        "秘密",
        &"1".repeat(65),
    ] {
        let mut value = envelope();
        value["appVersion"] = json!(version);
        assert_eq!(error(&value), FormatError::InvalidFormat);
    }
}

#[test]
fn invalid_source_identities_paths_revisions_and_generation_stop() {
    for field in ["rootIdentity", "documentIdentity"] {
        for identity in [
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
        ] {
            let mut value = envelope();
            value["source"][field] = json!(identity);
            assert_eq!(error(&value), FormatError::InvalidSource);
        }
    }
    for path in [
        "",
        "/absolute.html",
        "../private.html",
        "folder/../page.html",
        ".hidden/page.html",
        "a//b.html",
        "a\\b.html",
        "C:/private.html",
        "a\0b.html",
    ] {
        let mut value = envelope();
        value["source"]["relativePath"] = json!(path);
        assert_eq!(error(&value), FormatError::InvalidSource);
    }
    let mut value = envelope();
    value["source"]["relativePath"] = json!("a".repeat(4096));
    assert!(parse_value(&value).is_ok());
    value["source"]["relativePath"] = json!("a".repeat(4097));
    assert_eq!(error(&value), FormatError::InvalidSource);
    for revision in [0, -1] {
        let mut value = envelope();
        value["source"]["revision"] = json!(revision);
        assert_eq!(error(&value), FormatError::InvalidSource);
    }
    let mut value = envelope();
    value["source"]["generation"] = json!(-1);
    assert_eq!(error(&value), FormatError::InvalidSource);
    value["source"]["generation"] = json!(0);
    assert!(parse_value(&value).is_ok());
    value["source"]
        .as_object_mut()
        .unwrap()
        .remove("generation");
    assert_eq!(error(&value), FormatError::InvalidFormat);
}

#[test]
fn app_id_count_and_javascript_safe_schema_boundaries_are_enforced() {
    for key in ["", "a/b", "日本語", "has space", &"a".repeat(81)] {
        let mut value = envelope();
        value["apps"] = json!({key:{"schemaVersion":1,"data":null}});
        assert_eq!(error(&value), FormatError::InvalidApp);
    }
    let mut value = envelope();
    value["apps"] = json!({"a".repeat(80):{"schemaVersion":MAX_SAFE_SCHEMA,"data":null}});
    assert!(parse_value(&value).is_ok());
    for schema in [json!(0), json!(MAX_SAFE_SCHEMA + 1)] {
        let mut value = envelope();
        value["apps"]["fixture"]["schemaVersion"] = schema;
        assert_eq!(error(&value), FormatError::InvalidSchema);
    }
    for schema in [json!(-1), json!(1.0), json!(1.5), json!("1"), Value::Null] {
        let mut value = envelope();
        value["apps"]["fixture"]["schemaVersion"] = schema;
        assert_eq!(error(&value), FormatError::InvalidFormat);
    }
    let apps: serde_json::Map<String, Value> = (0..128)
        .map(|index| {
            (
                format!("app-{index}"),
                json!({"schemaVersion":1,"data":null}),
            )
        })
        .collect();
    let mut value = envelope();
    value["apps"] = Value::Object(apps);
    assert_eq!(parse_value(&value).unwrap().app_count, 128);
    value["apps"]["app-128"] = json!({"schemaVersion":1,"data":null});
    assert_eq!(error(&value), FormatError::TransferLimit);
    value["apps"] = json!({});
    assert_eq!(parse_value(&value).unwrap().canonical_state, "{}");
}

#[test]
fn canonical_utf8_quota_and_raw_file_budget_are_independent_and_exact() {
    let baseline = from_state(
        "0.5.0",
        source(),
        r#"{"fixture":{"schemaVersion":1,"data":""}}"#,
    )
    .unwrap();
    let room = crate::storage_limits::DEFAULT_DOCUMENT_BYTES - baseline.canonical_state.len();
    let data = json!({"fixture":{"schemaVersion":1,"data":"x".repeat(room)}}).to_string();
    let parsed = from_state("0.5.0", source(), &data).unwrap();
    assert_eq!(
        parsed.bytes,
        crate::storage_limits::DEFAULT_DOCUMENT_BYTES as i64
    );
    assert!(parse(&encode(&parsed.file).unwrap()).is_ok());
    let oversized = json!({"fixture":{"schemaVersion":1,"data":"x".repeat(room+1)}}).to_string();
    assert_eq!(
        parse_with_capacity(&serde_json::to_vec(&json!({"format":FORMAT,"formatVersion":1,"appVersion":"0.5.0","source":source(),"apps":serde_json::from_str::<Value>(&oversized).unwrap()})).unwrap(),crate::storage_limits::DEFAULT_DOCUMENT_BYTES,crate::storage_limits::DEFAULT_DOCUMENT_BYTES+16*1024).err(),
        Some(FormatError::TransferLimit)
    );
    let mut bytes = serde_json::to_vec(&envelope()).unwrap();
    bytes.resize(
        crate::storage_limits::DEFAULT_DOCUMENT_BYTES + 16 * 1024,
        b' ',
    );
    assert!(parse_with_capacity(
        &bytes,
        crate::storage_limits::DEFAULT_DOCUMENT_BYTES,
        crate::storage_limits::DEFAULT_DOCUMENT_BYTES + 16 * 1024
    )
    .is_ok());
    bytes.push(b' ');
    assert_eq!(
        parse_with_capacity(
            &bytes,
            crate::storage_limits::DEFAULT_DOCUMENT_BYTES,
            crate::storage_limits::DEFAULT_DOCUMENT_BYTES + 16 * 1024
        )
        .err(),
        Some(FormatError::TransferLimit)
    );
    let unicode = from_state(
        "0.5.0",
        source(),
        r#"{"app":{"schemaVersion":1,"data":"日本語\n\"\\"}}"#,
    )
    .unwrap();
    assert_eq!(unicode.bytes, unicode.canonical_state.len() as i64);
    assert!(unicode.bytes > unicode.canonical_state.chars().count() as i64);
}

#[test]
fn schema_conflicts_stop_even_for_null_values_and_malformed_legacy_maps() {
    let incoming = parse_value(&envelope()).unwrap();
    assert!(check_schema_compatibility(&incoming.file.apps, "{}").is_ok());
    assert!(check_schema_compatibility(
        &incoming.file.apps,
        r#"{"fixture":{"schemaVersion":1,"data":null}}"#
    )
    .is_ok());
    assert_eq!(
        check_schema_compatibility(
            &incoming.file.apps,
            r#"{"fixture":{"schemaVersion":2,"data":null}}"#
        ),
        Err(FormatError::SchemaConflict)
    );
    for invalid in [
        r#"{"fixture":{"arbitraryLegacy":true}}"#,
        r#"{"fixture":{"schemaVersion":1,"data":null},"fixture":{"schemaVersion":1,"data":null}}"#,
    ] {
        assert_eq!(
            check_schema_compatibility(&incoming.file.apps, invalid),
            Err(FormatError::InvalidFormat)
        );
    }
}

#[test]
fn encoding_manually_constructed_file_cannot_bypass_validation() {
    let mut file = parse_value(&envelope()).unwrap().file;
    file.source.revision = 0;
    assert_eq!(encode(&file).err(), Some(FormatError::InvalidSource));
    file.source.revision = 1;
    file.format_version = 2;
    assert_eq!(encode(&file).err(), Some(FormatError::UnsupportedFormat));
}
