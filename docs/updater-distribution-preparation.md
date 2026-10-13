# Signed update distribution preparation

The current source is 0.8.0. An optional `src-tauri/tauri.updater.pending.json` records the supplied public key and future HTTPS Releases feed. It is not selected by the default configuration, scripts or workflows. It deliberately sets `bundle.createUpdaterArtifacts: false`: even a release build with `distribution-updater` cannot enroll using this overlay. Ordinary source builds and app-only Windows EXEs remain disabled.

The repository is currently private. The intended endpoint `https://github.com/shimi-lynx/mogledge/releases/latest/download/latest.json` is a future asset location, not a claim that a manifest or signed artifact exists. Private GitHub Releases are not an anonymous update feed. Do not embed tokens, account headers or secrets in an app to make this URL work. Activation needs separately approved, anonymously accessible HTTPS hosting and actual artifact verification.

## Public key identity

The overlay contains only the owner-supplied public key. Strict outer base64 decoding produces a two-line minisign public-key document. Its inner base64 record is 42 bytes: `Ed`, an eight-byte little-endian key ID and 32 Ed25519 public bytes.

- Key ID: `834723B673FE6C1E`, matching the document comment.
- SHA-256 of the 32 public bytes: `65b10a703ca58b486328274e88c5999fee34e16c15356d64aa3b19e54dd49a55`.

These are identity/structure checks, not proof of private-key possession or successful artifact verification. Private-key custody, signing and backup remain in the owner's approved environment; no private key/password belongs in this repository, documentation or messages.

## Artifacts and manifest

For a later approved build, use a reviewed active overlay with `createUpdaterArtifacts: true`, this validated public key, accessible HTTPS endpoints and `requireSignedVersion: true`. Preserve production identifier `com.shimilynx.myknowledge`, the existing profile, NSIS install identity/template and confirmed installed path. The pending overlay is not a production build recipe. Review activation as a separate change; never turn it on merely to complete static checks.

The current supported Windows channel needs NSIS `*-setup.exe` and its generated `.sig`. A `--no-bundle` EXE or candidate ZIP cannot replace it. macOS requires the `.app.tar.gz` updater archive and `.sig`, not a DMG or application ZIP. Only list platforms for which real reviewed artifacts exist. Updater signing and signed-version validation are separate from Authenticode or Developer ID/notarization and from complete license/NOTICE/SDK/native-payload review.

The [official manifest format](https://v2.tauri.app/plugin/updater/#static-json-file) requires a SemVer `version` and `platforms` entries containing the real URL and **contents** of the corresponding `.sig`. Optional notes are plain text; optional `pub_date` is RFC 3339. A signature filename/URL is not a signature. Tauri CLI 2.12.1 `tauri build` binds the generated signature to the build version; manual signing must include `--app-version` with that exact version. Verify the signed version, manifest version and embedded product version agree. Signed-version checks must remain mandatory.

For an already built and signed, separately authorized Windows artifact, create an untracked local manifest as follows. Set `$artifactPath`, `$artifactUrl` and `$releaseVersion` from the verified artifact record first. Use a real HTTPS URL for eventual production; the exact approved loopback URL belongs only to isolated QA. Do not publish this output as part of configuration preparation.

```powershell
$signature = (Get-Content -LiteralPath ($artifactPath + '.sig') -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) { throw 'Missing updater signature' }
$manifest = @{
  version = $releaseVersion
  notes = 'Reviewed update notes'
  platforms = @{
    'windows-x86_64' = @{ url = $artifactUrl; signature = $signature }
  }
}
$json = $manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText((Join-Path $serveRoot 'latest.json'), $json, [Text.UTF8Encoding]::new($false))
```

Set `$serveRoot` to a dedicated fixture-only directory. Serve exactly the retained signed bytes without repacking or modifying them. Record source/config hashes, version, target, executable/installer/archive SHA-256, signature file and platform entry. Independently verify URLs, download hashes, signature rejection and installed/relaunched version before claiming an update works. Publishing assets first and a validated manifest last belongs to a later approved release procedure.

## Remaining stages and verification

1. Review this inactive preparation and [Windows QA handoff](windows-updater-qa.md). It does not activate a service or install anything.
2. Complete the separately authorized isolated, signed Windows update QA. Keep its identifier/profile/template/HTTP exception out of production.
3. Integrate the separately reviewed next product fix with one coordinated release version; this inactive configuration/documentation does not bump 0.8.0.
4. Check the final intended binaries, source correspondence, legal material, OS signatures/trust behavior, updater signatures and anonymously accessible HTTPS feed before requesting release/publication approval.

Actions remain stopped. No Release/public visibility, Secrets/permission changes or production update is part of this preparation. Track rollout in [issue #1](https://github.com/shimi-lynx/mogledge/issues/1). Manifest JSON receipt/allocation is a separate hardening candidate in [issue #2](https://github.com/shimi-lynx/mogledge/issues/2): the plugin parses a response before the app can truncate notes, and the 256 MiB artifact policy does not bound that JSON. No reproduced vulnerability or product fix is claimed here.

Static validation covers strict public-key decoding/fingerprint, disabled enrollment/defaults, the recursively merged overlay against the installed Tauri configuration schema, and the existing main-only permission boundary. It does not validate the service, cryptographic signature of a real artifact, installer behavior or Native relaunch/data preservation.

Preparation checks passed on Linux with Node 24.19.0: `node --test scripts/distribution/updater-config.test.mjs tests/storage/updater-permissions.test.mjs` (3 tests), `npm run check`, installed Tauri CLI 2.12.1 schema validation of default and recursively merged pending configurations, independent Python key decoding/fingerprint, local links and diff checks. Product code, active configuration, dependencies and workflows remain unchanged; no Native/signing/installer or feed request is part of these checks.
