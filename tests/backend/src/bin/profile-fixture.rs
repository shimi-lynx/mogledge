//! Disposable Native migration fixtures. Never resolves APPDATA or user profiles.
use mogledge_backend_tests::{
    core::Core,
    document_server,
    document_state::{self, DocumentState, Operation, StateRequest, MAX_DOCUMENT_BYTES},
    identifier_migration::{
        self as migration, Decision, Locations, MigrationError, Startup, CURRENT_IDENTIFIER,
        LEGACY_IDENTIFIER, LEGACY_PRODUCT_IDENTIFIER,
    },
    tree_order::{self, Order},
    write_fs,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const MARKER_FILE: &str = ".profile-fixture.json";
const HTML: &[u8] = include_bytes!("../../../fixtures/knowledge/Storage/Generated.html");

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    #[serde(rename = "schemaVersion")]
    version: u8,
    root: PathBuf,
    token: String,
    #[serde(rename = "oldIdentifier")]
    legacy: String,
    #[serde(rename = "newIdentifier")]
    current: String,
    #[serde(rename = "originalFiles")]
    original_files: BTreeMap<String, String>,
}

fn validate_ids(legacy: &str, current: &str, token: &str) -> Result<()> {
    let dedicated = |id: &str| {
        id.len() <= 128
            && id.starts_with("org.mogledge.native-qa.")
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && ![
                LEGACY_IDENTIFIER,
                LEGACY_PRODUCT_IDENTIFIER,
                CURRENT_IDENTIFIER,
            ]
            .iter()
            .any(|formal| id.eq_ignore_ascii_case(formal))
    };
    // This check precedes ALL filesystem work, including Locations::new preflight.
    if !dedicated(legacy) || !dedicated(current) || legacy.eq_ignore_ascii_case(current) {
        return Err("two distinct dedicated QA identifiers are required".into());
    }
    if !token
        .strip_prefix("qa-")
        .is_some_and(|tail| tail.len() == 32 && tail.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("expected marker token must be qa- followed by 32 hex digits".into());
    }
    Ok(())
}

fn check_path(root: &Path) -> Result<()> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("fixture root must be an ordinary absolute path".into());
    }
    let workspace = std::env::current_dir()?.join(".tools/identifier-native-qa");
    let temp = std::env::temp_dir();
    if !((root.starts_with(&temp) && root != temp)
        || (root.starts_with(&workspace) && root != workspace))
    {
        return Err("fixture root must be below OS temp or cwd/.tools/identifier-native-qa".into());
    }
    check_directories(root)
}

fn check_directories(path: &Path) -> Result<()> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if write_fs::rejected_link(&meta) || !meta.is_dir() => {
                return Err("fixture ancestor is not an ordinary directory".into());
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn ordinary_file(path: &Path) -> Result<fs::File> {
    check_directories(path.parent().ok_or("fixture file has no parent")?)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000 | 0x00100000).share_mode(3);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if write_fs::rejected_link(&metadata) || !metadata.is_file() {
        return Err("fixture file is not ordinary".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err("fixture hardlink is forbidden".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
            },
        };
        let mut info = FILE_STANDARD_INFO::default();
        // SAFETY: live owned file handle and correctly sized output remain valid.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileStandardInfo,
                (&mut info as *mut FILE_STANDARD_INFO).cast(),
                std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
            )
        }?;
        if info.NumberOfLinks != 1 {
            return Err("fixture hardlink is forbidden".into());
        }
    }
    Ok(file)
}

fn collect_files(root: &Path, path: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
    check_directories(path.parent().ok_or("fixture entry has no parent")?)?;
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if write_fs::rejected_link(&meta) {
        return Err("fixture contains a linked or placeholder entry".into());
    }
    let relative = path
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    if meta.is_dir() {
        files.insert(format!("{relative}/"), "directory".into());
        for entry in fs::read_dir(path)? {
            collect_files(root, &entry?.path(), files)?;
        }
    } else if meta.is_file() {
        let mut file = ordinary_file(path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        files.insert(relative, format!("{:x}", hash.finalize()));
    } else {
        return Err("fixture contains a special entry".into());
    }
    if files.len() > 4096 {
        return Err("fixture inventory limit exceeded".into());
    }
    Ok(())
}

fn originals(root: &Path, legacy: &str) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    for path in [
        root.join("config").join(legacy),
        root.join("local").join(legacy),
        root.join("knowledge"),
    ] {
        collect_files(root, &path, &mut files)?;
    }
    Ok(files)
}

