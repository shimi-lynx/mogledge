# macOS resident shortcuts

## Existing routes and permissions

Tray/menu-bar residency is explicit and requests no Input Monitoring or Accessibility permission. Closing hides the window only when residency and the tray permit it.

Standard Shift → Cmd → Shift recall uses a passive, listen-only CoreGraphics session tap and requires Input Monitoring. Missing permission is reported separately from tap-creation failure. With residency enabled, the existing recall settings provide **Open Input Monitoring settings** and a return/recheck control. If opening settings fails, use System Settings → Privacy & Security → Input Monitoring (Security & Privacy on older macOS), then return and recheck. The owner decides whether to grant access. Do not reset privacy settings or broaden permissions to bypass a failure.

Custom simultaneous recall uses the locked global-hotkey backend's Carbon registration. The app does not request Input Monitoring or Accessibility for this route. Registration/release errors preserve or report the existing setting. Cmd and Ctrl remain distinct. OS shortcut conflicts can prevent a registration.

Custom recording uses focused settings-button DOM events. Repeat, composition and unsupported input are rejected; Escape/focus exit cancel. No global recording hook or TCC request is added. A candidate is not applied until **Apply** is selected.

Pinning selects the HTML shown on recall; unpinned recall keeps the current view. Root restrictions, grant revalidation and unavailable-document checks still apply.

## Verification limits

The owner reported successful ordinary Intel Mac recall and tab closing after the startup correction, without an exact binary hash or architecture record for every check. Synthetic key tests and compiler success do not establish physical-key behavior, permission inheritance after replacement, Apple Silicon or every OS combination. See [known limitations](known-limitations.md) and [update procedure](update-guide.md).
