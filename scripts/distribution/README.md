# Distribution path privacy

The distribution builder remaps compiler-generated source paths before compiling
and checks final executable bytes before packaging. This prevents a successful
identity/version check from accepting an executable that still contains local
build directories. License/material review and Native download/update QA remain
separate requirements; neither workflow approval gate changes.

## Windows application only

For a local Windows x64 check from a clean committed source, reuse an existing
native cache if available and run:

```powershell
$env:CARGO_TARGET_DIR = '<existing-native-cache>'
node scripts/distribution/build.mjs windows-x64 --app-only
```

Use the repository's Node prerequisites and pinned Rust toolchain. This command
builds the ordinary application with `--no-bundle -- --locked --jobs 1`, without
launching it, generating an installer, collecting/uploading a distribution ZIP or
replacing an installed app. Its default native target retains the existing cache
layout; custom Cargo build-target configuration is outside this entrypoint's scope.
For an authorized build-and-update request, continue with the
[fixed-location update workflow](../../docs/update-guide.md#ai-build-and-update-workflow)
after artifact verification; build success alone does not complete that update.
Unset `CARGO_BUILD_TARGET` and use the native default target. Omit `CARGO_TARGET_DIR`
to use `src-tauri/target`; supplied relative cache paths are resolved from the
repository and passed to Cargo as absolute paths. The private verification
manifest is written under `.tools/distribution-app-only`; its directory must not
already exist. Preserve prior results rather than removing them blindly.

Unset `TAURI_CONFIG`, `RUSTFLAGS` and `CARGO_ENCODED_RUSTFLAGS` before using the
builder. It rejects these external overrides instead of silently replacing
them. The normal three-platform candidate entrypoint still requires its pinned
Node version and the separately approved manual workflow conditions.

## Source paths and debugging

The builder derives prefixes at execution time; no local prefix is committed or
written to a candidate manifest. Cargo receives arguments through
`CARGO_ENCODED_RUSTFLAGS`, preserving spaces and equals signs in directory names.
Both separator spellings are supplied on Windows. Broad roots precede more
specific roots because rustc applies the last matching textual prefix.

| Source root              | Recorded compiler prefix |
| ------------------------ | ------------------------ |
| User home                | `/build/home`            |
| Temporary directory      | `/build/tmp`             |
| Cargo home               | `/cargo`                 |
| Installed Rust toolchain | `/rust-toolchain`        |
| Repository               | `/mogledge`              |
| Cargo target directory   | `/build/target`          |

All rustc remapping scopes are used, including `file!()`/panic paths, diagnostics,
debug information and metadata on a best-effort basis. Function symbols and line
numbers remain available; their source prefixes are the generic locations above.
Debuggers may need source-prefix mappings back to the matching private checkout.
Changing flags or source/cache prefixes changes Cargo fingerprints, so the first
mapped build may recompile dependencies. Existing caches and binaries are retained;
do not clean them to enable this change.

Windows also uses `/PDBALTPATH:%_PDB%`, so the executable records a PDB basename.
The actual PDB can still contain linker paths/arguments and remains private.
Native compilers, generated string literals and platform linkers are not fully
controlled by rustc's remapping. The final UTF-8/UTF-16 byte check therefore fails
on retained known build roots or personal-directory prefixes, with values redacted.
It is a scoped path check, not an exhaustive secret scan or a proof of identical
binary hashes across machines/toolchains.

See [rustc's remapping limits](https://doc.rust-lang.org/rustc/remap-source-paths.html)
and [Microsoft's PDB path option](https://learn.microsoft.com/en-us/cpp/build/reference/pdbaltpath-use-alternate-pdb-path).
Mac linker-generated OSO paths may need additional target-specific treatment;
Mac Native verification is not established by the Windows probe.

## Candidate contents

Before packaging and after extraction, the candidate root must contain only the
app, `manifest.json`, `LICENSE`, `BINARY-DISTRIBUTION.md`, `source.zip` and
`third-party/`. Launchers, caches and private audit outputs are not copied there.
Nested PDB/dSYM files, logs, private dotenv files and symlinks are rejected rather
than silently removed from legal/source material. The source archive is an exact
`git archive` of the committed source; tracked local instructions/private
configuration and build-output paths fail its entry check. Public build scripts
and `.env.example` remain valid source files. License bytes, source checksums,
application identity and asset bytes are not rewritten by path remapping.

## Targeted verification

```powershell
$env:MOGLEDGE_PATH_REMAP_NATIVE_PROBE = '1'
node --test scripts/distribution/distribution.test.mjs
```

The opt-in Windows probe compiles an owned small Rust library and console fixture,
including a leaking control and a remapped build with debug information. It checks
final-byte rejection, mapped `file!()` values and retained panic symbols/lines.
It does not launch Mogledge or access its profile. Final ordinary release and
archive validation must still run for the intended integrated source before a
candidate can be considered complete.
