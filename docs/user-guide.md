# User guide

## Hand off a task to AI

Use **Send to AI** when you want an external AI tool to create or edit an HTML tool in your knowledge folder. Mogledge passes the selected path and your request as an **unsent draft**; you decide what to send in the receiving tool.

1. Right-click an HTML file, folder or the root selector and choose **Send to AI**.
2. Choose the receiving tool and enter an optional request.
3. Open its draft, or copy the request and paste it yourself.

ChatGPT/Codex and Claude Code integrations keep the currently selected dedicated root as the working directory. Selected child folders, nested folders and files appear in the draft as task targets, even with an empty request. Selecting the root uses the working-directory parameter without repeating its path in the draft. Codex CLI uses copying: choose the stated working root manually, start Codex there and paste into its input. Copies state the working root and include a separate target only when it differs.

Drafts contain your request and the selected target without automatically adding guide-reading or instruction-discovery paragraphs, including when the optional guide setting is enabled. Existing guides, Skills and instruction files remain available. Receiving-client trust and permissions still apply.

This does not attach file contents, read saved inputs, send an AI API request or grant the external tool new permissions. A task target in a prompt is not an OS access restriction. Receiver installation/link handling and actual OS clipboard behavior have [known limits](known-limitations.md). Dedicated folders include the [authoring kit](html-authoring-kit.md); legacy unregistered folders retain their existing optional-guide setting.

