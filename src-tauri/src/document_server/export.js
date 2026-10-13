(function () {
  "use strict";
  const token = __MY_KNOWLEDGE_EXPORT_TOKEN__;
  const parentWindow = window.parent;
  const post = parentWindow.postMessage.bind(parentWindow);
  const formats = ["png", "jpeg", "csv", "json", "text"];
  const maximum = 5 * 1024 * 1024;
  let pending = null;
  let last = -Infinity;
  const fail = (code) => Object.assign(new Error(code), { code });
  function exportArtifact(proposal) {
    if (!navigator.userActivation?.isActive) return Promise.reject(fail("ArtifactGestureRequired"));
    if (!document.hasFocus() || document.querySelector("dialog[open], [aria-modal='true']"))
      return Promise.reject(fail("ArtifactSourceChanged"));
    if (
      !proposal ||
      Object.keys(proposal).sort().join() !== "blob,format,name" ||
      !(proposal.blob instanceof Blob) ||
      !formats.includes(proposal.format) ||
      typeof proposal.name !== "string" ||
      !proposal.name ||
      proposal.name.length > 1024 ||
      new TextEncoder().encode(proposal.name).length > 1024
    )
      return Promise.reject(fail("ArtifactInvalidRequest"));
    if (!proposal.blob.size || proposal.blob.size > maximum)
      return Promise.reject(fail("ArtifactTooLargeOrInvalid"));
    if (pending) return Promise.reject(fail("ArtifactBusy"));
    if (performance.now() - last < 1000) return Promise.reject(fail("ArtifactCooldown"));
    last = performance.now();
    const id = crypto.randomUUID();
    const { blob, format, name } = proposal;
    return new Promise((resolve, reject) => {
      pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (pending?.id !== id) return;
          pending = null;
          reject(fail("ArtifactResultUnknown"));
        }, 300000),
      };
      blob
        .arrayBuffer()
        .then((buffer) => {
          if (pending?.id !== id) return;
          if (!document.hasFocus()) throw fail("ArtifactSourceChanged");
          const bytes = new Uint8Array(buffer);
          if (!bytes.length || bytes.length > maximum) throw fail("ArtifactTooLargeOrInvalid");
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 16384)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
          post(
            {
              type: "my-knowledge-artifact-export-v1",
              token,
              id,
              format,
              name,
              data: btoa(binary),
            },
            "*",
          );
        })
        .catch((error) => {
          if (pending?.id !== id) return;
          clearTimeout(pending.timer);
          pending = null;
          reject(fail(error?.code || "ArtifactUnavailable"));
        });
    });
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== parentWindow ||
      !pending ||
      !message ||
      Object.keys(message).sort().join() !== "id,result,token,type" ||
      message.type !== "my-knowledge-artifact-result-v1" ||
      message.token !== token ||
      message.id !== pending.id
    )
      return;
    const result = message.result;
    if (!result || typeof result !== "object") return;
    const keys = Object.keys(result).sort().join();
    const saved =
      keys === "bytes,name,status" &&
      result.status === "saved" &&
      typeof result.name === "string" &&
      Number.isSafeInteger(result.bytes) &&
      result.bytes > 0 &&
      result.bytes <= maximum;
    const cancelled = keys === "status" && result.status === "cancelled";
    const failed =
      keys === "error" &&
      typeof result.error === "string" &&
      /^Artifact[A-Za-z]+$/.test(result.error);
    if (!saved && !cancelled && !failed) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (failed) current.reject(fail(result.error));
    else current.resolve(result);
  });
  Object.defineProperty(globalThis, "__MY_KNOWLEDGE_EXPORT_V1__", {
    value: Object.freeze({ version: 1, exportArtifact }),
    writable: false,
    configurable: false,
  });
})();
