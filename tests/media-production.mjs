// Uses actual production Rust responses. Native WebView codecs remain unverified.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
const documentUrl = process.env.MEDIA_DOCUMENT_URL;
const origin = process.env.MEDIA_DOCUMENT_ORIGIN;
const root = process.env.MEDIA_FIXTURE_ROOT;
assert.ok(documentUrl && origin && root);
// The second environment serves the same HTML and relative files normally,
// with no Native descriptor or restrictive app CSP.
const portable = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname.slice(1);
  if (name === "native-shell.html") {
    response
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(
        `<iframe title="media" sandbox="allow-scripts" src="${documentUrl}" style="width:100%;height:650px"></iframe>`,
      );
    return;
  }
  if (name === "favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (!["index.html", "tone.mp3", "clip.mp4"].includes(name)) {
    response.writeHead(404).end();
    return;
  }
  const bytes = await readFile(`${root}/${name}`);
  response
    .writeHead(200, {
      "Content-Type": name.endsWith(".mp3")
        ? "audio/mpeg"
        : name.endsWith(".mp4")
          ? "video/mp4"
          : "text/html; charset=utf-8",
      "Content-Length": bytes.length,
    })
    .end(bytes);
});
await new Promise((resolve) => portable.listen(1420, "127.0.0.1", resolve));
const portableUrl = `http://127.0.0.1:${portable.address().port}/index.html`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  for (const url of [documentUrl, portableUrl]) {
    const page = await browser.newPage();
    const actual = url === documentUrl;
    page.setDefaultTimeout(10000);
    const mediaResponses = [];
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));

    page.on("console", (message) => {
      if (message.type() === "error") console.error(message.text());
    });

    page.on("response", (response) => {
      if (/\.(mp3|mp4)$/.test(response.url())) mediaResponses.push(response);
    });
    if (actual) {
      // Real loopback transport supplies the browser address-space classification.
      // The fixed shell origin is required by the production frame-ancestors CSP.
      // No app UI/IPC, permission changes or browser security flags.
      await page.goto("http://127.0.0.1:1420/native-shell.html");
    } else {
      await page.goto(url);
    }
    const frame = actual ? page.frameLocator('iframe[title="media"]') : page;
    for (const tag of ["audio", "video"]) {
      const media = frame.locator(tag);
      await media.waitFor();
      await frame.locator(`#play-${tag}`).click();
      await media.evaluate(async (element) => {
        const deadline = performance.now() + 10000;
        while (element.currentTime < 0.15 || element.readyState < 2) {
          if (element.error)
            throw new Error(`${element.tagName} media error ${element.error.code}`);
          if (performance.now() > deadline) throw new Error(`${element.tagName} playback timeout`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        element.currentTime = 2;
        const seekDeadline = performance.now() + 5000;
        while (element.seeking || element.currentTime < 2.05) {
          if (element.error || performance.now() > seekDeadline)
            throw new Error(
              `${element.tagName} seek failed: time=${element.currentTime}, duration=${element.duration}, paused=${element.paused}, error=${element.error?.code}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        element.pause();
      });
    }
    await frame.getByRole("button", { name: "タイマー音を開始" }).click();
    await frame.locator("#status").filter({ hasText: "音を開始" }).waitFor();
    assert.deepEqual(failures, []);
    if (actual) {
      for (const extension of ["mp3", "mp4"]) {
        const partial = mediaResponses.filter(
          (response) => response.url().endsWith(`.${extension}`) && response.status() === 206,
        );
        assert.ok(partial.length > 0, `actual ${extension} Range playback`);
        for (const response of partial) {
          const headers = response.headers();
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers["content-range"]);
          assert.ok(match);
          assert.equal(Number(headers["content-length"]), Number(match[2]) - Number(match[1]) + 1);
          assert.ok(Number(headers["content-length"]) <= 2 * 1024 * 1024);
          assert.equal(headers["content-type"], extension === "mp3" ? "audio/mpeg" : "video/mp4");
          assert.equal(headers["x-content-type-options"], "nosniff");
        }
      }
    }
    await page.close();
  }
  console.log(
    "PASS: actual Chromium standard MP3/MP4 Range playback + seek, large bounded MP4, opaque Native-shaped CSP iframe, ordinary HTTP portability, clicked WebAudio timer. Native/audio hardware/background unverified.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => portable.close(resolve));
}