fn request(
    core: &Arc<Core>,
    relative: &str,
    key: &str,
    value: Value,
    expected_revision: i64,
) -> Result<()> {
    let snapshot = core.snapshot();
    let workspace = snapshot
        .workspace_id
        .ok_or("fixture workspace is unavailable")?;
    let tab = core.create_tab(&workspace, &snapshot.view_id, relative)?;
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1)?;
    let (token, _) =
        document_server::decode_path(url.strip_prefix(&core.origin).ok_or("unexpected origin")?)
            .ok_or("unexpected document URL")?;
    let response = document_state::operate(
        core,
        &token,
        StateRequest {
            version: 1,
            op: Operation::Write,
            key: key.into(),
            value: Some(value),
        },
    )
    .map_err(|error| error.code())?;
    if response.revision != expected_revision {
        return Err("fixture seed revision is unexpected".into());
    }
    Ok(())
}

fn seed(root: &Path, legacy: &str, current: &str, token: &str) -> Result<Value> {
    if root.exists() && fs::read_dir(root)?.next().is_some() {
        return Err("seed refuses a nonempty fixture root".into());
    }
    let config = root.join("config");
    let local = root.join("local");
    // Locations validates the exact same base/id contract used by Native migration.
    let _locations = Locations::new(&config, &local, legacy, current)?;
    let knowledge = root.join("knowledge");
    fs::create_dir_all(&knowledge)?;
    let (knowledge, _) = mogledge_backend_tests::knowledge::open_root(&knowledge)?;
    let old_config = config.join(legacy);
    let old_local = local.join(legacy);
    fs::create_dir_all(&old_config)?;
    for relative in ["Generated.html", "Capacity.html"] {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(knowledge.join(relative))?;
        file.write_all(HTML)?;
        file.sync_all()?;
    }
    let settings = old_config.join("settings.json");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&settings)?;
    file.write_all(&serde_json::to_vec(&json!({"knowledgeRoot": knowledge}))?)?;
    file.sync_all()?;
    drop(file);
    let core = Core::new(19074);
    core.settings_path
        .set(settings)
        .map_err(|_| "duplicate fixture settings")?;
    core.document_state
        .set(DocumentState::new(old_local.join("document-state")).map_err(|error| error.code())?)
        .map_err(|_| "duplicate fixture state")?;
    tree_order::save(
        &core,
        &knowledge,
        &Order {
            parents: BTreeMap::from([(
                String::new(),
                vec!["Generated.html".into(), "Capacity.html".into()],
            )]),
        },
    )?;
    core.restore()?;
    core.watcher
        .lock()
        .map_err(|_| "fixture watcher lock failed")?
        .take();
    request(
        &core,
        "Generated.html",
        "generated-calculator",
        json!({"schemaVersion": 1, "data": {"amount": 42, "mode": "double", "enabled": true}}),
        1,
    )?;
    let empty = json!({"schemaVersion": 1, "data": {"padding": ""}});
    let overhead = serde_json::to_vec(&json!({"qa-capacity": empty}))?.len();
    let capacity =
        json!({"schemaVersion": 1, "data": {"padding": "x".repeat(MAX_DOCUMENT_BYTES - overhead)}});
    if serde_json::to_vec(&json!({"qa-capacity": &capacity}))?.len() != MAX_DOCUMENT_BYTES {
        return Err("capacity fixture does not meet the exact 5MiB boundary".into());
    }
    request(&core, "Capacity.html", "qa-capacity", capacity, 1)?;
    drop(core); // Close SQLite before hashing source bytes and launching Native QA.
    fs::create_dir_all(old_local.join("search-index"))?;
    fs::write(
        old_local.join("search-index/fixture-cache"),
        b"not authoritative",
    )?;
    fs::create_dir_all(old_local.join("WebView2"))?;
    fs::write(
        old_local.join("WebView2/fixture-cookie"),
        b"must not migrate",
    )?;
    let marker = Marker {
        version: 1,
        root: root.into(),
        token: token.into(),
        legacy: legacy.into(),
        current: current.into(),
        original_files: originals(root, legacy)?,
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join(MARKER_FILE))?;
    file.write_all(&serde_json::to_vec_pretty(&marker)?)?;
    file.sync_all()?;
    Ok(
        json!({"seeded": true, "knowledge": knowledge, "configBase": config, "localBase": local,
        "capacityBytes": MAX_DOCUMENT_BYTES, "capacityKey": "qa-capacity", "calculatorAmount": 42}),
    )
}

fn load_marker(root: &Path, legacy: &str, current: &str, token: &str) -> Result<Marker> {
    let path = root.join(MARKER_FILE);
    let metadata = fs::symlink_metadata(&path)?;
    if write_fs::rejected_link(&metadata) || !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("fixture marker is not an ordinary bounded file".into());
    }
    let mut bytes = Vec::new();
    ordinary_file(&path)?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 1024 * 1024 {
        return Err("fixture marker exceeds its limit".into());
    }
    let marker: Marker = serde_json::from_slice(&bytes)?;
    if marker.version != 1
        || marker.root != root
        || marker.token != token
        || marker.legacy != legacy
        || marker.current != current
    {
        return Err("fixture marker does not match the expected root/identifiers/token".into());
    }
    Ok(marker)
}

