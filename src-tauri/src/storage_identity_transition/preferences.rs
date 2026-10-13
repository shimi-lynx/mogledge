//! Explicit workspace preference preparation; no filesystem access or publication.
use crate::{
    identifier_migration::MigrationError,
    workspace_settings::{self, DocumentRef, Lists, SetShortcuts, WorkingSet},
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

const MAX_BYTES: usize = 256 * 1024;
const LEGACY_MAX_BYTES: usize = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stored {
    version: u8,
    root_identity: String,
    lists: Lists,
    #[serde(default)]
    sets: Vec<WorkingSet>,
    #[serde(default)]
    folder_favorites: Vec<DocumentRef>,
    #[serde(default)]
    set_shortcuts: SetShortcuts,
}

pub(crate) struct PreparedPreferences {
    pub(crate) bytes: Vec<u8>,
    pub(crate) preview: Value,
    // The caller must verify these current paths' physical identities again
    // while holding the transition gate, before committing/publishing anything.
    pub(crate) mapped_documents: Vec<DocumentRef>,
}

fn valid(stored: &Stored) -> bool {
    crate::state_inspection::digest_id(&stored.root_identity)
        && workspace_settings::valid_favorites(&stored.lists, &stored.folder_favorites)
        && workspace_settings::valid_list(&stored.lists.recent)
        && workspace_settings::valid_sets(&stored.sets)
        && workspace_settings::valid_set_shortcuts(&stored.set_shortcuts, &stored.sets)
}

fn decode(bytes: &[u8], source_root: &str) -> Result<Stored, MigrationError> {
    if bytes.len() > MAX_BYTES {
        return Err(MigrationError::CapacityExceeded);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| MigrationError::Corrupt)?;
    let object = value.as_object().ok_or(MigrationError::Corrupt)?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or(MigrationError::Corrupt)?;
    let required: &[&str] = match version {
        1 => &["version", "rootIdentity", "lists"],
        2 => &["version", "rootIdentity", "lists", "sets"],
        3 | 4 => &[
            "version",
            "rootIdentity",
            "lists",
            "sets",
            "folderFavorites",
        ],
        _ => return Err(MigrationError::Corrupt),
    };
    // Defaults normalize old versions only after their exact topology has been
    // checked. In particular, v1-v3 cannot acquire newer fields implicitly.
    if (version == 1 && bytes.len() > LEGACY_MAX_BYTES)
        || required.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| {
            !required.contains(&key.as_str()) && !(version == 4 && key == "setShortcuts")
        })
    {
        return Err(MigrationError::Corrupt);
    }
    // Deserialize the original bytes too: Value alone would hide duplicate keys.
    let stored: Stored = serde_json::from_slice(bytes).map_err(|_| MigrationError::Corrupt)?;
    if stored.root_identity != source_root || !valid(&stored) {
        return Err(MigrationError::Corrupt);
    }
    Ok(stored)
}

/// Read only explicit source->target confirmations in this root. A source
/// approved for multiple targets is ambiguous for preferences, so remains old.
fn approved_documents(
    connection: &Connection,
    source_root: &str,
    current_root: &str,
) -> Result<HashMap<String, Option<DocumentRef>>, MigrationError> {
    let mut statement = connection
        .prepare(
            "SELECT c.source,c.document,d.path,EXISTS(SELECT 1 FROM state_tombstones t \
                         WHERE t.document_id=s.id OR t.document_id=c.document) \
             FROM identity_confirmations c \
             JOIN documents s ON s.id=c.source AND s.root=?1 \
             LEFT JOIN documents d ON d.id=c.document AND d.root=?2 \
             WHERE c.root=?2 AND c.scheme=?3 AND c.source<>'' \
             ORDER BY c.source,c.document LIMIT 4097",
        )
        .map_err(super::sql)?;
    let rows = statement
        .query_map(params![source_root, current_root, super::SCHEME], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })
        .map_err(super::sql)?;
    let mut mappings = HashMap::new();
    for (index, row) in rows.enumerate() {
        if index >= 4096 {
            return Err(MigrationError::Corrupt);
        }
        let (source, identity, path, quarantined) = row.map_err(super::sql)?;
        let target = path.map(|relative_path| DocumentRef {
            identity,
            relative_path,
        });
        if !crate::state_inspection::digest_id(&source)
            || target
                .as_ref()
                .is_some_and(|target| !workspace_settings::valid_list(std::slice::from_ref(target)))
        {
            return Err(MigrationError::Corrupt);
        }
        mappings
            .entry(source)
            .and_modify(|existing| *existing = None)
            .or_insert(if quarantined { None } else { target });
    }
    Ok(mappings)
}

