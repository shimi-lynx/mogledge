# OneDrive Native write probe

Windows supports retained reads and a limited writer for new HTML, nested folders, HTML rename and HTML/empty-folder moves. Every affected ancestor/item must have a supported local representation. Offline/partial items and unsupported links are rejected. Nonempty-folder moves, anchored drops, reorder and trash remain restricted.

Directory enumeration and namespace rename may trigger provider communication, population, synchronization or waits. No-recall flags and held handles do not establish zero provider activity. An unknown outcome preserves files and confirmed tree/preferences/database state, revokes affected old grants and stops automatic retry, cleanup or opening. Refresh before another attempt. A sidecar-publication failure preserves the committed move and reports partial success.

## Disposable probe

The opt-in probe is `scripts/probe-onedrive-writes.ps1`. Read its parameters and ownership checks before use. It and the opt-in backend tests operate only on newly owned synthetic leaves inside an approved disposable fixture. Never supply a real synchronized knowledge root or ordinary app profile. A source migration does not authorize running this mutation probe.

Record provider/version, retention state, file/root attributes, operation, expected/actual result and observed recall/population. Verify FileID continuity, existing synthetic content, scoped sidecar publication and restart where relevant. Keep raw paths/provider logs private. Callback instrumentation, offline/partial transitions, directory-flush durability and full Native GUI acceptance remain incomplete.

See the [Cloud-file QA contract](onedrive-qa.md), [security](security.md) and [known limitations](known-limitations.md).