fn database_status(path: &Path) -> Result<Value> {
    check_directories(path)?;
    let database = path.join("state.sqlite");
    if !database.exists() {
        return Ok(json!({"exists": false}));
    }
    let mut files = BTreeMap::new();
    collect_files(path, path, &mut files)?;
    // Even READ_ONLY may create WAL sidecars. Refuse before giving SQLite the path.
    for entry in fs::read_dir(path)? {
        if entry?.file_name() != "state.sqlite" {
            return Err("status requires a closed DELETE-mode DB without sidecars".into());
        }
    }
    let mut header = [0u8; 100];
    ordinary_file(&database)?.read_exact(&mut header)?;
    if &header[..16] != b"SQLite format 3\0" || header[18] != 1 || header[19] != 1 {
        return Err("status refuses an unsupported database header".into());
    }
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(std::time::Duration::from_millis(250))?;
    connection.execute_batch("PRAGMA trusted_schema=OFF;")?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    let (bytes, documents, generation): (i64, i64, i64) = connection.query_row(
        "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut query =
        connection.prepare("SELECT path,bytes,revision,generation FROM documents ORDER BY path")?;
    let records = query.query_map([], |row| Ok(json!({"path": row.get::<_, String>(0)?,
        "bytes": row.get::<_, i64>(1)?, "revision": row.get::<_, i64>(2)?, "generation": row.get::<_, i64>(3)?})))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(
        json!({"exists": true, "integrity": integrity, "quotaBytes": bytes,
        "documents": documents, "generation": generation, "records": records}),
    )
}

fn copy_payload(source: &Path, target: &Path, limit: u64) -> Result<()> {
    let mut source = ordinary_file(source)?;
    let expected = source.metadata()?.len();
    if expected > limit {
        return Err("fixture payload exceeds its copy limit".into());
    }
    let mut target = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copied = std::io::copy(&mut Read::take(&mut source, limit + 1), &mut target)?;
    if copied != expected || copied > limit {
        return Err("fixture source changed during copy".into());
    }
    target.sync_all()?;
    Ok(())
}

fn seed_current(root: &Path, legacy: &str, current: &str, marker: &Marker) -> Result<Value> {
    if originals(root, legacy)? != marker.original_files {
        return Err("seed-current refuses changed original profile or knowledge bytes".into());
    }
    let old_config = root.join("config").join(legacy);
    let old_state = root.join("local").join(legacy).join("document-state");
    let new_config = root.join("config").join(current);
    let new_local = root.join("local").join(current);
    let new_state = new_local.join("document-state");
    let bundle = new_local.join("identifier-migration-v1");
    check_directories(&new_local)?;
    check_directories(new_config.parent().ok_or("current config has no parent")?)?;
    for path in [&new_config, &new_state, &bundle] {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Ok(_) => return Err("seed-current refuses an existing current profile".into()),
            Err(error) => return Err(error.into()),
        }
    }
    // Reuse the readonly closed-DELETE preflight before copying the SQLite file.
    let status = database_status(&old_state)?;
    if status["exists"] != true || status["integrity"] != "ok" {
        return Err("seed-current requires the intact seeded legacy database".into());
    }
    fs::create_dir(&new_config)?;
    fs::create_dir_all(&new_state)?;
    copy_payload(
        &old_config.join("settings.json"),
        &new_config.join("settings.json"),
        1024 * 1024,
    )?;
    let old_orders = old_config.join("tree-order");
    let new_orders = new_config.join("tree-order");
    fs::create_dir(&new_orders)?;
    for entry in fs::read_dir(old_orders)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "invalid fixture order name")?;
        if name.len() != 21
            || !name.ends_with(".json")
            || !name.as_bytes()[..16]
                .iter()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("seed-current copies only committed order JSON".into());
        }
        copy_payload(&entry.path(), &new_orders.join(name), 1024 * 1024)?;
    }
    copy_payload(
        &old_state.join("state.sqlite"),
        &new_state.join("state.sqlite"),
        1024 * 1024 * 1024,
    )?;
    let core = Core::new(19075);
    core.settings_path
        .set(new_config.join("settings.json"))
        .map_err(|_| "duplicate current fixture settings")?;
    core.document_state
        .set(DocumentState::new(new_state).map_err(|error| error.code())?)
        .map_err(|_| "duplicate current fixture state")?;
    core.restore()?;
    core.watcher
        .lock()
        .map_err(|_| "current fixture watcher lock failed")?
        .take();
    request(
        &core,
        "Generated.html",
        "generated-calculator",
        json!({"schemaVersion": 1, "data": {"amount": 99, "mode": "double", "enabled": true}}),
        2,
    )?;
    drop(core);
    if originals(root, legacy)? != marker.original_files {
        return Err("seed-current changed original profile or knowledge bytes".into());
    }
    Ok(
        json!({"currentSeeded": true, "calculatorAmount": 99, "revision": 2,
        "oldUnchanged": true, "cacheCopied": false, "webviewCopied": false}),
    )
}

