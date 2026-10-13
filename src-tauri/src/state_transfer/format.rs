//! One-document portable values. Source metadata records provenance, never authority.
use crate::{document_state::raw_json, knowledge};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};

pub(crate) fn maximum_transfer_bytes() -> usize {
    crate::storage_limits::maximum_document_bytes().saturating_add(16 * 1024)
}
const FORMAT: &str = "my-knowledge-saved-state";
const MAX_SAFE_SCHEMA: u64 = 9_007_199_254_740_991;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Source {
    pub root_identity: String,
    pub document_identity: String,
    pub relative_path: String,
    pub revision: i64,
    pub generation: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppState {
    pub data: Box<serde_json::value::RawValue>,
    pub schema_version: u64,
}

// Payload types deliberately lack Debug: diagnostics must not expose saved values.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferFile {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub source: Source,
    pub apps: BTreeMap<String, AppState>,
}

pub(crate) struct ValidatedTransfer {
    pub file: TransferFile,
    pub canonical_state: String,
    pub app_count: usize,
    pub bytes: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FormatError {
    InvalidFormat,
    UnsupportedFormat,
    InvalidSource,
    InvalidApp,
    InvalidSchema,
    SchemaConflict,
    TransferLimit,
    ResourceUnavailable,
}

impl FormatError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidFormat => "invalid_format",
            Self::UnsupportedFormat => "unsupported_format",
            Self::InvalidSource => "invalid_source",
            Self::InvalidApp => "invalid_app",
            Self::InvalidSchema => "invalid_schema",
            Self::SchemaConflict => "schema_conflict",
            Self::TransferLimit => "transfer_limit",
            Self::ResourceUnavailable => "resource_unavailable",
        }
    }
}
impl fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}
impl std::error::Error for FormatError {}

fn raw_error(e: raw_json::Error) -> FormatError {
    match e {
        raw_json::Error::Invalid => FormatError::InvalidFormat,
        raw_json::Error::InvalidKey => FormatError::InvalidApp,
        raw_json::Error::Capacity => FormatError::TransferLimit,
        raw_json::Error::Resource => FormatError::ResourceUnavailable,
    }
}
fn parse_apps(text: &str) -> Result<BTreeMap<String, AppState>, FormatError> {
    let apps = raw_json::app_map(text).map_err(raw_error)?;
    let mut result = BTreeMap::new();
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BorrowedApp<'a> {
        schema_version: u64,
        #[serde(borrow)]
        data: &'a serde_json::value::RawValue,
    }
    for (key, raw) in apps {
        let canonical =
            raw_json::canonical(raw.get(), crate::storage_limits::maximum_document_bytes())
                .map_err(raw_error)?;
        let app: BorrowedApp<'_> =
            serde_json::from_str(&canonical).map_err(|_| FormatError::InvalidFormat)?;
        let data = raw_json::copy(app.data.get()).map_err(raw_error)?;
        let data = serde_json::value::RawValue::from_string(data)
            .map_err(|_| FormatError::InvalidFormat)?;
        result.insert(
            key,
            AppState {
                schema_version: app.schema_version,
                data,
            },
        );
    }
    Ok(result)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn valid_app_version(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return false;
    }
    let main = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = main.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}
fn validate_apps(apps: &BTreeMap<String, AppState>) -> Result<String, FormatError> {
    if apps.len() > 128 {
        return Err(FormatError::TransferLimit);
    }
    for (key, value) in apps {
        if key.is_empty()
            || key.len() > 80
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        {
            return Err(FormatError::InvalidApp);
        }
        if value.schema_version == 0 || value.schema_version > MAX_SAFE_SCHEMA {
            return Err(FormatError::InvalidSchema);
        }
    }
    let state = String::from_utf8(
        raw_json::serialize(apps, crate::storage_limits::maximum_document_bytes())
            .map_err(raw_error)?,
    )
    .map_err(|_| FormatError::InvalidFormat)?;
    let state = raw_json::canonical(&state, crate::storage_limits::maximum_document_bytes())
        .map_err(raw_error)?;
    if state.len() > crate::storage_limits::maximum_document_bytes() {
        return Err(FormatError::TransferLimit);
    }
    Ok(state)
}
fn validate_file(file: &TransferFile) -> Result<String, FormatError> {
    if file.format != FORMAT || file.format_version != 1 {
        return Err(FormatError::UnsupportedFormat);
    }
    if !valid_app_version(&file.app_version) {
        return Err(FormatError::InvalidFormat);
    }
    if !digest(&file.source.root_identity)
        || !digest(&file.source.document_identity)
        || file.source.relative_path.len() > 4096
        || knowledge::validate_relative(&file.source.relative_path).is_err()
        || file.source.revision <= 0
        || file.source.generation < 0
    {
        return Err(FormatError::InvalidSource);
    }
    let canonical_state = validate_apps(&file.apps)?;
    // Escaped provenance must also fit the finite file envelope budget.
    if raw_json::serialize(&file, maximum_transfer_bytes())
        .map_err(raw_error)?
        .len()
        > maximum_transfer_bytes()
    {
        return Err(FormatError::TransferLimit);
    }
    Ok(canonical_state)
}
fn validate(file: TransferFile) -> Result<ValidatedTransfer, FormatError> {
    let canonical_state = validate_file(&file)?;
    let app_count = file.apps.len();
    let bytes = canonical_state.len() as i64;
    Ok(ValidatedTransfer {
        file,
        canonical_state,
        app_count,
        bytes,
    })
}

