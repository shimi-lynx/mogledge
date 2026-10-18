const copyButton = document.getElementById("copy-diagnostic");
const diagnosticText = document.getElementById("diagnostic-text");
const copyStatus = document.getElementById("copy-status");

copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  copyStatus.textContent = "";
  try {
    await navigator.clipboard.writeText(diagnosticText.value);
    copyStatus.textContent =
      copyButton.dataset.copied ?? "Copied. Review and fill in the brackets before sharing.";
  } catch {
    diagnosticText.focus();
    diagnosticText.select();
    copyStatus.textContent =
      copyButton.dataset.copyFailed ?? "Copy unavailable. The text is selected; copy it manually.";
  } finally {
    copyButton.disabled = false;
  }
});

const imageViewer = document.getElementById("image-viewer");
const previewImage = document.getElementById("image-viewer-image");
const closeImage = document.getElementById("close-image");

if (typeof imageViewer.showModal === "function") {
  let imageLink;
  let originalScroll;

  for (const link of document.querySelectorAll(".screenshot a")) {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      imageLink = link;
      originalScroll = { left: window.scrollX, top: window.scrollY };
      previewImage.src = link.href;
      previewImage.alt = link.querySelector("img").alt;
      // Fixed positioning also prevents the background moving during mobile touch scrolling.
      document.body.style.setProperty("--image-viewer-scroll-top", `${-originalScroll.top}px`);
      document.body.classList.add("image-viewer-open");
      imageViewer.showModal();
    });
  }

  closeImage.addEventListener("click", () => imageViewer.close());
  imageViewer.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // The close button is the dialog's only interactive element.
      event.preventDefault();
      closeImage.focus();
    }
  });
  imageViewer.addEventListener("click", (event) => {
    const bounds = imageViewer.getBoundingClientRect();
    if (
      event.target === imageViewer &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    ) {
      imageViewer.close();
    }
  });
  // Native Escape/cancel and the close button share exactly the same restoration path.
  imageViewer.addEventListener("close", () => {
    document.body.classList.remove("image-viewer-open");
    document.body.style.removeProperty("--image-viewer-scroll-top");
    window.scrollTo({ ...originalScroll, behavior: "instant" });
    imageLink.focus({ preventScroll: true });
    previewImage.removeAttribute("src");
  });
}
