use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, io::Read, process};

// Match the CLI's exact version token. Reject ambiguity instead of accepting a
// second version or semver spelling that was not selected in the trusted record.
fn version_matches(comment: &str, expected: &str) -> bool {
    let versions: Vec<_> = comment
        .split('\t')
        .filter_map(|field| field.strip_prefix("version:"))
        .collect();
    versions == [expected]
}

fn signature_check(
    data: &[u8],
    encoded_signature: &str,
    encoded_key: &str,
) -> Result<Signature, ()> {
    let key_text =
        String::from_utf8(STANDARD.decode(encoded_key).map_err(|_| ())?).map_err(|_| ())?;
    let signature_text =
        String::from_utf8(STANDARD.decode(encoded_signature).map_err(|_| ())?).map_err(|_| ())?;
    let key = PublicKey::decode(&key_text).map_err(|_| ())?;
    let signature = Signature::decode(&signature_text).map_err(|_| ())?;
    // Includes minisign's global signature over the trusted comment. Never use
    // that comment to authorize a version before this cryptographic check.
    key.verify(data, &signature, true).map_err(|_| ())?;
    Ok(signature)
}

fn run() -> Result<(), ()> {
    let args: Vec<_> = env::args().collect();
    if args.len() != 5 {
        return Err(());
    }
    let mut data = Vec::new();
    fs::File::open(&args[1])
        .map_err(|_| ())?
        .take(256 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| ())?;
    if data.len() > 256 * 1024 * 1024 {
        return Err(());
    }
    let mut signature_file = Vec::new();
    fs::File::open(&args[2])
        .map_err(|_| ())?
        .take(64 * 1024 + 1)
        .read_to_end(&mut signature_file)
        .map_err(|_| ())?;
    if signature_file.len() > 64 * 1024 {
        return Err(());
    }
    let encoded = std::str::from_utf8(&signature_file).map_err(|_| ())?;
    let signature = signature_check(&data, encoded, &args[3])?;
    if !version_matches(signature.trusted_comment(), &args[4]) {
        return Err(());
    }
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("Signature or signed-version verification failed");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public verification vector from minisign-verify 0.3.0's Basic Usage.
    // No signing key is used, generated or retained by these tests.
    const KEY: &str =
        "untrusted comment: fixture\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";

    #[test]
    fn verifies_public_vector_and_rejects_changed_bytes() {
        let key = STANDARD.encode(KEY);
        let signature = STANDARD.encode(SIGNATURE);
        let verified = signature_check(b"test", &signature, &key).unwrap();
        assert!(!version_matches(verified.trusted_comment(), "0.8.1"));
        assert!(signature_check(b"tesT", &signature, &key).is_err());
        assert!(signature_check(
            b"test",
            &STANDARD.encode(SIGNATURE.replace("file:test", "file:evil")),
            &key
        )
        .is_err());
        assert!(signature_check(b"test", &signature, "invalid-base64").is_err());
        assert!(signature_check(b"test", "invalid-base64", &key).is_err());
        assert!(signature_check(
            b"test",
            &signature,
            &STANDARD.encode(KEY.replace("RWQf6", "RWQe6"))
        )
        .is_err());
    }

    #[test]
    fn requires_one_exact_signed_version() {
        assert!(version_matches(
            "timestamp:1\tfile:app\tversion:0.8.1",
            "0.8.1"
        ));
        for comment in [
            "timestamp:1",
            "file:app-version:0.8.1",
            "version:0.8.0",
            "version:v0.8.1",
            "version:0.8.1\tversion:0.8.1",
            "version:0.8.1\n",
        ] {
            assert!(!version_matches(comment, "0.8.1"));
        }
    }
}