pub(crate) fn parse(input: &[u8]) -> Result<ValidatedTransfer, FormatError> {
    parse_with_capacity(
        input,
        crate::storage_limits::maximum_document_bytes(),
        maximum_transfer_bytes(),
    )
}
fn parse_with_capacity(
    input: &[u8],
    document_max: usize,
    transfer_max: usize,
) -> Result<ValidatedTransfer, FormatError> {
    if input.len() > transfer_max {
        return Err(FormatError::TransferLimit);
    }
    let text = std::str::from_utf8(input).map_err(|_| FormatError::InvalidFormat)?;
    let canonical = raw_json::canonical(text, transfer_max).map_err(raw_error)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Envelope<'a> {
        #[serde(borrow)]
        format: &'a str,
        format_version: u32,
        #[serde(borrow)]
        app_version: &'a str,
        #[serde(borrow)]
        source: &'a serde_json::value::RawValue,
        #[serde(borrow)]
        apps: &'a serde_json::value::RawValue,
    }
    let envelope: Envelope<'_> =
        serde_json::from_str(&canonical).map_err(|_| FormatError::InvalidFormat)?;
    if envelope.source.get().len() > 16 * 1024 {
        return Err(FormatError::InvalidSource);
    }
    if envelope.format != FORMAT {
        return Err(FormatError::UnsupportedFormat);
    }
    if envelope.app_version.len() > 64 {
        return Err(FormatError::InvalidFormat);
    }
    let source =
        serde_json::from_str(envelope.source.get()).map_err(|_| FormatError::InvalidFormat)?;
    let file = TransferFile {
        format: envelope.format.to_owned(),
        format_version: envelope.format_version,
        app_version: envelope.app_version.to_owned(),
        source,
        apps: parse_apps(envelope.apps.get())?,
    };
    let result = validate(file)?;
    if result.bytes as usize > document_max {
        return Err(FormatError::TransferLimit);
    }
    Ok(result)
}
pub(crate) fn from_state(
    app_version: &str,
    source: Source,
    data: &str,
) -> Result<ValidatedTransfer, FormatError> {
    validate(TransferFile {
        format: FORMAT.to_owned(),
        format_version: 1,
        app_version: app_version.to_owned(),
        source,
        apps: parse_apps(data)?,
    })
}

pub(crate) fn encode(file: &TransferFile) -> Result<Vec<u8>, FormatError> {
    // Callers may construct a TransferFile directly; encoding is not a bypass.
    // Typed maps already have unique keys; do not duplicate the payload tree.
    validate_file(file)?;
    raw_json::serialize(file, maximum_transfer_bytes()).map_err(raw_error)
}

pub(crate) fn check_schema_compatibility(
    incoming: &BTreeMap<String, AppState>,
    existing_state: &str,
) -> Result<(), FormatError> {
    validate_apps(incoming)?;
    let existing = parse_apps(existing_state)?;
    validate_apps(&existing)?;
    if incoming.iter().any(|(key, value)| {
        existing
            .get(key)
            .is_some_and(|old| old.schema_version != value.schema_version)
    }) {
        return Err(FormatError::SchemaConflict);
    }
    Ok(())
}

#[cfg(test)]
#[path = "format/tests.rs"]
mod tests;
