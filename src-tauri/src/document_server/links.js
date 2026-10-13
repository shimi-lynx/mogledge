(() => {
  const token = __MY_KNOWLEDGE_LINK_TOKEN__;
  const preventDefault = Object.getOwnPropertyDescriptor(Event.prototype, "preventDefault").value;
  const returnValue = Object.getOwnPropertyDescriptor(Event.prototype, "returnValue");
  function afterClick(event, route) {
    // Suppress iframe navigation now, but let later synchronous document
    // listeners veto app routing independently of our own cancellation.
    let cancelled = false;
    const previousPrevent = Object.getOwnPropertyDescriptor(event, "preventDefault");
    const previousReturn = Object.getOwnPropertyDescriptor(event, "returnValue");
    const documentPrevent = function () {
      cancelled = true;
      return preventDefault.call(this);
    };
    const documentReturn = function (value) {
      if (!value) cancelled = true;
      return returnValue.set.call(this, value);
    };
    function restore(name, previous, current) {
      const descriptor = Object.getOwnPropertyDescriptor(event, name);
      if (descriptor?.value !== current && descriptor?.set !== current) {
        cancelled = true;
        return;
      }
      try {
        if (previous) Object.defineProperty(event, name, previous);
        else delete event[name];
      } catch {
        cancelled = true;
      }
    }
    preventDefault.call(event);
    try {
      Object.defineProperty(event, "preventDefault", {
        configurable: true,
        writable: true,
        value: documentPrevent,
      });
      Object.defineProperty(event, "returnValue", {
        configurable: true,
        get() {
          return returnValue.get.call(this);
        },
        set: documentReturn,
      });
    } catch {
      // Unmodifiable event objects fail closed rather than bypass a veto.
      restore("preventDefault", previousPrevent, documentPrevent);
      return;
    }
    // A task runs after all synchronous dispatch listeners, unlike a microtask.
    setTimeout(() => {
      restore("preventDefault", previousPrevent, documentPrevent);
      restore("returnValue", previousReturn, documentReturn);
      if (!cancelled) route();
    }, 0);
  }
  function anchor(fragment) {
    let id;
    try {
      id = decodeURIComponent(fragment.replace(/^#/, ""));
    } catch {
      return false;
    }
    const target = id ? (document.getElementById(id) ?? document.getElementsByName(id)[0]) : null;
    if (id && !target) return false;
    location.hash = fragment;
    if (!id) window.scrollTo(0, 0);
    else target.scrollIntoView();
    return true;
  }
  let pendingAnchor;
  function applyAnchor(data) {
    // The adapter precedes authored parser-blocking scripts. Validate against
    // the completed DOM, not a transient absence while the page is loading.
    if (document.readyState !== "complete") {
      pendingAnchor = data;
      return;
    }
    const success = anchor(data.fragment);
    if (Number.isSafeInteger(data.request))
      parent.postMessage(
        { type: "my-knowledge-anchor-result-v1", token, request: data.request, success },
        "*",
      );
  }
  window.addEventListener(
    "load",
    () => {
      if (pendingAnchor) {
        const data = pendingAnchor;
        pendingAnchor = undefined;
        applyAnchor(data);
      }
    },
    { once: true },
  );
  // This message controls only this document's scroll position, never Native actions.
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source === parent &&
      data?.type === "my-knowledge-anchor-v1" &&
      data.token === token &&
      typeof data.fragment === "string" &&
      data.fragment.length <= 8192
    ) {
      applyAnchor(data);
    }
  });
  window.addEventListener("click", (event) => {
    const link = event
      .composedPath()
      .find((element) => element instanceof Element && element.matches("a[href], area[href]"));
    if (!link || link.hasAttribute("download")) return;
    if (!event.isTrusted) {
      // A synthetic anchor must neither route through the app nor start a
      // rejected Native frame navigation that can discard the live document.
      preventDefault.call(event);
      return;
    }
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    let url;
    try {
      const href = link.getAttribute("href");
      url = new URL(
        href.startsWith("/") && !href.startsWith("//") ? `/s/${token}${href}` : href,
        document.baseURI,
      );
    } catch {
      preventDefault.call(event);
      return;
    }
    // Special schemes and root-external local paths remain blocked by the host.
    preventDefault.call(event);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 8192)
      return;
    afterClick(event, () => {
      // A document can forge this proposal. It is never proof of user intent;
      // only main UI's own confirmation click authorizes external OS dispatch.
      parent.postMessage({ type: "my-knowledge-link-v1", token, href: url.href }, "*");
    });
  });
})();
