// Test fixture only. Commands exercise this document's own Web APIs, never Native APIs.
const report = (name, value) => parent.postMessage({ __wikiFixture: name, value }, "*");
const image = document.querySelector("#local-image");
if (!image.complete)
  await new Promise((done) => image.addEventListener("load", done, { once: true }));
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "wiki-fixture-command") return;
  switch (event.data.action) {
    case "exercise": {
      const range = document.querySelector("#range");
      range.value = "73";
      range.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#text").value = "edited";
      document.querySelector("#action").click();
      report("exercise", {
        module: document.querySelector("#module-result").textContent,
        classic: document.documentElement.dataset.classic,
        background: getComputedStyle(document.body).backgroundColor,
        range: document.querySelector("#value").value,
        input: document.querySelector("#text").value,
        canvasPixel: document.querySelector("#canvas").getContext("2d").getImageData(0, 0, 1, 1)
          .data[0],
        nativeAbsent: !window.__TAURI__ && !window.__TAURI_INTERNALS__,
        image: image.naturalWidth > 0,
      });
      break;
    }
    case "ping":
      report("ping", document.querySelector("#module-result").textContent);
      break;
    case "navigate":
      setTimeout(() => {
        location.href = event.data.url;
      }, 20);
      break;
    case "anchor":
      location.hash = "anchor";
      report("anchor", location.hash);
      break;
  }
});
report("ready", document.querySelector("#module-result").textContent.replace("Module ready: ", ""));