/// Prepare a new root's preference file without modifying the old one. The
/// caller owns source/target file checks, backup, nonce and final revalidation;
/// target_exists must include any existing leaf, including malformed/linked data.
pub(crate) fn prepare(
    connection: &Connection,
    source_root: &str,
    current_root: &str,
    source_bytes: &[u8],
    target_exists: bool,
) -> Result<PreparedPreferences, MigrationError> {
    if target_exists {
        return Err(MigrationError::SourceChanged);
    }
    if !crate::state_inspection::digest_id(source_root)
        || !crate::state_inspection::digest_id(current_root)
    {
        return Err(MigrationError::Corrupt);
    }
    let mut stored = decode(source_bytes, source_root)?;
    if !super::root_confirmed(connection, current_root)? {
        return Err(MigrationError::UnsupportedDatabase);
    }
    crate::identifier_migration::validate_schema(connection)?;
    crate::state_inspection::recovery_store::validate_metadata(connection)?;
    let mappings = approved_documents(connection, source_root, current_root)?;
    let source_version = stored.version;
    let mut mapped = BTreeMap::new();
    let mut mapped_references = 0usize;
    let mut unresolved_references = 0usize;
    for document in stored
        .lists
        .favorites
        .iter_mut()
        .chain(&mut stored.lists.recent)
        .chain(
            stored
                .sets
                .iter_mut()
                .flat_map(|set| set.items.iter_mut().map(|item| &mut item.document)),
        )
    {
        if let Some(Some(target)) = mappings.get(&document.identity) {
            *document = target.clone();
            mapped.insert(target.identity.clone(), target.clone());
            mapped_references += 1;
        } else {
            // A matching path is only a hint and grants no binding authority.
            unresolved_references += 1;
        }
    }
    let unresolved_folders = stored.folder_favorites.len();
    stored.version = 4;
    stored.root_identity = current_root.to_owned();
    if !valid(&stored) {
        // Never deduplicate/reorder lists or working-set indexes to hide a
        // mapping collision; the original remains available for explicit repair.
        return Err(MigrationError::SourceChanged);
    }
    let bytes = serde_json::to_vec(&stored).map_err(|_| MigrationError::ResourceUnavailable)?;
    if bytes.len() > MAX_BYTES {
        return Err(MigrationError::CapacityExceeded);
    }
    Ok(PreparedPreferences {
        bytes,
        preview: json!({
            "sourceRootIdentity": source_root,
            "currentRootIdentity": current_root,
            "sourceVersion": source_version,
            "outputVersion": 4,
            "mappedDocumentReferences": mapped_references,
            "unresolvedDocumentReferences": unresolved_references,
            "unresolvedFolderReferences": unresolved_folders,
            "sourceRetained": true,
            "existingTargetReplacement": false,
            "pathMatching": false
        }),
        mapped_documents: mapped.into_values().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: char) -> String {
        value.to_string().repeat(64)
    }

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL); CREATE INDEX document_location ON documents(root,path,generation); CREATE TABLE quota (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, documents INTEGER NOT NULL, generation INTEGER NOT NULL); INSERT INTO quota VALUES(1,0,0,10);").unwrap();
        connection
            .execute_batch(&format!(
                "{};{};{};{};PRAGMA user_version=3;",
                crate::state_inspection::recovery_store::RECORDS_DDL,
                crate::state_inspection::recovery_store::TOMBSTONES_DDL,
                super::super::ROOTS_DDL,
                super::super::CONFIRMATIONS_DDL
            ))
            .unwrap();
        connection
            .execute(
                "INSERT INTO identity_roots VALUES(?1,?2,?3,?4,?5)",
                params![id('b'), super::super::SCHEME, id('c'), id('d'), id('a')],
            )
            .unwrap();
        connection
    }

    fn approve(connection: &Connection, source: char, target: char, operation: char, root: char) {
        connection
            .execute(
                "INSERT OR IGNORE INTO documents VALUES(?1,'{}',2,1,?2,'old.html',1)",
                params![id(source), id(root)],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO documents VALUES(?1,'{}',2,1,?2,'approved.html',2)",
                params![id(target), id('b')],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO identity_confirmations VALUES(?1,?2,?3,?4,?5,1,?6,2)",
                params![
                    id(target),
                    id('b'),
                    super::super::SCHEME,
                    id(operation),
                    id(source),
                    id('d')
                ],
            )
            .unwrap();
    }

    fn source(version: u8) -> Value {
        let mut value = json!({"version":version,"rootIdentity":id('a'),"lists":{"favorites":[{"relativePath":"old.html","identity":id('e')}],"recent":[{"relativePath":"approved.html","identity":id('f')}]}});
        if version >= 2 {
            value["sets"] = json!([{"id":id('9'),"name":"確認","items":[{"document":{"relativePath":"old.html","identity":id('e')},"column":0,"zoom":125.0}],"active":[0,null],"activeColumn":0}]);
        }
        if version >= 3 {
            value["folderFavorites"] = json!([{"relativePath":"folder","identity":id('8')}]);
        }
        if version == 4 {
            value["setShortcuts"] = json!([
                id('9'),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null
            ]);
        }
        value
    }

    #[test]
    fn copies_only_unique_approved_identities_and_preserves_unresolved_refs() {
        let connection = database();
        approve(&connection, 'e', '1', '2', 'a');
        let original = serde_json::to_vec(&source(4)).unwrap();
        let prepared = prepare(&connection, &id('a'), &id('b'), &original, false).unwrap();
        let copied: Value = serde_json::from_slice(&prepared.bytes).unwrap();
        assert_eq!(copied["rootIdentity"], id('b'));
        assert_eq!(copied["lists"]["favorites"][0]["identity"], id('1'));
        assert_eq!(
            copied["lists"]["favorites"][0]["relativePath"],
            "approved.html"
        );
        assert_eq!(copied["lists"]["recent"], source(4)["lists"]["recent"]);
        assert_eq!(copied["folderFavorites"], source(4)["folderFavorites"]);
        assert_eq!(copied["sets"][0]["active"], json!([0, null]));
        assert_eq!(copied["setShortcuts"], source(4)["setShortcuts"]);
        assert_eq!(prepared.preview["mappedDocumentReferences"], 2);
        assert_eq!(prepared.preview["unresolvedDocumentReferences"], 1);
        assert_eq!(prepared.preview["unresolvedFolderReferences"], 1);
        assert_eq!(prepared.mapped_documents.len(), 1);
        assert_eq!(original, serde_json::to_vec(&source(4)).unwrap());
    }

    #[test]
    fn refuses_existing_target_and_preserves_ambiguous_or_other_root_sources() {
        let connection = database();
        approve(&connection, 'e', '1', '2', 'a');
        approve(&connection, 'e', '3', '4', 'a');
        approve(&connection, 'f', '5', '6', '7');
        let original = serde_json::to_vec(&source(4)).unwrap();
        assert!(prepare(&connection, &id('a'), &id('b'), &original, true).is_err());
        let prepared = prepare(&connection, &id('a'), &id('b'), &original, false).unwrap();
        let copied: Value = serde_json::from_slice(&prepared.bytes).unwrap();
        assert_eq!(copied["lists"], source(4)["lists"]);
        assert_eq!(copied["sets"], source(4)["sets"]);
        assert!(prepared.mapped_documents.is_empty());
        assert_eq!(prepared.preview["unresolvedDocumentReferences"], 3);
        // Removing one of the two approved targets must not silently choose the
        // remaining one; the owner's earlier assignment is still ambiguous.
        connection
            .execute("DELETE FROM documents WHERE id=?1", [id('3')])
            .unwrap();
        let prepared = prepare(&connection, &id('a'), &id('b'), &original, false).unwrap();
        assert!(prepared.mapped_documents.is_empty());
    }

    #[test]
    fn retains_v1_to_v4_topology_and_rejects_invalid_or_future_data() {
        let connection = database();
        for version in 1..=4 {
            let original = serde_json::to_vec(&source(version)).unwrap();
            let prepared = prepare(&connection, &id('a'), &id('b'), &original, false).unwrap();
            let copied: Value = serde_json::from_slice(&prepared.bytes).unwrap();
            assert_eq!(copied["version"], 4);
            assert_eq!(prepared.preview["sourceVersion"], version);
            assert_eq!(copied["lists"], source(version)["lists"]);
        }
        for version in 1..=3 {
            let mut invalid = source(version);
            invalid["setShortcuts"] = json!(vec![Value::Null; 10]);
            assert!(decode(&serde_json::to_vec(&invalid).unwrap(), &id('a')).is_err());
        }
        let mut missing = source(3);
        missing.as_object_mut().unwrap().remove("folderFavorites");
        assert!(decode(&serde_json::to_vec(&missing).unwrap(), &id('a')).is_err());
        let duplicate = String::from_utf8(serde_json::to_vec(&source(4)).unwrap())
            .unwrap()
            .replacen('{', "{\"version\":4,", 1);
        assert!(decode(duplicate.as_bytes(), &id('a')).is_err());
        assert!(decode(&serde_json::to_vec(&source(5)).unwrap(), &id('a')).is_err());
        assert!(decode(&vec![b' '; MAX_BYTES + 1], &id('a')).is_err());
        let mut oversized_legacy = serde_json::to_vec(&source(1)).unwrap();
        oversized_legacy.resize(LEGACY_MAX_BYTES + 1, b' ');
        assert!(decode(&oversized_legacy, &id('a')).is_err());
    }

    #[test]
    fn rejects_mapping_collisions_without_reordering_working_set_items() {
        let connection = database();
        approve(&connection, 'e', '1', '2', 'a');
        let mut value = source(4);
        let mut second = value["sets"][0]["items"][0].clone();
        second["document"]["identity"] = json!(id('1'));
        value["sets"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(second);
        let original = serde_json::to_vec(&value).unwrap();
        assert!(decode(&original, &id('a')).is_ok());
        assert!(prepare(&connection, &id('a'), &id('b'), &original, false).is_err());
        assert_eq!(original, serde_json::to_vec(&value).unwrap());
    }
}
