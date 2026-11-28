// On-demand content overlay for Browser Control Companion.
// Injected ONLY when an agent starts a handoff or needs foreign extension frame eviction.
// Adds ZERO DOM until `bc:handoff-start` arrives.

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

  let activeHandoff = null; // { host, observer, promoteScheduled, handoffId, message, origin }

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

  const HAND_ICON = ["M18 11V6a2 2 0 0 0-4 0v5", "M14 10V4a2 2 0 0 0-4 0v6", "M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 16 0v-2a2 2 0 0 0-4 0"];
  const ARROW_ICON = ["M5 12h14", "M13 6l6 6-6 6"];

  function svgIcon(paths, size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(k, String(v));
    }
    for (const d of paths) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  function mountHandoffOverlay(message, originLabel, handoffId) {
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
        --bg: #ffffff;
        --text: #14171c;
        --muted: #5b6370;
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
        --accent-text: #1d4ed8;
        --on-accent: #ffffff;
        --focus: #2563eb;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #16181d;
          --text: #eceef2;
          --muted: #a3aab6;
          --accent-hover: #3b6ff0;
          --accent-text: #9dbbff;
          --focus: #9dbbff;
        }
      }
      .edge {
        position: fixed;
        inset: 0;
        pointer-events: none;
        box-shadow: inset 0 0 0 3px var(--accent);
      }
      .card {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 320px;
        max-width: calc(100vw - 32px);
        pointer-events: auto;
        border-radius: 12px;
        border: 2px solid var(--accent);
        background: var(--bg);
        color: var(--text);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
        padding: 14px 16px 16px;
        box-sizing: border-box;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 2px;
      }
      .header svg {
        flex: none;
        color: var(--accent-text);
      }
      .title {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--accent-text);
      }
      .origin {
        font-size: 12px;
        color: var(--muted);
        margin: 0 0 10px 26px;
        overflow-wrap: anywhere;
      }
      .msg {
        font-size: 14px;
        line-height: 1.45;
        margin: 0 0 14px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        min-height: 36px;
        padding: 8px 14px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: var(--on-accent);
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn:hover {
        background: var(--accent-hover);
      }
      .btn:focus-visible {
        outline: 2px solid var(--focus);
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
    header.appendChild(svgIcon(HAND_ICON, 18));
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
    btn.appendChild(svgIcon(ARROW_ICON, 16));
    btn.addEventListener("click", (ev) => {
      // Gate completion strictly on trusted user/input clicks so page scripts cannot dismiss handoff.
      if (!ev.isTrusted) return;
      ev.stopPropagation();
      const doneId = activeHandoff?.handoffId;
      teardownHandoff();
      try {
        chrome.runtime.sendMessage({ type: "bc:handoff-done", handoffId: doneId }).catch(() => {});
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

    const state = { host, observer: null, promoteScheduled: false, handoffId, message, origin: originLabel };

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
      mountHandoffOverlay(msg.message, msg.origin, msg.handoffId);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "bc:handoff-clear") {
      if (msg.handoffId && activeHandoff?.handoffId && msg.handoffId !== activeHandoff.handoffId) {
        sendResponse({ ok: true, cleared: false });
        return false;
      }
      teardownHandoff();
      sendResponse({ ok: true, cleared: true });
      return false;
    }
    return false;
  });
})();
