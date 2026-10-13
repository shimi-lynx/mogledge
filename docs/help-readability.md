# Built-in Help

The title-bar Help button opens one reusable, read-only tab. Its Japanese and English sources are [ja.html](../src/app/help/ja.html) and [en.html](../src/app/help/en.html).

Features and Usage start with “AIに渡す” / “Send to AI”: the use case, three steps, then optional details. The steps explain choosing a target, adding a request, and checking the draft in the external AI tool before sending. Mogledge passes the selected path and request; it does not attach HTML content or saved input. The external tool keeps its own permissions and approval settings.

Both languages advise creating and editing in an ordinary local folder outside OneDrive sync. File and folder operations inside OneDrive sync folders may fail. This advice does not remove limited browsing of items already retained on the device or add OneDrive write support.

The remaining features appear in six overview cards. Search instructions use short lists. The existing Features, Usage and Shortcuts radio choices remain at the top; the AI shortcut is the first table row. Tab reaches the choices, arrow keys select a section, and Tab reaches its scrollable content. Native disclosure controls show additional explanations without JavaScript. Cards use two columns at wider sizes and one column below 620px.

## Boundary and maintenance

Help remains a bundled document served at the two fixed application Help URLs, independent of the selected knowledge folder. The empty iframe sandbox, script prohibition and existing CSP remain unchanged. There are no scripts, external requests, links, storage adapters, Native IPC or added dependencies. Keep the two language files equivalent when updating instructions, and preserve existing section IDs, accessible names and shortcut values.

This changes explanatory text and CSS only, so it does not require a separate product version bump. The shared release version is coordinated once with the distribution changes; application operations, storage contracts and compatibility are unchanged by Help. See [security](security.md) and [testing](testing.md) for the broader boundaries and validation policy.

## Focused verification

The final source differs from the recorded runs only by the Japanese shortcut label changing from “previous / next” to “next / previous”, matching the unchanged Ctrl+Tab / Ctrl+Shift+Tab order, a unit assertion's whitespace normalization, and this documentation. Section IDs, controls, CSS, key values, fixture behavior and application code are unchanged by that label correction. The results below are reused for those unchanged scopes; the corrected label was checked directly in both language files.

| Scope                                                        | Source                                     | Method and environment                                                             | Result                                                                                | Limits                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Format, lint and types                                       | `19c7de2775fb1f989d56c79ae9f05b3f900c11ad` | Windows, `npm run check`                                                           | 419 formatted files, 203 lint/type files; no warnings                                 | Static checks; final changed-file format is also checked                                                                   |
| Help content and sandbox                                     | `e944c7570709cb8635fecdb4ccf157b4a84642ae` | jsdom, `npm test -- src/app/AppHelp.test.tsx --configLoader runner --maxWorkers 1` | 4/4 passed                                                                            | No Native WebView execution                                                                                                |
| Help tab, keyboard, disclosures, language and document state | `e944c7570709cb8635fecdb4ccf157b4a84642ae` | Headless Chromium, `npm run test:ui`; the two existing Help cases below            | 2/2 passed                                                                            | Native bridge mock                                                                                                         |
| Language, width, theme, section and scrolling                | `19c7de2775fb1f989d56c79ae9f05b3f900c11ad` | Headless Chromium; JA/EN × 1000/320/220px × light/dark × three sections            | 36 layouts passed; no horizontal overflow, keyboard scrolling and disclosures checked | Standalone HTML preview, not Native                                                                                        |
| Application regressions                                      | `fb4e89961cfe6b6d97de5f93bf1d28f60a28441b` | jsdom, `npm test -- src/app/App.test.tsx --configLoader runner --maxWorkers 1`     | 22/22 passed                                                                          | Reused: later source changes are Help text/CSS and Help assertions only; application code and this test file are unchanged |

```sh
npm run test:ui -- tests/ui/layout.spec.ts --grep 'local help uses one lazy|viewer and bundled help switch'
```

The initial combined App/Help unit run passed 25/26 tests and timed out waiting for an existing search-result button. The isolated case passed on unchanged main `2b8dc8595b3aa10d910f3f5fe7eab9baafbe65bc`; the full App file then passed without changing its code, test or assertions. The first failure is retained here rather than treating the initial run as successful.

The first OneDrive content assertion failed because the HTML formatter put a newline between “may” and “fail”. Normalizing whitespace in the assertion preserved the expected meaning; the four Help tests then passed. No application behavior was changed to make either test run pass.

Initial screenshots were reviewed for the prominent AI instructions, section choices and readable overview. Screenshots and preview output remain private verification evidence, outside the source tree. Native WebView2/WKWebView, physical IME and assistive-technology QA were not run. No application build, installer, release, merge or user-profile operation was performed for this change.