Integration references: [Codex app links](https://learn.chatgpt.com/docs/reference/commands#deep-links), [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Claude Code CLI links](https://code.claude.com/docs/en/deep-links) and [Claude instruction loading](https://code.claude.com/docs/en/memory). The existing desktop URI routes are retained; actual receiving-client versions, draft display and clipboard behavior require Native checks.

See the [working-root verification record](ai-handoff-root-verification.md) for tested cases and receiving-client limits.

## Open and arrange documents

Register a knowledge folder, then open an HTML file from the tree. **Switch displayed folder** selects a child folder within that registration without changing saved-input keys or open tabs. **Settings → Registered folder** changes the registration itself; folders outside the registered scope are directed there. Restart restores the registered folder and the separately validated display folder. See [registered and displayed folders](registered-folders.md).

Save text files (HTML, CSS, JavaScript and JSON) as UTF-8, and keep images and other assets inside the registered folder with relative references. Documents run in isolated frames; external CDNs and arbitrary network requests are outside the supported scope.

The same document can be open in both columns. Move a tab between columns or reorder it by dragging; this keeps its live input, JavaScript and Canvas state. Right-click a tab for column actions, reload, close or close tabs to its right. Closing a tab discards unsaved runtime state. Reopening restores a document, not its previous JavaScript heap.

On restart, Mogledge automatically restores the last successfully saved tabs, their order, both panes and active selections, including independent copies of the same HTML. Hidden documents load when selected; missing or replaced sources remain safe placeholders. This restores the layout, not unsaved input or JavaScript state. See [tab sessions](tab-sessions.md) for root-specific persistence, controlled Quit/update behavior and failure handling.

Document zoom is 50–200%, with 25% keyboard/menu steps. Zoom affects the active document rather than the application UI. Document shortcuts respect editable controls, IME and synchronous HTML cancellation. Pinch behavior and physical-key coverage depend on the platform; see [known limitations](known-limitations.md).

Each column keeps up to 32 navigation-history entries while the app is running. Back/forward reuses an existing document frame in that column when possible. History and arbitrary live state are not synchronized or automatically restored after restarting.

Ctrl+W on Windows or Cmd+W on macOS closes the current tab in the active column from app controls or unhandled, non-editing HTML focus. Closing the last tab keeps the app open. Held keys close only one tab; HTML editing, IME, dialogs and synchronous cancellation retain priority. Reopen uses the existing closed-document history.

## Find within the open HTML

With focus inside an HTML document on macOS, press **Cmd+F** to open its local find bar. Type a phrase, use **Enter** / **Shift+Enter** or the arrow buttons for the next / previous match with wrap, and press **Escape** to close it and return focus. Search is case-insensitive and uses rendered text in that frame; it is not Canvas/image OCR or a search of saved-input records. The English/Japanese labels follow the WebView language. Unhandled Cmd+F also works from an HTML input; authored key cancellation, IME composition and an open HTML modal retain priority.

Windows retains its existing WebView2 **Ctrl+F** behavior. This current-document find is separate from **Cmd+Shift+F / Ctrl+Shift+F**, which opens indexed full-text document search below. Mac WKWebView/device acceptance remains explicitly unverified in [known limitations](known-limitations.md#existing-reported-problems).

## Find documents and save workspaces

| Feature              | Use                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Quick open           | Search filename/relative path and choose from up to 20 candidates; this is not body-text search.                                |
| Document search      | Search title, relative path, headings and static text. Choose AND/OR or a folder scope; results are paged in groups of 20.      |
| Favorites and recent | Expand the root-specific list; documents and folders share a 50-item favorite limit, with up to 50 recent documents.            |
| Workspace sets       | Explicitly save and recall up to 10 sets, each containing at most 30 document references, column/tab order, selection and zoom. |

Search normalizes Unicode with NFKC, lowercase and whitespace handling. Japanese short queries use literal matching; longer queries can use trigram candidates followed by literal checks. Search is not a SQL/FTS expression editor and does not search live JavaScript, Canvas or saved input values. Open index status to see skipped/unavailable files and explicitly rebuild the derived cache.

In workspace management, explicitly assign number shortcuts if wanted. Recalling a set does not eagerly load unselected documents and does not promise restoration of arbitrary script state. Favorites/recent/workspaces are navigation aids, not permission to delete saved inputs.

## Files and folders

The sidebar remembers expanded folders on this device for each registered folder, including after restart or switching the displayed child folder. Deleted or externally moved paths are discarded only after a successful tree scan; loading, recovery and scan errors preserve the remembered paths. If local UI preferences cannot be saved, current choices survive switching registered roots during the same session. Failed writes remain available for a later save attempt, while unreadable or unsupported stored preferences stay protected from automatic replacement.

Create HTML with an external AI or editor; **Hand off to AI** prepares a request without sending it. The app does not create blank HTML files. Folder creation remains available through the sidebar and Ctrl+Shift+N / Cmd+Shift+N.

Tree context menus provide folder creation, HTML rename, move, order, full-path copy, OS folder display and recycle actions where supported. Windows uses F2 and macOS Enter for HTML rename. The filename's existing HTML extension is retained. Files are not overwritten by rename/move, and HTML/CSS/JS references are not automatically rewritten.

Drag within the same parent to reorder; choose a folder or the **Move to** action for a confirmed move. Order is saved separately from the source HTML. Root/self/descendant targets, collisions, symlinks and unsupported cloud writes are rejected. Review relative links after moving files.

On Windows, supported locally retained OneDrive folders permit nested folders, HTML rename and HTML/empty-folder moves. Nonempty-folder moves, drops with a position anchor, reorder and trash remain restricted. If an operation reports an unknown outcome, do not automatically retry or delete files; refresh to inspect the preserved result. If a move completes but reference/order saving fails, the files stay at their new location and the warning explains the save failure. See [Cloud-file support](onedrive-qa.md).

Recycle actions do not make a saved-input database into an independent file backup. See [data management](data-management.md) before cleanup. Refresh/retry can recover an unavailable root without deleting its settings or creating a replacement folder.

## Links, browser display and media

- Same-page links scroll to a validated fragment. Links to another supported HTML file inside the selected root open in that column.
- External HTTP/HTTPS links require confirmation in the application before opening the default browser. Unsupported schemes, outside-root files and automatic popup/download routes are rejected.
- **Open in default browser** uses the app's read-only local server, not a `file:` URL. The URL expires on app exit, root/view changes or relevant file removal/move. Reopening that same document in the browser replaces its previous browser URL.
- Relative `.mp3`/`.mp4` assets can be played with ordinary `<audio>`/`<video>`. Start audio from a user gesture. Codec support and alarms while hidden/asleep are not guaranteed.

## Saved inputs and generated files

Saving input requires an HTML app that uses the [storage API](document-storage.md). It is separate from HTML files and the search cache. Save/flush acknowledgements establish persistence; unload does not guarantee a completed save. Renaming/moving the same physical HTML preserves its identity. Replacing/copying a file can require confirmed recovery rather than automatic reuse.

Settings provides saved-data inspection/management and explicit capacity settings. Search all saved metadata by HTML filename or relative path, select eligible records on the current page, and review the document count before confirming removal. Removal retains recovery copies and leaves HTML unchanged. Capacity fields support decimal B/KB/MB/GB amounts in exact 1 MiB steps, preserving the existing saved format without rounding; opening existing limits preserves their bytes. See [data management](data-management.md) for restoration and compatibility rules. HTML menus provide confirmed export/import of saved inputs. The [artifact export API](html-artifact-export.md) instead writes generated images or text through a confirmed save action; it is not an input backup.

## Settings, residency and help

Settings contains language, data management, HTML authoring and residency. English/Japanese changes apply immediately and preserve user-entered text and documents. On narrow screens the sidebar overlays the document; close it to interact with the document.

Residency and login startup are separate, initially disabled options. With residency enabled, closing the window hides it in the tray/menu bar; use **Quit** to stop the process. Tray left-click restores the existing window. Choose whether recall keeps the current view or opens one explicitly pinned HTML, which is revalidated before use.

The standard recall gesture is Shift → Ctrl → Shift on Windows, or Shift → Cmd → Shift on macOS: press/release in sequence with all other keys released. Each press must be within 400 ms and the sequence within 1.5 seconds. A custom shortcut can be chosen where supported. Normal input is not consumed; OS-protected input/permissions are not bypassed.

On macOS, the standard sequence requires **Input Monitoring** permission. If Settings reports missing permission, use its **Open Input Monitoring settings** button, grant the app access yourself if desired, and select **Check after granting permission**. If the button cannot open the pane, open macOS **Privacy & Security → Input Monitoring** manually (**Security & Privacy** on older macOS versions). Follow any macOS request to restart the app. The app does not grant access automatically or ask for Accessibility permission. Tray residency, custom shortcut registration and the focused custom-recording button do not request Input Monitoring permission. Login startup is a separate setting. Recording creates a candidate only; use **Apply recall shortcut** to register it, and choose another combination if registration fails.

The **Features and usage** button opens bundled offline read-only help. It works without a selected root and has Features, Usage and Shortcuts views. The app does not fetch help from this `docs` directory.

## Common shortcuts

Use Ctrl on Windows and Cmd on macOS unless stated otherwise. Editable inputs, IME, dialogs and HTML's own synchronous cancellation take priority.

| Action                                   | Shortcut                              |
| ---------------------------------------- | ------------------------------------- |
| Hand off the focused/selected HTML to AI | Ctrl/Cmd+Shift+A                      |
| Quick open                               | Ctrl/Cmd+P                            |
| Document search                          | Ctrl/Cmd+Shift+F                      |
| Show files and focus the tree            | Ctrl/Cmd+Shift+E                      |
| Toggle sidebar                           | Ctrl/Cmd+B                            |
| Settings                                 | Ctrl/Cmd+,                            |
| Close / reopen a tab                     | Ctrl/Cmd+W / Ctrl/Cmd+Shift+T         |
| Move focused tab to left/right column    | Ctrl/Cmd+Shift+Left/Right             |
| Recall an explicitly assigned workspace  | Ctrl/Cmd+Shift+1–0                    |
| Document zoom / reset                    | Ctrl/Cmd plus + or − / Ctrl/Cmd+0     |
| Navigation back/forward                  | Windows Alt+Left/Right; macOS Cmd+[/] |

Use the app's menus/help for context-specific operations and [known limitations](known-limitations.md) for platform coverage. A shortcut does not authorize automatic saving or an external AI submission.
