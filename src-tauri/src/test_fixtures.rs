//! Unix fixtures shared by application unit tests and the backend test harness.

use std::{io, path::Path};

/// Creates a FIFO at an absolute, disposable fixture path without replacing an entry.
pub fn create_fifo(path: &Path, permissions: u16) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "FIFO fixtures require an absolute path",
        ));
    }
    create_fifo_platform(path, permissions)
}

#[cfg(target_os = "macos")]
fn create_fifo_platform(path: &Path, permissions: u16) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    // Pinned rustix excludes Apple's *at FIFO APIs. Darwin's longstanding mkfifo
    // supports the macOS 12 baseline; its mode_t ABI is an unsigned 16-bit value.
    unsafe extern "C" {
        fn mkfifo(path: *const std::ffi::c_char, mode: u16) -> std::ffi::c_int;
    }
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    // SAFETY: the CString remains alive and NUL-terminated throughout the call;
    // the signature matches Darwin mkfifo and no FIFO handle is opened.
    if unsafe { mkfifo(path.as_ptr(), permissions) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn create_fifo_platform(path: &Path, permissions: u16) -> io::Result<()> {
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        path,
        rustix::fs::Mode::from_bits_truncate(permissions.into()),
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{ffi::OsStringExt, fs::FileTypeExt};

    #[test]
    fn fifo_creation_preserves_existing_entries_and_reports_invalid_paths() {
        let fixture = tempfile::tempdir().unwrap();
        let fifo = fixture.path().join("pipe");
        create_fifo(&fifo, 0o600).unwrap();
        assert!(std::fs::symlink_metadata(&fifo)
            .unwrap()
            .file_type()
            .is_fifo());
        assert_eq!(
            create_fifo(&fifo, 0o600).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );

        let regular = fixture.path().join("sentinel");
        std::fs::write(&regular, b"unchanged").unwrap();
        assert_eq!(
            create_fifo(&regular, 0o400).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(&regular).unwrap(), b"unchanged");
        assert_eq!(
            create_fifo(Path::new("relative"), 0o600)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let nul = fixture
            .path()
            .join(std::ffi::OsString::from_vec(b"invalid\0leaf".to_vec()));
        assert_eq!(
            create_fifo(&nul, 0o600).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        // Linux permits arbitrary filename bytes; APFS requires valid UTF-8.
        #[cfg(target_os = "linux")]
        {
            let non_utf8 = fixture
                .path()
                .join(std::ffi::OsString::from_vec(b"pipe-\xff".to_vec()));
            create_fifo(&non_utf8, 0o400).unwrap();
            assert!(std::fs::symlink_metadata(&non_utf8)
                .unwrap()
                .file_type()
                .is_fifo());
        }
    }
}
