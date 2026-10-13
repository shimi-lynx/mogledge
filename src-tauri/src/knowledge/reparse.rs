//! Pure Windows reparse/availability policy, also tested on other platforms.

pub(super) const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x40000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
const IO_REPARSE_TAG_CLOUD: u32 = 0x9000001a;
const IO_REPARSE_TAG_CLOUD_MASK: u32 = 0x0000f000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReparseKind {
    Ordinary,
    Cloud,
    Unsupported,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct PathInfo {
    attributes: u32,
    kind: ReparseKind,
    from_enumeration: bool,
}

impl PathInfo {
    pub(super) fn from_attributes(attributes: u32, tag: u32) -> Self {
        let kind = if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            ReparseKind::Ordinary
        } else if tag & !IO_REPARSE_TAG_CLOUD_MASK == IO_REPARSE_TAG_CLOUD {
            // Only CLOUD and the documented CLOUD_1 .. CLOUD_F family.
            // Name-surrogate tags and unknown reparse tags remain prohibited.
            ReparseKind::Cloud
        } else {
            ReparseKind::Unsupported
        };
        Self {
            attributes,
            kind,
            from_enumeration: false,
        }
    }

    pub(super) fn from_enumeration(attributes: u32, tag: u32) -> Self {
        Self {
            from_enumeration: true,
            ..Self::from_attributes(attributes, tag)
        }
    }

    pub(super) fn allowed(self) -> bool {
        self.kind != ReparseKind::Unsupported
    }

    pub(super) fn is_ordinary(self) -> bool {
        self.kind == ReparseKind::Ordinary && !self.requires_download()
    }

    #[cfg(windows)]
    pub(super) fn is_cloud(self) -> bool {
        self.kind == ReparseKind::Cloud
    }

    pub(super) fn is_dir(self) -> bool {
        self.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
    }

    pub(super) fn requires_download(self) -> bool {
        requires_recall(self.attributes, self.from_enumeration)
    }
}

fn requires_recall(attributes: u32, from_enumeration: bool) -> bool {
    attributes & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) != 0
        // RECALL_ON_OPEN aliases EA in handle metadata and is meaningful only
        // in directory enumeration classes. Do not reject local EA files.
        || (from_enumeration && attributes & FILE_ATTRIBUTE_RECALL_ON_OPEN != 0)
}

pub(super) fn is_device_name(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) {
        return true;
    }
    let suffix = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"));
    suffix.is_some_and(|suffix| {
        matches!(
            suffix,
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_documented_cloud_family_is_allowed() {
        for variant in 0..=15 {
            let info = PathInfo::from_attributes(
                FILE_ATTRIBUTE_REPARSE_POINT,
                IO_REPARSE_TAG_CLOUD | (variant << 12),
            );
            assert_eq!(info.kind, ReparseKind::Cloud);
            assert!(info.allowed());
            assert!(!info.is_ordinary());
        }
        for tag in [
            0xa000000c, // symlink
            0xa0000003, // junction/mount point
            0xa000001d, // Linux symlink
            0x80000021, // legacy OneDrive tag, not CLOUD
            0x9000001c, // ProjFS
            0x9001001a, // CLOUD-like low value outside the documented mask
            0xb000001a, // CLOUD-like name-surrogate value
            0,
        ] {
            assert!(!PathInfo::from_attributes(FILE_ATTRIBUTE_REPARSE_POINT, tag).allowed());
        }
        assert!(PathInfo::from_attributes(0x80, 0).allowed());
        assert!(PathInfo::from_attributes(0x80, 0).is_ordinary());
    }

    #[test]
    fn availability_is_separate_from_link_policy() {
        for attribute in [FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS] {
            for directory in [0, FILE_ATTRIBUTE_DIRECTORY] {
                let info = PathInfo::from_attributes(
                    FILE_ATTRIBUTE_REPARSE_POINT | directory | attribute,
                    0x9000e01a,
                );
                assert!(info.allowed());
                assert!(info.requires_download());
                assert_eq!(info.is_dir(), directory != 0);
            }
        }
        for attributes in [0x80, FILE_ATTRIBUTE_DIRECTORY, 0x40000, 0x80000, 0x100000] {
            assert!(!PathInfo::from_attributes(attributes, 0).requires_download());
        }
        assert!(requires_recall(FILE_ATTRIBUTE_RECALL_ON_OPEN, true));
        assert!(!requires_recall(FILE_ATTRIBUTE_RECALL_ON_OPEN, false));
        assert!(PathInfo::from_enumeration(FILE_ATTRIBUTE_RECALL_ON_OPEN, 0).requires_download());
    }

    #[test]
    fn dos_device_aliases_are_rejected() {
        for name in [
            "CON",
            "con.html",
            "AUX",
            "NUL.txt",
            "PRN",
            "COM1",
            "COM9.css",
            "LPT0",
            "LPT³.html",
            "com¹.txt",
            "CONIN$",
            "CONOUT$",
        ] {
            assert!(is_device_name(name), "{name}");
        }
        for name in ["console.html", "COM10.html", "LPTnotes", "日本語.HTML"] {
            assert!(!is_device_name(name), "{name}");
        }
    }
}
