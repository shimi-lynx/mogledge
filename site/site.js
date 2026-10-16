const copyButton = document.getElementById("copy-diagnostic");
const diagnosticText = document.getElementById("diagnostic-text");
const copyStatus = document.getElementById("copy-status");

copyButton.addEventListener("click", async () => {
  copyButton.disabled = true;
  copyStatus.textContent = "";
  try {
    await navigator.clipboard.writeText(diagnosticText.value);
    copyStatus.textContent = "Copied. Review and fill in the brackets before sharing.";
  } catch {
    diagnosticText.focus();
    diagnosticText.select();
    copyStatus.textContent = "Copy unavailable. The text is selected; copy it manually.";
  } finally {
    copyButton.disabled = false;
  }
});
