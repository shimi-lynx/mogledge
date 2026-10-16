//! Reboot-stable Mac identity used by ordinary Mac builds. Existing records
//! require independent backup and explicit root/document acknowledgement.
use sha2::{Digest, Sha256};
use std::io;

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
pub(crate) struct MountedObject {
    pub volume_uuid: [u8; 16],
    pub device: u64,
    pub file_id: u128,
    pub created_ns: u128,
}

#[repr(C)]
struct AttrList {
    bitmap_count: u16,
    reserved: u16,
    common: u32,
    volume: u32,
    directory: u32,
    file: u32,
    fork: u32,
}

// XNU packs attributes in four-byte increments. Checking the raw wire buffer
// keeps omitted attributes from shifting a UUID into an unrelated field.
fn volume_attributes(buffer: &[u8; 72]) -> io::Result<[u8; 16]> {
    let word = |offset| u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap());
    const RETURNED_ATTRS: u32 = 0x8000_0000;
    const CAPABILITIES: u32 = 0x0002_0000;
    const UUID: u32 = 0x0004_0000;
    const PERSISTENT_OBJECT_IDS: u32 = 1;
    const NO_ROOT_TIMES: u32 = 0x20;
    let uuid: [u8; 16] = buffer[56..72].try_into().unwrap();
    if word(0) != 72
        || word(4) & RETURNED_ATTRS == 0
        || word(8) & (CAPABILITIES | UUID) != CAPABILITIES | UUID
        || word(40) & (PERSISTENT_OBJECT_IDS | NO_ROOT_TIMES)
            != PERSISTENT_OBJECT_IDS | NO_ROOT_TIMES
        || word(24) & PERSISTENT_OBJECT_IDS == 0
        || word(24) & NO_ROOT_TIMES != 0
        || uuid == [0; 16]
    {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "persistent volume/object metadata unavailable",
        ));
    }
    Ok(uuid)
}

