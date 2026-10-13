(() => {
  const inputHost = document.createElement("div");
  const input = document.createElement("input");
  input.value = "two words";
  inputHost.attachShadow({ mode: "closed" }).append(input);
  const openHost = document.createElement("div");
  const open = openHost.attachShadow({ mode: "open" });
  const editorHost = document.createElement("x-shadow-editor");
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.textContent = "two words";
  editorHost.attachShadow({ mode: "closed" }).append(editor);
  const button = document.createElement("button");
  button.textContent = "Shadow plain";
  const dialog = document.createElement("dialog");
  dialog.innerHTML = "<button>Modal</button>";
  const ariaDialog = document.createElement("div");
  ariaDialog.setAttribute("role", "dialog");
  ariaDialog.setAttribute("aria-modal", "false");
  open.append(editorHost, button, dialog, ariaDialog);
  document.body.append(inputHost, openHost);
  let lateModal = false;
  const events = [];
  const observe = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    events.push({
      trusted: event.isTrusted,
      prevented: event.defaultPrevented,
      editingInPath: event
        .composedPath()
        .some(
          (node) =>
            node instanceof Element &&
            (node.matches("input, textarea, select") || node.isContentEditable),
        ),
    });
    if (lateModal) ariaDialog.setAttribute("aria-modal", "true");
  };
  window.addEventListener("keydown", observe);
  window.shadowProbe = {
    events,
    focus(kind) {
      dialog.close();
      ariaDialog.setAttribute("aria-modal", "false");
      lateModal = false;
      if (kind === "input") {
        input.focus();
        input.setSelectionRange(0, 0);
      } else if (kind === "editor") {
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (kind === "native-modal") dialog.showModal();
      else if (kind === "plain") button.focus();
      else {
        document.querySelector("#action").focus();
        if (kind === "aria-modal") ariaDialog.setAttribute("aria-modal", "true");
        else lateModal = true;
      }
    },
    inputSelection: () => input.selectionEnd - input.selectionStart,
    editorSelection: () => getSelection().toString(),
    remove() {
      dialog.close();
      inputHost.remove();
      openHost.remove();
      window.removeEventListener("keydown", observe);
    },
  };
})();
