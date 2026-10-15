(function () {
  "use strict";
  if (Object.hasOwn(globalThis, "MyKnowledgeExport")) return;
  const maximum = 5 * 1024 * 1024;
  const formats = { png: "png", jpeg: "jpg", csv: "csv", json: "json", text: "txt" };
  const descriptorPresent = Object.hasOwn(globalThis, "__MY_KNOWLEDGE_EXPORT_V1__");
  const descriptor = globalThis.__MY_KNOWLEDGE_EXPORT_V1__;
  let busy = false;
  let last = -Infinity;
  function failure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  function exportArtifact(proposal) {
    // Admission precedes every await, including Blob encoding. No automatic retry.
    if (!navigator.userActivation?.isActive)
      return Promise.reject(failure("ArtifactGestureRequired"));
    if (
      !proposal ||
      Object.keys(proposal).sort().join() !== "blob,format,name" ||
      !(proposal.blob instanceof Blob) ||
      !Object.hasOwn(formats, proposal.format) ||
      typeof proposal.name !== "string" ||
      !proposal.name ||
      proposal.name.length > 1024 ||
      new TextEncoder().encode(proposal.name).length > 1024
    )
      return Promise.reject(failure("ArtifactInvalidRequest"));
    if (!proposal.blob.size || proposal.blob.size > maximum)
      return Promise.reject(failure("ArtifactTooLargeOrInvalid"));
    if (busy) return Promise.reject(failure("ArtifactBusy"));
    if (performance.now() - last < 1000) return Promise.reject(failure("ArtifactCooldown"));
    busy = true;
    last = performance.now();
    let operation;
    try {
      if (descriptorPresent) {
        if (descriptor?.version !== 1 || typeof descriptor.exportArtifact !== "function")
          throw failure("ArtifactUnavailable");
        operation = descriptor.exportArtifact(proposal);
      } else {
        // Browser only. A download request is not proof of a saved file.
        const extension = formats[proposal.format];
        const basename =
          // eslint-disable-next-line no-control-regex -- File names must replace forbidden control characters.
          proposal.name.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, "_").replace(/[ .]+$/g, "") ||
          "artifact";
        const name = basename.toLowerCase().endsWith("." + extension)
          ? basename
          : basename + "." + extension;
        const url = URL.createObjectURL(proposal.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        operation = Promise.resolve({ status: "download-requested", name });
      }
    } catch (error) {
      operation = Promise.reject(error);
    }
    return Promise.resolve(operation).finally(() => {
      busy = false;
    });
  }
  Object.defineProperty(globalThis, "MyKnowledgeExport", {
    value: Object.freeze({ exportArtifact }),
    writable: false,
    configurable: false,
  });
})();
