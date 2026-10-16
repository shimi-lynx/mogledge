(() => {
  // Observe the document's normal event path. Do not intercept keys before its JS.
  const token = __MOGLEDGE_KEYBOARD_TOKEN__;
  // HTTP error pages do not contain this adapter. The parent additionally checks
  // the current frame/token and whether a user selection requested this display.
  const ready = () => parent.postMessage({ type: "mogledge-document-ready-v1", token }, "*");
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready, { once: true });
  // Closed roots hide their editing descendants. Never try to obtain those roots.
  const shadowHostNames = new Set([
    "article",
    "aside",
    "blockquote",
    "body",
    "div",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "main",
    "nav",
    "p",
    "section",
    "span",
  ]);
  function protectedFocus() {
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (!focused) return true;
    if (focused.matches("input, textarea, select") || focused.isContentEditable) return true;
    // A neutral body is the fallback activeElement, not a focused shadow host.
    if (focused === document.body && !focused.matches(":focus")) return false;
    return (
      focused.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      (shadowHostNames.has(focused.localName) || focused.localName.includes("-"))
    );
  }
  function modalOpen() {
    const roots = [document];
    for (const root of roots) {
      if (root.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return true;
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    return false;
  }
  let composing = false;
  window.addEventListener("compositionstart", () => {
    composing = true;
  });
  window.addEventListener("compositionend", () => {
    composing = false;
  });
  function editingEvent(event) {
    return event
      .composedPath()
      .some(
        (node) =>
          node instanceof Element &&
          (node.matches("input, textarea, select") || node.isContentEditable),
      );
  }
  function allowsDocumentInput(event) {
    return (
      event.isTrusted &&
      !event.isComposing &&
      !composing &&
      !event.defaultPrevented &&
      !event.cancelBubble &&
      document.hasFocus() &&
      !editingEvent(event) &&
      !protectedFocus() &&
      !modalOpen()
    );
  }
  // WebView2 supplies Ctrl+F, but the Mac host has no native document-find UI.
  // Keep queries, ranges and painting inside the focused frame. Highlight ranges
  // without wrapping authored text nodes or relying on an unfocused selection.
  let documentFind;
  function openDocumentFind() {
    if (!document.body) return;
    if (documentFind?.host.isConnected) {
      documentFind.input.focus();
      documentFind.input.select();
      return;
    }
    const labels = navigator.language?.toLowerCase().startsWith("ja")
      ? {
          find: "このHTML内を検索",
          previous: "前の一致",
          next: "次の一致",
          close: "検索を閉じる",
          found: (current, total) => `${total} 件中 ${current} 件目`,
          missing: "0 件（一致なし）",
        }
      : {
          find: "Find in this HTML",
          previous: "Previous match",
          next: "Next match",
          close: "Close find",
          found: (current, total) => `${current} of ${total} matches`,
          missing: "0 matches (No match)",
        };
    const returnFocus = document.activeElement;
    const selection = window.getSelection();
    const start = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : document.createRange();
    if (!selection?.rangeCount) {
      start.selectNodeContents(document.body);
      start.collapse(true);
    }
    let matches = [];
    let current = -1;
    let previousQuery = "";
    const host = document.createElement("mogledge-document-find");
    host.style.cssText =
      "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;display:block;width:min(440px,calc(100vw - 24px))";
    const root = host.attachShadow({ mode: "open" });
    // Only fixed application labels enter this markup; the query stays an input value.
    root.innerHTML = `<style>
      *{box-sizing:border-box}.bar{display:grid;grid-template-columns:minmax(0,1fr) repeat(3,32px);gap:6px;padding:9px;background:#202832;color:#f2f4f7;border:1px solid #7f8c9b;border-radius:7px;box-shadow:0 3px 14px #0005;font:14px/1.4 system-ui,sans-serif}
      input{min-width:0;width:100%;font:inherit;padding:5px;border:1px solid #8e9aaa;border-radius:3px;background:#fff;color:#111}button{font:inherit;border:1px solid #8e9aaa;border-radius:3px;background:#303d4b;color:#fff;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid #a8e4ce;outline-offset:1px}output{grid-column:1/-1;font-size:12px;min-height:1.4em}
      </style><div class="bar" role="search" aria-label="${labels.find}"><input type="search" maxlength="4096" aria-label="${labels.find}" placeholder="${labels.find}"><button type="button" aria-label="${labels.previous}">↑</button><button type="button" aria-label="${labels.next}">↓</button><button type="button" aria-label="${labels.close}">×</button><output role="status" aria-live="polite"></output></div>`;
    const input = root.querySelector("input");
    const status = root.querySelector("output");
    const [previous, next, close] = root.querySelectorAll("button");
    // Custom highlights follow reflow and remain visible while the input owns
    // focus. Older WKWebViews use non-interactive viewport rectangles instead.
    const highlightName = `mogledge-find-${token}`;
    const currentName = `${highlightName}-current`;
    const customHighlights = typeof Highlight === "function" && CSS.highlights;
    const highlightStyle = document.createElement("style");
    highlightStyle.textContent = `::highlight(${highlightName}){background:#ffe066;color:#111}::highlight(${currentName}){background:#ff9632;color:#111}`;
    if (customHighlights) document.documentElement.append(highlightStyle);
    const paintHost = document.createElement("mogledge-find-highlights");
    paintHost.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;display:block;overflow:hidden";
    const paintRoot = paintHost.attachShadow({ mode: "closed" });
    if (!customHighlights) document.documentElement.append(paintHost);
    let paintFrame = 0;
    let refreshFrame = 0;
    const paint = () => {
      paintFrame = 0;
      if (!host.isConnected) return;
      if (customHighlights) {
        const all = new Highlight();
        for (const range of matches) all.add(range);
        CSS.highlights.set(highlightName, all);
        const active = new Highlight();
        if (matches[current]) active.add(matches[current]);
        active.priority = 1;
        CSS.highlights.set(currentName, active);
        return;
      }
      const bounds = paintHost.getBoundingClientRect();
      const scaleX = bounds.width / paintHost.clientWidth;
      const scaleY = bounds.height / paintHost.clientHeight;
      const rectangles = document.createDocumentFragment();
      if (!(scaleX > 0 && scaleY > 0)) return;
      matches.forEach((range, index) => {
        // Clip to scrolling ancestors so a range cannot paint over their chrome.
        let left = 0,
          top = 0,
          right = innerWidth,
          bottom = innerHeight;
        for (
          let element = range.startContainer.parentElement;
          element;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
            left = Math.max(left, rect.left);
            right = Math.min(right, rect.right);
          }
          if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
        }
        for (const rect of range.getClientRects()) {
          const x = Math.max(left, rect.left),
            y = Math.max(top, rect.top);
          const width = Math.min(right, rect.right) - x;
          const height = Math.min(bottom, rect.bottom) - y;
          if (width <= 0 || height <= 0) continue;
          const marker = document.createElement("span");
          marker.style.cssText = `position:absolute;left:${(x - bounds.left) / scaleX}px;top:${(y - bounds.top) / scaleY}px;width:${width / scaleX}px;height:${height / scaleY}px;background:${index === current ? "#ff963270" : "#ffe06670"};box-shadow:inset 0 -2px ${index === current ? "#b54800" : "#8a6900"};pointer-events:none`;
          rectangles.append(marker);
        }
      });
      paintRoot.replaceChildren(rectangles);
    };
    const schedulePaint = () => {
      if (!paintFrame) paintFrame = requestAnimationFrame(paint);
    };
    // Build literal text runs across inline markup, separating block boundaries.
    // Form values, shadow trees, nested documents and media are outside this scan.
    const collectMatches = (query) => {
      const result = [];
      if (!query) return result;
      const expression = new RegExp(
        query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
        "giu",
      );
      let text = "";
      let nodes = [];
      const flush = () => {
        expression.lastIndex = 0;
        let hit;
        let nodeIndex = 0;
        while ((hit = expression.exec(text))) {
          while (nodes[nodeIndex].end <= hit.index) nodeIndex++;
          const first = nodes[nodeIndex];
          let endIndex = nodeIndex;
          const end = hit.index + hit[0].length;
          while (nodes[endIndex].end < end) endIndex++;
          const last = nodes[endIndex];
          const range = document.createRange();
          range.setStart(first.node, hit.index - first.start);
          range.setEnd(last.node, end - last.start);
          if (range.getClientRects().length) result.push(range);
        }
        text = "";
        nodes = [];
      };
      const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const style = getComputedStyle(node.parentElement);
          if (style.visibility === "hidden" || style.visibility === "collapse") return;
          const start = text.length;
          text += node.data;
          nodes.push({ node, start, end: text.length });
          return;
        }
        if (!(node instanceof Element)) return;
        if (
          node.matches(
            "script,style,noscript,template,input,textarea,select,iframe,object,embed,canvas",
          )
        ) {
          flush();
          return;
        }
        const style = getComputedStyle(node);
        if (style.display === "none" || style.contentVisibility === "hidden") return;
        const boundary = !["inline", "contents"].includes(style.display) || node.localName === "br";
        if (boundary) flush();
        for (const child of node.childNodes) visit(child);
        if (boundary) flush();
      };
      visit(document.body);
      flush();
      return result;
    };
    const showCurrent = (scroll) => {
      const match = matches[current];
      status.textContent = input.value
        ? match
          ? labels.found(current + 1, matches.length)
          : labels.missing
        : "";
      previous.disabled = next.disabled = !match;
      if (match && scroll) {
        match.startContainer.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "instant",
        });
        // A match can sit far from the centre of a tall paragraph. Scroll its
        // actual range through each container rather than just its parent box.
        for (
          let element = match.startContainer.parentElement;
          element && element !== document.scrollingElement;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const rect = match.getBoundingClientRect();
          const scale = bounds.height / element.offsetHeight;
          if (
            /auto|scroll|hidden/.test(style.overflowY) &&
            scale > 0 &&
            (rect.top < bounds.top || rect.bottom > bounds.bottom)
          ) {
            element.scrollTop +=
              (rect.top - bounds.top - (bounds.height - rect.height) / 2) / scale;
          }
        }
        const rect = match.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight) {
          window.scrollBy({ top: rect.top - (innerHeight - rect.height) / 2, behavior: "instant" });
        }
      }
      paint();
    };
    const refresh = () => {
      refreshFrame = 0;
      if (!host.isConnected || composing) return;
      const active = matches[current];
      matches = collectMatches(input.value);
      current = matches.findIndex(
        (range) =>
          active &&
          range.startContainer === active.startContainer &&
          range.startOffset === active.startOffset,
      );
      if (current < 0 && matches.length) current = 0;
      showCurrent(false);
    };
    const observer = new MutationObserver(() => {
      if (input.value && !refreshFrame) refreshFrame = requestAnimationFrame(refresh);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    window.addEventListener("scroll", schedulePaint, true);
    window.addEventListener("resize", schedulePaint);
    const dismiss = () => {
      observer.disconnect();
      cancelAnimationFrame(paintFrame);
      cancelAnimationFrame(refreshFrame);
      window.removeEventListener("scroll", schedulePaint, true);
      window.removeEventListener("resize", schedulePaint);
      if (customHighlights) {
        CSS.highlights.delete(highlightName);
        CSS.highlights.delete(currentName);
      }
      highlightStyle.remove();
      paintHost.remove();
      host.remove();
      documentFind = undefined;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    const find = (backwards = false, advance = true) => {
      if (composing || !host.isConnected || !document.hasFocus()) return;
      const query = input.value;
      const changed = query !== previousQuery;
      const active = matches[current];
      matches = collectMatches(query);
      current = matches.findIndex(
        (range) =>
          active &&
          range.startContainer === active.startContainer &&
          range.startOffset === active.startOffset,
      );
      if (changed) {
        current = matches.findIndex(
          (range) =>
            !start.commonAncestorContainer.isConnected ||
            range.compareBoundaryPoints(Range.START_TO_START, start) >= 0,
        );
        if (current < 0 && matches.length) current = 0;
      } else if (matches.length) {
        current =
          (current + (advance ? (backwards ? -1 : 1) : 0) + matches.length) % matches.length;
      }
      input.focus({ preventScroll: true });
      previousQuery = query;
      showCurrent(true);
    };
    input.addEventListener("input", (event) => {
      if (!event.isComposing) find(false, false);
    });
    input.addEventListener("compositionend", () => queueMicrotask(() => find(false, false)));
    root.addEventListener("keydown", (event) => {
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        find(event.shiftKey);
      }
    });
    previous.addEventListener("click", () => find(true));
    next.addEventListener("click", () => find());
    close.addEventListener("click", dismiss);
    document.documentElement.append(host);
    documentFind = { host, input };
    previous.disabled = next.disabled = true;
    input.focus({ preventScroll: true });
  }
  function allowsDocumentFind(event) {
    return (
      event.isTrusted &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      !composing &&
      !event.defaultPrevented &&
      !event.cancelBubble &&
      document.hasFocus() &&
      !modalOpen()
    );
  }
  window.addEventListener("keydown", (event) => {
    if (
      !/Mac/i.test(navigator.platform) ||
      !event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.repeat ||
      event.key.toLowerCase() !== "f" ||
      !allowsDocumentFind(event)
    )
      return;
    // Iframe keys do not bubble to main. Keep later authored handlers' first
    // refusal; unlike destructive tab commands, unhandled find also works in inputs.
    setTimeout(() => {
      if (allowsDocumentFind(event)) openDocumentFind();
    }, 0);
  });
  function afterZoomInput(event, apply) {
    // Native page zoom is disabled. Keep the normal HTML event path, including
    // later synchronous window listeners, before proposing a document-only zoom.
    setTimeout(() => {
      if (allowsDocumentInput(event)) apply();
    }, 0);
  }
  function zoom(change) {
    parent.postMessage({ type: "mogledge-document-zoom-v1", token, change }, "*");
  }
  function pinch(event, factor) {
    const x = Number.isFinite(event.clientX)
      ? Math.max(0, Math.min(1, event.clientX / innerWidth))
      : 0.5;
    const y = Number.isFinite(event.clientY)
      ? Math.max(0, Math.min(1, event.clientY / innerHeight))
      : 0.5;
    parent.postMessage(
      {
        type: "mogledge-document-pinch-v1",
        token,
        factor: Math.max(0.1, Math.min(10, factor)),
        x,
        y,
      },
      "*",
    );
  }
  // The parent owns the accepted per-view scale. Render it inside this existing
  // document so text/layout are recalculated, without scaling the application shell.
  let renderedZoom = 100;
  let acceptedZoom = 100;
  let authoredZoom;
  let renderFrame = 0;
  let pendingRender;
  let initialRender;
  function fixedToViewport(element) {
    // A containing-block ancestor makes fixed content move with its scrolling.
    // https://www.w3.org/TR/css-position-3/#fixed-cb
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "contents") continue;
      // Root filter effects do not establish a fixed containing block.
      // https://www.w3.org/TR/filter-effects-1/#FilterProperty
      const filterContainingBlock =
        ancestor !== document.documentElement &&
        (style.filter !== "none" || /\bfilter\b/.test(style.willChange));
      if (
        style.transform !== "none" ||
        [style.translate, style.rotate, style.scale].some((value) => value && value !== "none") ||
        style.perspective !== "none" ||
        filterContainingBlock ||
        (style.backdropFilter && style.backdropFilter !== "none") ||
        /\b(layout|paint|strict|content)\b/.test(style.contain) ||
        /\b(transform|translate|rotate|scale|perspective|backdrop-filter|contain)\b/.test(
          style.willChange,
        ) ||
        style.contentVisibility === "auto"
      )
        return false;
    }
    return true;
  }
  function applyZoom(message) {
    const root = document.documentElement;
    if (!authoredZoom) {
      const computed = Number.parseFloat(getComputedStyle(root).zoom);
      authoredZoom = {
        value: root.style.getPropertyValue("zoom"),
        priority: root.style.getPropertyPriority("zoom"),
        scale: Number.isFinite(computed) && computed > 0 ? computed : 1,
      };
    }
    const ratio = message.zoom / renderedZoom;
    const x = message.anchor ? message.anchor.x * innerWidth : 0;
    const y = message.anchor ? message.anchor.y * innerHeight : 0;
    const beforeX = scrollX,
      beforeY = scrollY;
    // Track the element under the gesture through reflow, without wrapping or moving authored DOM.
    const target = message.anchor ? document.elementFromPoint(x, y) : null;
    const before = target?.getBoundingClientRect();
    const scrollers = [];
    let viewportFixed = false;
    for (let element = target; element && element !== root; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.position === "fixed" && fixedToViewport(element)) viewportFixed = true;
      if (element === document.scrollingElement) continue;
      const scrollsX = /^(auto|scroll|hidden|overlay)$/.test(style.overflowX);
      const scrollsY = /^(auto|scroll|hidden|overlay)$/.test(style.overflowY);
      if (scrollsX || scrollsY) scrollers.push({ element, scrollsX, scrollsY });
      // Ancestor scrolling outside this fixed boundary cannot move the target.
      // Keep the panel itself eligible, but do not spend its clamped remainder on the background.
      if (viewportFixed) break;
    }
    const targetScroller = scrollers.find(({ element }) => element === target);
    const targetScrollLeft = target?.scrollLeft ?? 0;
    const targetScrollTop = target?.scrollTop ?? 0;
    if (message.zoom === 100) {
      if (authoredZoom.value)
        root.style.setProperty("zoom", authoredZoom.value, authoredZoom.priority);
      else root.style.removeProperty("zoom");
    } else
      root.style.setProperty(
        "zoom",
        String((authoredZoom.scale * message.zoom) / 100),
        "important",
      );
    renderedZoom = message.zoom;
    if (message.anchor) {
      const anchorDelta = () => {
        const after = target?.getBoundingClientRect();
        // A blank area can hit the scroller itself. Its box does not move when
        // its own content scrolls, so include that consumed content displacement.
        const ownScaleX = after && targetScroller ? after.width / target.offsetWidth : 0;
        const ownScaleY = after && targetScroller ? after.height / target.offsetHeight : 0;
        return {
          x:
            after && before
              ? after.left +
                (x - before.left) * ratio -
                x +
                (targetScroller?.scrollsX && Number.isFinite(ownScaleX)
                  ? (targetScrollLeft - target.scrollLeft) * ownScaleX
                  : 0)
              : (beforeX + x) * ratio - x - scrollX,
          y:
            after && before
              ? after.top +
                (y - before.top) * ratio -
                y +
                (targetScroller?.scrollsY && Number.isFinite(ownScaleY)
                  ? (targetScrollTop - target.scrollTop) * ownScaleY
                  : 0)
              : (beforeY + y) * ratio - y - scrollY,
        };
      };
      // Element scroll offsets use unzoomed layout units. Consume the viewport
      // delta from the innermost container outwards, remeasuring after each clamp.
      // If reflow moves its clip away from the pointer, let an outer scroller move it back.
      for (const { element, scrollsX, scrollsY } of scrollers) {
        const delta = anchorDelta();
        const rect = element.getBoundingClientRect();
        const scaleX = rect.width / element.offsetWidth;
        const scaleY = rect.height / element.offsetHeight;
        element.scrollTo({
          left:
            scrollsX && x >= rect.left && x <= rect.right && Number.isFinite(scaleX) && scaleX > 0
              ? element.scrollLeft + delta.x / scaleX
              : element.scrollLeft,
          top:
            scrollsY && y >= rect.top && y <= rect.bottom && Number.isFinite(scaleY) && scaleY > 0
              ? element.scrollTop + delta.y / scaleY
              : element.scrollTop,
          behavior: "instant",
        });
      }
      // Scrolling the window cannot move a viewport-fixed panel. At its bounds,
      // leave the unavoidable remainder there rather than moving unrelated content.
      if (!viewportFixed) {
        const delta = anchorDelta();
        scrollTo({ left: scrollX + delta.x, top: scrollY + delta.y, behavior: "instant" });
      }
    } else scrollTo({ left: beforeX, top: beforeY, behavior: "instant" });
  }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== parent ||
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      Object.keys(message).length !== 4 ||
      (message.type !== "mogledge-document-zoom-render-v1" &&
        message.type !== "my-knowledge-document-zoom-render-v1") ||
      message.token !== token ||
      !Number.isFinite(message.zoom) ||
      message.zoom < 50 ||
      message.zoom > 200
    )
      return;
    const anchor = message.anchor;
    if (
      anchor !== null &&
      (!anchor ||
        typeof anchor !== "object" ||
        Array.isArray(anchor) ||
        Object.keys(anchor).length !== 2 ||
        !Number.isFinite(anchor.x) ||
        anchor.x < 0 ||
        anchor.x > 1 ||
        !Number.isFinite(anchor.y) ||
        anchor.y < 0 ||
        anchor.y > 1)
    )
      return;
    acceptedZoom = message.zoom;
    // DOMContentLoaded does not wait for external CSS. Capture the authored
    // baseline after load, including notifications received before the iframe loads.
    if (document.readyState !== "complete") {
      initialRender = message;
      return;
    }
    if (!anchor) {
      resetGesture();
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      pendingRender = undefined;
      applyZoom(message);
    } else {
      pendingRender = message;
      if (!renderFrame)
        renderFrame = requestAnimationFrame(() => {
          renderFrame = 0;
          const next = pendingRender;
          pendingRender = undefined;
          if (next) applyZoom(next);
        });
    }
  });
  window.addEventListener("load", () => {
    if (initialRender) {
      applyZoom({ ...initialRender, anchor: null });
      initialRender = undefined;
    }
  });
  window.addEventListener("keydown", (event) => {
    const direction = /Mac/i.test(navigator.platform)
      ? event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "[" ? "back" : event.key === "]" ? "forward" : null)
      : event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (event.key === "ArrowLeft" ? "back" : event.key === "ArrowRight" ? "forward" : null);
    if (
      !direction ||
      event.shiftKey ||
      event.repeat ||
      event.keyCode === 229 ||
      !allowsDocumentInput(event)
    )
      return;
    setTimeout(() => {
      if (allowsDocumentInput(event))
        parent.postMessage({ type: "mogledge-history-v1", token, direction }, "*");
    }, 0);
  });
  let lastKeyZoom = -Infinity;
  window.addEventListener("keydown", (event) => {
    const modifier = /Mac/i.test(navigator.platform)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (
      modifier &&
      !event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key.toLowerCase() === "w" &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      // Native W window/browser actions are disabled separately. Keep later HTML
      // listeners' first refusal before closing the authenticated focused view.
      setTimeout(() => {
        if (!allowsDocumentInput(event)) return;
        event.preventDefault();
        parent.postMessage({ type: "mogledge-close-tab-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key.toLowerCase() === "e" &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      // Use the same fixed proposal boundary as sidebar toggle; authored HTML
      // handlers keep the complete synchronous key path before main switches.
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-files-show-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      !event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key === "," &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-settings-open-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      !event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key.toLowerCase() === "b" &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      // The document keeps its standard bold binding and synchronous handlers.
      // Main accepts only a fixed proposal from this focused live token/frame.
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-sidebar-toggle-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      !event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key.toLowerCase() === "p" &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      // The HTML's later window listeners retain first refusal. Only a fixed
      // focused-view proposal crosses to main; no Native accelerator consumes P.
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-quick-open-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      event.key.toLowerCase() === "a" &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      // This only proposes opening confirmation for the focused document. HTML
      // listeners can cancel synchronously before the deferred proposal runs.
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-ai-handoff-v1", token }, "*");
      }, 0);
      return;
    }
    if (
      modifier &&
      event.shiftKey &&
      !event.altKey &&
      !event.repeat &&
      /^Digit[0-9]$/.test(event.code) &&
      event.keyCode !== 229 &&
      allowsDocumentInput(event)
    ) {
      const digit = Number(event.code.slice(-1));
      setTimeout(() => {
        if (allowsDocumentInput(event))
          parent.postMessage({ type: "mogledge-workspace-set-v1", token, slot: digit || 10 }, "*");
      }, 0);
      return;
    }
    if (!modifier || event.altKey || !allowsDocumentInput(event)) return;
    const change =
      event.key === "+" || event.key === "=" || event.code === "NumpadAdd"
        ? "in"
        : event.key === "-" || event.code === "NumpadSubtract"
          ? "out"
          : event.key === "0" && !event.shiftKey
            ? "reset"
            : null;
    if (!change) return;
    afterZoomInput(event, () => {
      const now = performance.now();
      if (event.repeat && now - lastKeyZoom < 120) return;
      lastKeyZoom = now;
      zoom(change);
    });
  });
  let wheelAmount = 0;
  let lastWheel = -Infinity;
  let lastWheelZoom = -Infinity;
  let gestureActive = false;
  let gestureScale = 1;
  let gestureBaseZoom = 100;
  let gestureZoom = 100;
  let lastGesture = -Infinity;
  let gestureGeneration = 0;
  function resetGesture(recent = false) {
    gestureGeneration++;
    gestureActive = false;
    wheelAmount = 0;
    lastGesture = recent ? performance.now() : -Infinity;
  }
  window.addEventListener(
    "wheel",
    (event) => {
      if (
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !allowsDocumentInput(event)
      ) {
        wheelAmount = 0;
        return;
      }
      const generation = gestureGeneration;
      afterZoomInput(event, () => {
        if (generation !== gestureGeneration) return;
        const now = performance.now();
        // A missing end must not suppress wheel forever. New gesture input refreshes this deadline.
        if (gestureActive && now - lastGesture > 1500) resetGesture();
        // WKWebView may report both a gesture and Ctrl-wheel for the same pinch.
        if (gestureActive || now - lastGesture < 400) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
        const delta = event.deltaY * unit;
        if (!Number.isFinite(delta) || !delta) return;
        // Mac trackpad pinch can arrive as pixel Ctrl-wheel rather than GestureEvent.
        // Keep the established discrete mouse-wheel path on Windows and for line/page deltas.
        if (/Mac/i.test(navigator.platform) && event.deltaMode === 0) {
          pinch(event, Math.exp(Math.max(-Math.log(10), Math.min(Math.log(10), -delta * 0.002))));
          return;
        }
        if (now - lastWheel > 180) wheelAmount = 0;
        lastWheel = now;
        wheelAmount = Math.max(-100, Math.min(100, wheelAmount - delta));
        if (Math.abs(wheelAmount) < 100 || now - lastWheelZoom < 120) return;
        lastWheelZoom = now;
        const change = wheelAmount > 0 ? "in" : "out";
        wheelAmount = 0;
        zoom(change);
      });
    },
    { passive: false },
  );
  window.addEventListener("gesturestart", (event) => {
    if (!allowsDocumentInput(event)) return;
    resetGesture();
    const generation = gestureGeneration;
    afterZoomInput(event, () => {
      if (generation !== gestureGeneration) return;
      gestureActive = true;
      gestureScale = 1;
      gestureBaseZoom = acceptedZoom;
      gestureZoom = acceptedZoom;
      lastGesture = performance.now();
      wheelAmount = 0;
    });
  });
  window.addEventListener("gesturechange", (event) => {
    if (!gestureActive || !allowsDocumentInput(event)) return;
    const generation = gestureGeneration;
    afterZoomInput(event, () => {
      if (!gestureActive || generation !== gestureGeneration) return;
      const scale = Number(event.scale);
      if (!Number.isFinite(scale) || scale <= 0) return;
      const now = performance.now();
      lastGesture = now;
      if (scale === gestureScale) return;
      // Scale is relative to start. Keep that baseline through saturation, so a
      // reversal beyond 200%/50% does not prematurely jump back into the range.
      const proposed = Math.max(50, Math.min(200, gestureBaseZoom * scale));
      if (proposed !== gestureZoom) pinch(event, proposed / gestureZoom);
      gestureZoom = proposed;
      gestureScale = scale;
    });
  });
  // Ending a gesture only clears state: observe capture even when HTML stops bubbling.
  window.addEventListener(
    "gestureend",
    (event) => {
      if (event.isTrusted) resetGesture(true);
    },
    true,
  );
  window.addEventListener("blur", () => resetGesture());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) resetGesture();
  });
  window.addEventListener("keydown", (event) => {
    const modifier = /Mac/i.test(navigator.platform)
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (
      !event.isTrusted ||
      !modifier ||
      !event.shiftKey ||
      event.altKey ||
      event.repeat ||
      event.isComposing ||
      composing ||
      event.defaultPrevented ||
      event.cancelBubble ||
      !["ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    if (editingEvent(event) || protectedFocus() || modalOpen()) return;
    // A later window listener can still cancel this same event synchronously.
    setTimeout(() => {
      if (
        event.defaultPrevented ||
        composing ||
        !document.hasFocus() ||
        protectedFocus() ||
        modalOpen()
      )
        return;
      parent.postMessage(
        { type: "mogledge-move-tab-v1", token, direction: event.key === "ArrowLeft" ? 0 : 1 },
        "*",
      );
    }, 0);
  });
})();
