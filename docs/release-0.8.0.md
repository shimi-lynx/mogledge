# Mogledge 0.8.0 source integration

Version 0.8.0 adds the manually operated in-app updater, the fixed-location build/update guide and source-to-notice evidence. The 0.x policy uses a minor increment for a new feature, so product manifests, lockfile root entries, Tauri version and the current Windows verification filename align at 0.8.0. Historical dependency/material ledgers retain their original versions and source scope.

The update UI follows manual check → version/plain-text notes → download/verification → saved-input acknowledgement → explicit restart/apply. Main-only Native commands preserve the HTML boundary. Default/self builds and current app-only candidates remain disabled. The identifier, storage paths and installation identity are unchanged. Read the [updater guide](in-app-updates.md) and [material delta](in-app-update-licenses.md) before planning an enrolled distribution.

Unmerged storage corrections and pending updater configuration are excluded. Existing storage behavior is retained. The [Mac notice map](mac-mit-notice-map.md) is provenance evidence, not complete copyright/SDK clearance; collector review blocks remain.

## Existing integration evidence

The original integration record reports successful formatter/type/lint checks, 11 mocked updater/i18n unit tests, six Chromium updater/settings cases, seven Rust updater-model tests, both Rust fmt checks, and 22 distribution/permission tests with one Windows-only probe skipped. All 135 retained legal-material hashes matched. Earlier source-scoped Windows compilation and strict Clippy apply to the unchanged implementation. These are inherited records, not newly executed checks during repository preparation.

Source integration and owner-reported ordinary app operation do not establish an actual signed updater download, installation/relaunch or downloaded-candidate QA. Mac updater compilation, production feed/public key, signed artifacts, actual payload/SDK review and isolated update/data-preservation checks remain pending. See [source preparation](source-preparation.md) for this repository's baseline and separate audit evidence.
