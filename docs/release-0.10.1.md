# Mogledge 0.10.1

This patch combines three fixes with the dedicated-folder and local AI authoring guidance merged in #67. The product version advances once from 0.10.0 to 0.10.1; the identifier, executable names and existing profile remain unchanged. Candidate, signing and publication evidence will be recorded against their actual source commits. This preparation record does not establish a completed build, publication or installed-app update.

- The two remaining folder-creation buttons fill the sidebar action row in English and Japanese, including narrow sidebars.
- Mac document find shows current/total counts, all-match and current-match highlights, zero results, bounded partial-result feedback and visibility refresh after resizing. See the [user guide](user-guide.md).
- Opening HTML and constructing an adapter do not display document-ID guidance. A Native storage operation makes existing identity-hold reasons and explicit remedies visible. Native identity checks, rejected-operation errors, restoration gating and saved-data protection remain intact. See [document storage](document-storage.md).

## Verification scope

Targeted regressions cover the folder row geometry and labels, document-find counts/highlights/navigation/cleanup/bounds/resize, and storage-adapter signaling plus authenticated iframe message handling. Independent source reviews found no remaining blockers after the find scan and resize followups. The broader tree-actions fixture fails at its missing-root label on both baseline and changed code; this pre-existing fixture failure is not reported as passed.

Browser and mock results do not establish physical Mac Cmd+F, IME, accessibility or WKWebView behavior. Existing-device updater UI, login launch and OS permissions remain distinct from candidate metadata, signatures and bounded synthetic installed-update checks. These device followups remain tracked in #48, #55, #60 and #66. No ordinary user app, settings, HTML or saved input is replaced during release preparation.

For users transitioning from the older My Knowledge identity, preserve the [0.10.0 identity and login-startup precautions](release-0.10.0.md). Windows binaries are not Authenticode-signed. Mac binaries use ad-hoc signing without Developer ID or notarization; updater cryptographic signatures are a separate verification layer.