fn hash(domain: &[u8], objects: &[MountedObject]) -> io::Result<String> {
    let mut hash = Sha256::new();
    hash.update(domain);
    for object in objects {
        if object.volume_uuid == [0; 16] || object.file_id == 0 || object.created_ns == 0 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "persistent volume/object metadata unavailable",
            ));
        }
        // device is useful for live handle equality, but is a mount-session
        // number. Neither it nor a pathname belongs in persistent IDs.
        hash.update(object.volume_uuid);
        hash.update(object.file_id.to_le_bytes());
        hash.update(object.created_ns.to_le_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn document(root: MountedObject, file: MountedObject) -> io::Result<String> {
    // Frozen identity-format domain; changing branding here would produce different record keys.
    hash(b"my-knowledge-document-state-macos-v2", &[root, file])
}

pub(crate) fn root(root: MountedObject) -> io::Result<String> {
    hash(b"my-knowledge-state-root-macos-v2", &[root])
}

#[cfg(target_os = "macos")]
pub(crate) fn opened_object(file: &std::fs::File) -> io::Result<MountedObject> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    // Apple sys/attr.h and Libc unistd.h define this 64-bit Darwin ABI.
    // Returned attributes are requested so missing UUID support fails closed.
    unsafe extern "C" {
        fn fgetattrlist(
            fd: i32,
            attributes: *mut AttrList,
            buffer: *mut std::ffi::c_void,
            size: usize,
            options: u32,
        ) -> i32;
    }
    const RETURNED_ATTRS: u32 = 0x8000_0000;
    const VOL_CAPABILITIES: u32 = 0x0002_0000;
    const VOL_UUID: u32 = 0x0004_0000;
    const VOL_INFO: u32 = 0x8000_0000;
    let mut attributes = AttrList {
        bitmap_count: 5,
        reserved: 0,
        common: RETURNED_ATTRS,
        volume: VOL_INFO | VOL_CAPABILITIES | VOL_UUID,
        directory: 0,
        file: 0,
        fork: 0,
    };
    assert_eq!(std::mem::size_of::<AttrList>(), 24);
    let mut buffer = [0_u8; 72];
    // SAFETY: fd is borrowed from a live File; both fixed-size ABI structures
    // are initialized and writable for the complete synchronous call.
    if unsafe {
        fgetattrlist(
            file.as_raw_fd(),
            &mut attributes,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    #[cfg(test)]
    let word = |offset| u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap());
    #[cfg(test)]
    println!("MOGLEDGE_STORAGE_NATIVE_VOLUME returned_common={:08x} returned_volume={:08x} capabilities_format={:08x} valid_format={:08x}", word(4),word(8),word(24),word(40));
    let volume_uuid = volume_attributes(&buffer)?;
    let metadata = file.metadata()?;
    // As in v1, absence of a trustworthy birth time is an error, not a
    // pathname or inode-only fallback that could inherit a replaced file.
    let created_ns = metadata
        .created()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    Ok(MountedObject {
        volume_uuid,
        device: metadata.dev(),
        file_id: u128::from(metadata.ino()),
        created_ns,
    })
}

#[test]
fn packed_volume_result_rejects_missing_fields_and_nonpersistent_metadata() {
    // Fixed Darwin LP64 layout from sys/attr.h; not inferred from our request.
    assert_eq!(std::mem::size_of::<AttrList>(), 24);
    assert_eq!(std::mem::align_of::<AttrList>(), 4);
    assert_eq!(std::mem::offset_of!(AttrList, common), 4);
    assert_eq!(std::mem::offset_of!(AttrList, volume), 8);
    assert_eq!(std::mem::offset_of!(AttrList, fork), 20);
    let mut valid = [0_u8; 72];
    for (offset, word) in [
        (0, 72_u32),
        (4, 0x8000_0000),
        (8, 0x0006_0000),
        (24, 1),
        (40, 0x21),
    ] {
        valid[offset..offset + 4].copy_from_slice(&word.to_le_bytes());
    }
    valid[56..72].copy_from_slice(&[1; 16]);
    assert_eq!(volume_attributes(&valid).unwrap(), [1; 16]);
    for (offset, word) in [
        (0, 40_u32),
        (4, 0),
        (8, 0x0004_0000),
        (24, 0),
        (40, 0),
        (40, 1),
        (24, 0x21),
    ] {
        let mut invalid = valid;
        invalid[offset..offset + 4].copy_from_slice(&word.to_le_bytes());
        assert_eq!(
            volume_attributes(&invalid).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }
    valid[56..72].fill(0);
    assert!(volume_attributes(&valid).is_err());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "metadata-only check of an explicitly prepared local disposable fixture"]
fn macos_read_only_identity_probe() {
    use std::{io::Read, path::PathBuf};
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Snapshot {
        version: u8,
        root: MountedObject,
        file: MountedObject,
        root_id: String,
        document_id: String,
    }
    let path = PathBuf::from(
        std::env::var_os("MOGLEDGE_STORAGE_PROBE_ROOT")
            .expect("supply only a fresh local Mogledge-Storage-Identity-QA- fixture"),
    );
    assert!(path.is_absolute());
    let name = path.file_name().unwrap().to_str().unwrap();
    assert!(name
        .strip_prefix("Mogledge-Storage-Identity-QA-")
        .is_some_and(|suffix| !suffix.is_empty()));
    let (root_path, dir) = super::open_root(&path).unwrap();
    let reference = super::RootReferenceGuard::open(&root_path, &dir).unwrap();
    let root_file = dir.try_clone().unwrap().into_std_file();
    // Open only the fixed synthetic file without following links. Its contents
    // are never read, and the probe performs no profile/database access.
    let file = crate::write_fs::open_at(&dir, "identity-probe.txt", false, false, false).unwrap();
    let root_object = opened_object(&root_file).unwrap();
    let file_object = opened_object(&file).unwrap();
    let snapshot = Snapshot {
        version: 1,
        root: root_object,
        file: file_object,
        root_id: root(root_object).unwrap(),
        document_id: document(root_object, file_object).unwrap(),
    };
    reference.revalidate(&root_path, &dir).unwrap();
    if std::env::var_os("MOGLEDGE_STORAGE_PROBE_COMPARE").is_some() {
        assert_eq!(
            std::env::var("MOGLEDGE_STORAGE_PROBE_COMPARE").unwrap(),
            "1"
        );
        let baseline =
            crate::write_fs::open_at(&dir, "identity-before.json", false, false, false).unwrap();
        assert!(baseline.metadata().unwrap().len() <= 4096);
        let mut bytes = Vec::new();
        baseline.take(4097).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 4096);
        let before: Snapshot = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(before.version, 1);
        // Recompute the saved candidate too: arbitrary saved digests must not
        // be mistaken for evidence of the requested metadata comparison.
        assert_eq!(before.root_id, root(before.root).unwrap());
        assert_eq!(
            before.document_id,
            document(before.root, before.file).unwrap()
        );
        assert_eq!(before.root_id, snapshot.root_id);
        assert_eq!(before.document_id, snapshot.document_id);
        println!(
            "MOGLEDGE_STORAGE_DEVICE_CHANGED root={} file={}",
            before.root.device != snapshot.root.device,
            before.file.device != snapshot.file.device
        );
    }
    println!(
        "MOGLEDGE_STORAGE_IDENTITY_SNAPSHOT={}",
        serde_json::to_string(&snapshot).unwrap()
    );
}

#[cfg(test)]
fn fixture() -> (MountedObject, MountedObject) {
    (
        MountedObject {
            volume_uuid: [1; 16],
            device: 17,
            file_id: 100,
            created_ns: 1_700_000_000_000_000_000,
        },
        MountedObject {
            volume_uuid: [1; 16],
            device: 17,
            file_id: 101,
            created_ns: 1_700_000_001_000_000_000,
        },
    )
}

#[cfg(test)]
pub(crate) fn legacy_document(root: MountedObject, file: MountedObject) -> String {
    super::legacy_identity_hash(
        b"my-knowledge-document-state-v1",
        &[
            (root.device, root.file_id, root.created_ns),
            (file.device, file.file_id, file.created_ns),
        ],
    )
}

#[test]
fn reboot_device_change_breaks_v1_but_preserves_candidate_root_and_document() {
    let (before_root, before_file) = fixture();
    let mut after_root = before_root;
    let mut after_file = before_file;
    after_root.device = 42;
    after_file.device = 42;
    assert_ne!(
        legacy_document(before_root, before_file),
        legacy_document(after_root, after_file)
    );
    assert_eq!(root(before_root).unwrap(), root(after_root).unwrap());
    assert_eq!(
        document(before_root, before_file).unwrap(),
        document(after_root, after_file).unwrap()
    );
    assert_ne!(
        root(before_root).unwrap(),
        document(before_root, before_file).unwrap()
    );
}

#[test]
fn v1_hash_encoding_keeps_the_existing_domain_width_order_and_endianness() {
    let root = MountedObject {
        volume_uuid: [1; 16],
        device: 17,
        file_id: 100,
        created_ns: 1000,
    };
    let file = MountedObject {
        file_id: 101,
        ..root
    };
    // Fixed vector assembled independently as domain + 8/16/16 little-endian
    // bytes for root followed by file, using the pre-change v1 wire format.
    assert_eq!(
        legacy_document(root, file),
        "d32e8ccb56d33762b6589e3fafc9004686a5c5f4f550f174e712837e34fcb2bf"
    );
}

#[test]
fn separate_volumes_and_reused_file_or_root_ids_cannot_inherit_candidate_state() {
    let (original_root, original_file) = fixture();
    let original = document(original_root, original_file).unwrap();
    for changed_file in [
        MountedObject {
            volume_uuid: [2; 16],
            ..original_file
        },
        MountedObject {
            file_id: 102,
            ..original_file
        },
        MountedObject {
            created_ns: original_file.created_ns + 1,
            ..original_file
        },
    ] {
        assert_ne!(original, document(original_root, changed_file).unwrap());
    }
    for changed_root in [
        MountedObject {
            volume_uuid: [2; 16],
            ..original_root
        },
        MountedObject {
            file_id: 102,
            ..original_root
        },
        MountedObject {
            created_ns: original_root.created_ns + 1,
            ..original_root
        },
    ] {
        assert_ne!(root(original_root).unwrap(), root(changed_root).unwrap());
        assert_ne!(original, document(changed_root, original_file).unwrap());
    }
    // UUID cannot be retroactively inferred from a legacy hashed ID. Equal
    // old device/inode/birth time on a different cloned volume is ambiguous.
    let clone = MountedObject {
        volume_uuid: [2; 16],
        ..original_file
    };
    let clone_root = MountedObject {
        volume_uuid: [2; 16],
        ..original_root
    };
    assert_eq!(
        legacy_document(original_root, original_file),
        legacy_document(clone_root, clone)
    );
    assert_ne!(original, document(clone_root, clone).unwrap());
}

#[test]
fn missing_volume_uuid_or_object_metadata_refuses_without_device_fallback() {
    let (original_root, original_file) = fixture();
    let unknown = MountedObject {
        volume_uuid: [0; 16],
        ..original_root
    };
    for unknown in [
        unknown,
        MountedObject {
            file_id: 0,
            ..original_root
        },
        MountedObject {
            created_ns: 0,
            ..original_root
        },
    ] {
        assert_eq!(
            root(unknown).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
        assert!(document(unknown, original_file).is_err());
        assert!(document(original_root, unknown).is_err());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_native_candidate_probe_uses_only_disposable_files_and_handles() {
    use cap_std::ambient_authority;
    let fixture = tempfile::tempdir().unwrap();
    let root_path = fixture.path().join("root");
    std::fs::create_dir(&root_path).unwrap();
    std::fs::write(root_path.join("before.html"), "<input>").unwrap();
    let dir = cap_std::fs::Dir::open_ambient_dir(&root_path, ambient_authority()).unwrap();
    let root_file = dir.try_clone().unwrap().into_std_file();
    let file = dir.open("before.html").unwrap().into_std();
    let root_before = opened_object(&root_file).unwrap();
    let file_before = opened_object(&file).unwrap();
    assert_eq!(root_before.volume_uuid, file_before.volume_uuid);
    let expected = document(root_before, file_before).unwrap();
    std::fs::rename(root_path.join("before.html"), root_path.join("after.html")).unwrap();
    let reopened = dir.open("after.html").unwrap().into_std();
    assert_eq!(
        expected,
        document(
            opened_object(&root_file).unwrap(),
            opened_object(&reopened).unwrap()
        )
        .unwrap()
    );
    std::fs::rename(&root_path, fixture.path().join("renamed-root")).unwrap();
    assert_eq!(
        expected,
        document(
            opened_object(&root_file).unwrap(),
            opened_object(&reopened).unwrap()
        )
        .unwrap()
    );
}
