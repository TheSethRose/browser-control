// On-demand content overlay for Browser Control Companion.
// Injected ONLY when an agent starts a handoff or needs foreign extension frame eviction.
// Adds ZERO DOM until `bc:handoff-start` arrives.
// Patterns adapted from anomalyco/browse (MIT License).

(() => {
  if (globalThis.__bcOverlayInstalled) return;
  globalThis.__bcOverlayInstalled = true;

  const HOST_ATTR = "data-bc-handoff-host";
  const FOREIGN_SELECTORS = [
    "com-1password-notification",
    "com-1password-button",
    "com-1password-menu",
    "com-1password-op-button",
    "onepassword-extension",
    "[data-onepassword-extension]",
    "[data-lastpass-root]",
    "[data-lastpass-icon-root]",
    "div[id^='__lpform']",
    "bitwarden-notification",
    "[id^='bitwarden-']",
  ];

  let activeHandoff = null; // { host, observer, promoteScheduled, message, origin }

  function evictForeignExtensionFrames() {
    const ownOrigin =
      typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("")
        : "";
    let removed = 0;
    const toRemove = new Set();

    for (const sel of FOREIGN_SELECTORS) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          toRemove.add(el);
        }
      } catch {
        /* ignore invalid selector */
      }
    }

    try {
      for (const el of document.querySelectorAll("iframe[src^='chrome-extension://']")) {
        const src = el.getAttribute("src") || "";
        if (!ownOrigin || !src.startsWith(ownOrigin)) {
          toRemove.add(el);
        }
      }
    } catch {
      /* ignore */
    }

    // Catch any custom elements prefixed with com-1password- or bitwarden-.
    try {
      for (const el of document.querySelectorAll("*")) {
        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (tag.startsWith("com-1password-") || tag.startsWith("bitwarden-")) {
          toRemove.add(el);
        }
      }
    } catch {
      /* ignore */
    }

    for (const el of toRemove) {
      try {
        if (el.getAttribute?.(HOST_ATTR)) continue;
        el.remove();
        removed += 1;
      } catch {
        /* ignore */
      }
    }

    return { ok: true, removed };
  }

  function teardownHandoff() {
    if (!activeHandoff) return;
    const state = activeHandoff;
    activeHandoff = null;
    try {
      state.observer?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      state.host?.hidePopover?.();
    } catch {
      /* ignore */
    }
    try {
      state.host?.remove();
    } catch {
      /* ignore */
    }
  }

  function showTopLayer(host) {
    try {
      if (typeof host.showPopover === "function") {
        if (host.matches && host.matches(":popover-open")) {
          host.hidePopover();
        }
        host.showPopover();
      }
    } catch {
      /* fallback to high z-index fixed positioning */
    }
  }

  function mountHandoffOverlay(message, originLabel) {
    teardownHandoff();

    const host = document.createElement("div");
    host.setAttribute(HOST_ATTR, "1");
    if ("popover" in host) {
      host.setAttribute("popover", "manual");
    }
    // Reset UA popover defaults so the host never blocks page clicks or password-manager popovers.
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "inset: 0",
      "width: 100vw",
      "height: 100vh",
      "margin: 0",
      "padding: 0",
      "border: 0",
      "background: transparent",
      "pointer-events: none",
      "overflow: visible",
      "z-index: 2147483647",
    ].join(" !important;") + " !important;";

    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .edge {
        position: fixed;
        inset: 0;
        pointer-events: none;
        box-shadow: inset 0 0 0 3px #2563eb;
      }
      .card {
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 320px;
        max-width: calc(100vw - 32px);
        pointer-events: auto;
        border-radius: 10px;
        border: 1px solid rgba(37, 99, 235, 0.45);
        background: #ffffff;
        color: #111827;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22);
        padding: 14px 16px;
        box-sizing: border-box;
      }
      @media (prefers-color-scheme: dark) {
        .card {
          background: #18181b;
          color: #f4f4f5;
          border-color: rgba(59, 130, 246, 0.6);
        }
        .origin {
          color: #a1a1aa;
        }
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 4px;
      }
      .title {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #2563eb;
      }
      @media (prefers-color-scheme: dark) {
        .title { color: #60a5fa; }
      }
      .origin {
        font-size: 11px;
        color: #6b7280;
        margin-bottom: 8px;
        word-break: break-all;
      }
      .msg {
        font-size: 13px;
        line-height: 1.4;
        margin: 0 0 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        padding: 8px 14px;
        border: 0;
        border-radius: 7px;
        background: #2563eb;
        color: #ffffff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn:hover {
        background: #1d4ed8;
      }
      .btn:focus-visible {
        outline: 2px solid #93c5fd;
        outline-offset: 2px;
      }
    `;

    const edge = document.createElement("div");
    edge.className = "edge";

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Your turn");

    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Your turn";
    header.appendChild(title);

    const origin = document.createElement("div");
    origin.className = "origin";
    origin.textContent = String(originLabel || location.origin || location.href || "");

    const msg = document.createElement("p");
    msg.className = "msg";
    msg.textContent = String(message || "Complete this step, then click Continue.");

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Continue";
    btn.addEventListener("click", (ev) => {
      // Gate completion strictly on trusted user/input clicks so page scripts cannot dismiss handoff.
      if (!ev.isTrusted) return;
      ev.stopPropagation();
      teardownHandoff();
      try {
        chrome.runtime.sendMessage({ type: "bc:handoff-done" }).catch(() => {});
      } catch {
        /* ignore */
      }
    });

    card.appendChild(header);
    card.appendChild(origin);
    card.appendChild(msg);
    card.appendChild(btn);

    shadow.appendChild(style);
    shadow.appendChild(edge);
    shadow.appendChild(card);

    const root = document.documentElement || document.body;
    root.appendChild(host);
    showTopLayer(host);

    const state = { host, observer: null, promoteScheduled: false, message, origin: originLabel };

    const schedulePromote = () => {
      if (!activeHandoff || activeHandoff !== state || state.promoteScheduled) return;
      state.promoteScheduled = true;
      queueMicrotask(() => {
        state.promoteScheduled = false;
        if (!activeHandoff || activeHandoff !== state) return;
        const parent = document.documentElement || document.body;
        if (!host.isConnected && parent) {
          parent.appendChild(host);
        }
        showTopLayer(host);
      });
    };

    const observer = new MutationObserver((mutations) => {
      if (!activeHandoff || activeHandoff !== state) return;
      if (!host.isConnected) {
        schedulePromote();
        return;
      }
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node === host || node.nodeType !== 1) continue;
          const el = node;
          if (
            el.tagName === "DIALOG" ||
            el.hasAttribute?.("popover") ||
            el.getAttribute?.("role") === "dialog"
          ) {
            schedulePromote();
            return;
          }
        }
        if (m.type === "attributes" && m.target !== host && (m.attributeName === "open" || m.attributeName === "popover")) {
          schedulePromote();
          return;
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "popover"],
    });
    state.observer = observer;
    activeHandoff = state;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;
    if (msg.type === "bc:evict-foreign-frames") {
      sendResponse(evictForeignExtensionFrames());
      return false;
    }
    if (msg.type === "bc:handoff-start") {
      mountHandoffOverlay(msg.message, msg.origin);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "bc:handoff-clear") {
      teardownHandoff();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
