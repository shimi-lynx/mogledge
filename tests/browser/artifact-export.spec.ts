import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const token = "a".repeat(64);
const adapter = readFileSync(".agents/skills/mogledge-html/assets/export.js", "utf8");
const bridge = readFileSync("src-tauri/src/document_server/export.js", "utf8").replace(
  "__MY_KNOWLEDGE_EXPORT_TOKEN__",
  JSON.stringify(token),
);
const body = `<input value="keep input"><canvas width="2" height="2"></canvas><audio controls></audio><video controls></video>
<button id="export">Export text</button><button id="png" disabled>Export PNG</button><script>window.results=[];
document.querySelector('canvas').toBlob(blob=>{window.image=blob;document.querySelector('#png').disabled=false;});
document.querySelector('#png').onclick=()=>MyKnowledgeExport.exportArtifact({blob:image,name:'image',format:'png'}).then(result=>results.push(result)).catch(error=>results.push({error:error.code}));
exportButton=document.querySelector('#export');exportButton.onclick=()=>MyKnowledgeExport.exportArtifact({blob:new Blob(['generated'],{type:'text/plain'}),name:'report',format:'text'}).then(result=>results.push(result)).catch(error=>results.push({error:error.code}));
</script>`;
for (const protocol of ["file", "https"]) {
  test(`portable Blob adapter requests a standard browser download over ${protocol} only without the application bridge`, async ({
    page,
  }) => {
    test.skip(
      protocol === "file" && process.env.MY_KNOWLEDGE_SKIP_FILE_DOWNLOAD === "1",
      "This browser environment blocks file: navigation with ERR_BLOCKED_BY_ADMINISTRATOR. File download remains unverified; unset MY_KNOWLEDGE_SKIP_FILE_DOWNLOAD to execute it.",
    );
    let downloads = 0;
    page.on("download", () => downloads++);
    // DevTools evaluation can grant activation. Run the negative case during navigation,
    // before automation fills an input or clicks, and retain the actual activation observed.
    const html = `<!doctype html><script>${adapter}</script>${body}<script>
window.initialActivation=navigator.userActivation.isActive;
MyKnowledgeExport.exportArtifact({blob:new Blob(['x']),name:'report',format:'text'})
  .then(result=>results.push(result)).catch(error=>results.push({error:error.code}));
</script>`;
    const directory = await mkdtemp(join(tmpdir(), "artifact-browser-"));
    try {
      if (protocol === "file") {
        const file = join(directory, "export.html");
        await writeFile(file, html);
        await page.goto(pathToFileURL(file).href);
      } else {
        await page.route("https://artifact.test/**", (route) =>
          route.fulfill({ contentType: "text/html", body: html }),
        );
        await page.goto("https://artifact.test/export.html");
      }
      expect(await page.evaluate("initialActivation")).toBe(false);
      await expect
        .poll(() => page.evaluate("results"))
        .toEqual([{ error: "ArtifactGestureRequired" }]);
      expect(downloads).toBe(0);
      await page.locator("input").fill("unchanged");
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#export").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("report.txt");
      expect(downloads).toBe(1);
      await expect
        .poll(() => page.evaluate("results"))
        .toEqual([
          { error: "ArtifactGestureRequired" },
          { status: "download-requested", name: "report.txt" },
        ]);
      await expect(page.locator("input")).toHaveValue("unchanged");
      expect(
        await page.locator("audio").evaluate((element) => element instanceof HTMLAudioElement),
      ).toBe(true);
      expect(
        await page.locator("video").evaluate((element) => element instanceof HTMLVideoElement),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("actual injected opaque transport sends bounded Blob data and accepts only parent replies without Native-failure fallback", async ({
  page,
}) => {
  await page.route("https://artifact.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("https://artifact.test/");
  await page.setContent(
    `<script>window.requests=[];addEventListener('message',event=>{if(event.source!==document.querySelector('iframe').contentWindow||event.data.type!=='my-knowledge-artifact-export-v1')return;requests.push(event.data);event.source.postMessage({type:'my-knowledge-artifact-result-v1',token:event.data.token,id:event.data.id,result:{error:'ArtifactPublishedUnconfirmed'}},'*');});</script><iframe sandbox="allow-scripts"></iframe>`,
  );
  await page.locator("iframe").evaluate((frame, html) => {
    (frame as HTMLIFrameElement).srcdoc = html;
  }, `<!doctype html><script>${bridge}${adapter}</script>${body}`);
  let downloads = 0;
  page.on("download", () => downloads++);
  const frame = page.frameLocator("iframe");
  await frame.locator("input").fill("native untouched");
  await frame.locator("#export").click();
  await expect
    .poll(() =>
      frame
        .locator("#export")
        .evaluate(
          () => (window as unknown as { results: Array<{ error: string }> }).results[0]?.error,
        ),
    )
    .toBe("ArtifactPublishedUnconfirmed");
  expect(await page.evaluate("requests[0].data")).toBe(Buffer.from("generated").toString("base64"));
  expect(await page.evaluate("Object.keys(requests[0]).sort().join(',')")).toBe(
    "data,format,id,name,token,type",
  );
  expect(downloads).toBe(0);
  await page.waitForTimeout(1000); // Cross the documented client admission cooldown.
  await expect(frame.locator("#png")).toBeEnabled();
  await frame.locator("#png").click();
  await expect.poll(() => page.evaluate("requests.length")).toBe(2);
  expect(await page.evaluate("requests[1].format")).toBe("png");
  expect(
    Buffer.from(await page.evaluate<string>("requests[1].data"), "base64").subarray(0, 8),
  ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(downloads).toBe(0);
  await expect(frame.locator("input")).toHaveValue("native untouched");
});
