# Cloud-file support and QA

Windows read operations distinguish supported Cloud Files reparse tags from ordinary symlinks/junctions. The supported first scope is locally retained OneDrive HTML/assets. Read guards reject files and directories observed as requiring recall or partial population. Metadata checks and no-recall flags do not establish zero provider communication.

Keep needed files/assets locally using the provider's own controls, then refresh. Root/file identity, attributes, no-recall policy and bounded reads still apply. Unsupported reparse tags, symlinks and junctions remain rejected. Windows permits limited nested-folder creation, HTML rename and HTML/empty-folder moves while all affected ancestors/items remain locally represented. Nonempty-folder moves, anchored drops, reorder and trash remain rejected.

## Disposable QA

Use an explicitly disposable fixture marked for cloud testing; `tests/e2e/wdio.conf.ts` requires that marker. Never use a real user's synchronized root as a mutation fixture.

Record provider/version, local-retention state, file/root attributes, operation, expected/actual outcome and whether any recall/population occurred. Check locally retained reads, offline/partial files, unavailable enumeration, identity replacement, nested unsupported links and denied cloud mutations. Do not infer provider safety from an ordinary local synthetic test.

Broader Cloud writes need their own design and small Native provider evidence before enablement. Directory enumeration and namespace rename may trigger provider communication, placeholder population, synchronization or waits. No-recall flags alone do not prove zero callbacks or synchronization/population effects, and held directory handles do not freeze concurrent child creation. Unknown outcomes preserve files, confirmed tree/preferences/database and stop automatic cleanup/retry/open; affected old document grants are revoked. Verified moves persist references/order only in an ordinary local profile. Sidecar failure preserves the committed move and reports partial success without rollback.

The [0.7.2 write reassessment](onedrive-write-probe.md) records disposable Native access/share experiments, provider conversion and the limited production writer. Opt-in Native tests touch only newly owned synthetic leaves inside an approved GUID fixture and a temporary ordinary profile; they verify FileID continuity, preserved existing synthetic content, scoped sidecar publication and restart. Callback instrumentation, offline/partial transitions, Windows directory-flush durability and full Native GUI acceptance remain incomplete.

See [security](security.md), [testing](testing.md#native-qa) and [known limitations](known-limitations.md). Current source support does not establish verification with every real provider or macOS cloud filesystem.
