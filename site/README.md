# Mogledge product site

Buildless English product site for GitHub Pages. All public page files live in this directory; the desktop app, HTML authoring kit and npm/Rust build inputs are independent. There is no analytics, external font, CDN dependency, AI connection or form submission. JavaScript only copies a diagnostic prompt on request.

## Preview

Serve this directory with an existing static server, for example:

```sh
python3 -m http.server 4178 --directory site
```

Open `http://localhost:4178/`. Assets use relative URLs so the same files work under the repository's `/mogledge/` Pages path. Opening `site/index.html` directly also displays the page; clipboard access can require a secure context, and failure selects the prompt for manual copying.

## Publish

The initial preparation found no existing Pages site (`has_pages: false`), no Pages workflow, no `gh-pages` branch and no configured homepage. No repository setting was changed and no Actions workflow was run during preparation.

1. Review and merge the site PR after authorization.
2. An authorized repository administrator must enable **Settings → Pages → Build and deployment → Source: GitHub Actions**, if it remains disabled. Do not change repository visibility or broaden unrelated permissions.
3. After authorization for Actions execution, run **Deploy product site (manual)** from `main` at the reviewed commit. It uploads only the static public page and assets; no desktop build, installation, signing key or secret is used. It runs only by manual dispatch and rejects other repositories or branches.
4. The packaging job requests only `contents: read`; deployment requests `pages: write` and `id-token: write` for the standard GitHub Pages OIDC deployment. Review the `github-pages` environment policy if repository settings require it. Do not weaken existing protection to deploy.
5. Read back the deployment status and actual URL before reporting publication. The expected default URL is `https://shimi-lynx.github.io/mogledge/`; it is not a confirmed live site until deployment succeeds. Preserve an existing custom domain if one is configured later.

No product version bump is required: these files change only the external product site. There is no related implementation issue; the scope is the requested product page.

## Content and media maintenance

- Lead the title, description and hero with the local HTML viewer for Windows/macOS; AI handoff and explicit saved input are supporting features. Keep the absolute canonical, Open Graph URL and one-page sitemap aligned with the actual `/mogledge/` URL. Open Graph/social image tags reuse the 960 × 540 overview poster. The footer links to `sitemap.xml`, which the manual workflow must include in its public-file allowlist. Metadata and a sitemap do not establish indexing, ranking or a particular service's rendered card. See [Google's canonical guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls), [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) and the [Open Graph protocol](https://ogp.me/). This project cannot set the host-wide robots policy through a file under `/mogledge/`; no project `robots.txt` or Search Console/account configuration is added.
- The user-supplied app icon is resized only, with its original proportions, colors and transparency retained. The header displays a 96 px PNG at 36 px (32 px on mobile); 32/48 px PNG favicons and a 180 px touch icon are separate small derivatives. The original upload is retained outside the public site.
- The optional source-build section points to the repository, first-build guide and existing-installation update guide. Ready-made downloads remain the default recommendation. Local Mac builds may avoid download-quarantine-related failures but do not provide notarization or guarantee fixes for permissions or application bugs. Ordinary self-builds keep the updater disabled; replacing them with a released build restores that distribution's signing/trust conditions.
- Download links are pinned to actual 0.10.0 Release assets: Windows x64 NSIS installer and architecture-specific Mac application ZIPs. The ZIP names contain `updater`, but these are the documented initial/manual application downloads, not the `.app.tar.gz` updater payloads or GitHub source archives. Check actual Release metadata and signing/trust limits before updating all three links and displayed version together.
- The release upgrade notice explains the separate 0.10.0 profile and old Mac login-startup handoff. Settings and saved input are not automatically transferred from older releases; retain old data and follow the update guide.
- Five user-supplied screenshots were authorized for this public site. They show English UI and sample HTML in 0.9.0, not evidence that 0.10.0 Native behavior was tested. Captions disclose that version and distinguish example HTML tools from built-in product features.
- All five are lossless WebP derivatives without source metadata. The receiving-app screenshot is cropped to exclude its account avatar and unrelated sidebar. The original uploaded files remain unchanged. No email or personal absolute path was found in the retained image regions.
- The approved replacement overview is a 26.83-second MP4/H.264 video, 1600 × 900, 24 fps, with no audio track. Its original pace and duration are retained. The receiving app's account avatar is masked throughout frames 340–435, approximately 14.17–18.17 seconds, in the public derivative. The earlier withdrawn video is not included. The page uses controls, inline playback, `preload="none"`, an optimized poster, English captions and a transcript; it never autoplays. Sample screens are from 0.9.0 and the video's destination labels are simplified.
- Public images contain no EXIF, XMP, GPS or PNG text metadata. Optional video encoding tags and H.264 SEI data are removed; mandatory container creation/modification timestamps are zero. The MP4 contains one video track, no audio or subtitle track; its separate English VTT captions are intentional public content. Originals, transfer records, audit frames and intermediate encodings stay outside the public site. Demo text, relative guide paths and receiving-app model/approval-mode labels remain visible.
- Match feature, browser-storage and update claims to `docs/user-guide.md`, `docs/security.md`, `docs/document-storage.md`, `docs/update-guide.md` and the corresponding implementation. Never describe the document sandbox as blocking the app's separate update traffic or imply that browser and Native storage automatically synchronize.

## Verification scope

Review responsive desktop/mobile layout, keyboard navigation, image loading, internal anchors, all three actual download assets and repository guide links. Check the diagnostic copy success and denied/unavailable fallback. Keep raw screenshots and machine-specific evidence outside tracked public files. A static browser preview does not establish desktop Native QA, OS trust or updater installation success. Pages deployment remains unrun until the merge, settings and manual run are authorized.

Verified on October 16, 2026:

- Existing Microsoft Edge, headless: 320, 375, 768 and 1440 px viewports; no horizontal overflow, missing images, empty image descriptions, broken anchors or page errors. Desktop and mobile screenshots were visually reviewed under the `/mogledge/` base path.
- Diagnostic prompt: successful copy and denied-copy selection fallback passed with a stubbed clipboard. The ordinary system clipboard was not changed.
- Media: manual playback advanced, controls/poster/captions were present, playback rate remained 1, and no MP4 request occurred before playback. All 644 source/output frame timestamps and durations match; output duration is 26.833333 seconds. Every slide and adjacent cut frames were visually reviewed. Comparing all 644 decoded frames in the known profile-avatar region found zero matches to the unredacted avatar. This check is not full-frame OCR. Safari and mobile-device playback are unrun.
- All 14 distinct external links returned HTTP 200 to HEAD requests, including the three exact release downloads. No duplicate full installer/application download was required.
- Targeted formatting, JavaScript syntax, diff checks and YAML parsing passed. Workflow checks confirmed manual-only/main-only execution, separated least-privilege jobs and full-SHA Action pins. No application build, Native QA, Pages settings change or workflow execution was performed.
