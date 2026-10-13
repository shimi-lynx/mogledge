# Windows installer template

`installer.nsi` derives from the official [Tauri `tauri-v2.12.1` NSIS template](https://github.com/tauri-apps/tauri/blob/tauri-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi). The unmodified source has SHA-256 `dabed59013b1d78b879a1a85bc7f2eed2993b33a9a90cdabe5946de3d3950597`. Tauri distributes it under MIT or Apache-2.0; this copy uses the included [MIT license](LICENSE-MIT).

The display name follows `productName`, while `INSTALLIDENTITY` remains `My Knowledge` for the existing Uninstall/product registry keys, installer language, install directories, and autostart value. `mainBinaryName` remains `my-knowledge`; the bundle identifier remains `com.shimilynx.myknowledge`.

Owned legacy shortcuts are renamed only when their target is the installed main executable. A conflicting new-name shortcut is preserved. The uninstall path also removes owned legacy shortcuts and the matching legacy Run value, while retaining the upstream `/UPDATE` behavior. A normal uninstall-before-install can remove autostart through the old uninstaller, as in upstream; use overwrite installation or `/UPDATE` to preserve it.

Keep the upstream template changes limited to these compatibility requirements. Reconcile this file with the official template whenever the Tauri CLI/bundler version changes. Native compilation, NSIS compilation, and Windows install/upgrade/uninstall checks have not been performed. Verify existing/custom install paths, normal and `/UPDATE` flows, shortcut collisions, and autostart enabled/disabled states before release.