fn inspect(root: &Path, legacy: &str, current: &str) -> Result<Value> {
    let locations = Locations::new(&root.join("config"), &root.join("local"), legacy, current)?;
    match migration::prepare(&locations, Decision::Inspect) {
        Ok(Startup::Ready(profile)) => {
            let paths = json!({"settings": profile.paths.settings,
                "documentState": profile.paths.document_state, "searchIndex": profile.paths.search_index});
            // Exercise the production lock while the first PreparedProfile is alive.
            if !matches!(
                migration::prepare(&locations, Decision::Inspect),
                Err(MigrationError::Busy)
            ) {
                return Err("a live PreparedProfile did not block the second runtime".into());
            }
            drop(profile);
            match migration::prepare(&locations, Decision::Inspect) {
                Ok(Startup::Ready(reopened)) => {
                    drop(reopened);
                    Ok(json!({"startup": "Ready", "paths": paths,
                        "whileLeaseHeld": "Busy", "afterLeaseDrop": "Ready"}))
                }
                _ => Err("the profile was not Ready after dropping its lease".into()),
            }
        }
        Ok(Startup::NeedsConsent) => Ok(json!({"startup": "NeedsConsent"})),
        Ok(Startup::Conflict) => Ok(json!({"startup": "Conflict"})),
        Ok(Startup::ConflictingCurrentProfiles) => {
            Ok(json!({"startup": "ConflictingCurrentProfiles"}))
        }
        Err(error) => Ok(json!({"startup": "Error", "error": format!("{error:?}")})),
    }
}

fn run() -> Result<Value> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 5
        || !matches!(
            args[0].as_str(),
            "seed" | "seed-current" | "status" | "verify-old" | "inspect"
        )
    {
        return Err("usage: profile-fixture <seed|seed-current|status|verify-old|inspect> <root> <old-qa-id> <new-qa-id> <qa-32hex-token>".into());
    }
    validate_ids(&args[2], &args[3], &args[4])?;
    let root = PathBuf::from(&args[1]);
    check_path(&root)?;
    if args[0] == "seed" {
        return seed(&root, &args[2], &args[3], &args[4]);
    }
    let marker = load_marker(&root, &args[2], &args[3], &args[4])?;
    if args[0] == "seed-current" {
        return seed_current(&root, &args[2], &args[3], &marker);
    }
    if args[0] == "inspect" {
        let mut result = inspect(&root, &args[2], &args[3])?;
        result["oldUnchanged"] = json!(originals(&root, &args[2])? == marker.original_files);
        return Ok(result);
    }
    let old_unchanged = originals(&root, &args[2])? == marker.original_files;
    if args[0] == "verify-old" {
        if !old_unchanged {
            return Err("original profile or knowledge bytes changed".into());
        }
        return Ok(json!({"oldUnchanged": true, "entries": marker.original_files.len()}));
    }
    let current = root.join("local").join(&args[3]);
    let bundle = current.join("identifier-migration-v1");
    let old = root.join("local").join(&args[2]);
    Ok(
        json!({"oldUnchanged": old_unchanged, "legacy": database_status(&old.join("document-state"))?,
        "ordinaryCurrent": database_status(&current.join("document-state"))?,
        "bundleCurrent": database_status(&bundle.join("document-state"))?,
        "bundleMarker": bundle.join("complete.json").is_file(),
        "currentSettings": root.join("config").join(&args[3]).join("settings.json").is_file()}),
    )
}

fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("profile-fixture: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formal_ids_and_ambiguous_identifiers_are_rejected_before_filesystem() {
        let qa = "org.mogledge.native-qa.new";
        let token = "qa-0123456789abcdef0123456789abcdef";
        for formal in [
            LEGACY_IDENTIFIER,
            LEGACY_PRODUCT_IDENTIFIER,
            CURRENT_IDENTIFIER,
            "COM.SHIMILYNX.AIWIKI",
            "COM.SHIMILYNX.MYKNOWLEDGE",
        ] {
            assert!(validate_ids(formal, qa, token).is_err());
            assert!(validate_ids(qa, formal, token).is_err());
        }
        assert!(validate_ids(qa, qa, token).is_err());
        assert!(validate_ids("org.mogledge.native-qa.old", qa, token).is_ok());
        assert!(validate_ids("org.mogledge.native-qa.old", qa, "incorrect").is_err());
    }
}
