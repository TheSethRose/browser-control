// Onboarding link handler for one-time 8-character Crockford pairing codes.
// Reads `#code=...` (and optional `&port=...`) from the URL hash, clears the hash from
// history, and hands the code to the background service worker via `chrome.runtime.sendMessage`.

import { formatPairingCode, normalizePairingCode } from "./lib/pairing.js";

const statusEl = document.getElementById("status");
const formEl = document.getElementById("pairForm");
const codeInput = document.getElementById("codeInput");
const pairBtn = document.getElementById("pairBtn");

function setStatus(text, kind = "") {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = kind ? `status ${kind}` : "status";
}

function parseHashParams(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const params = new URLSearchParams(raw);
  const code = params.get("code") || "";
  const portRaw = params.get("port");
  const port = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
  return { code, port };
}

async function submitCode(rawCode, port) {
  const normalized = normalizePairingCode(rawCode);
  if (!normalized) {
    setStatus("Enter a valid 8-character pairing code (e.g. XXXX-XXXX).", "err");
    return;
  }
  const formatted = formatPairingCode(normalized);
  if (codeInput) codeInput.value = formatted;
  if (pairBtn) pairBtn.disabled = true;
  setStatus("Pairing with local Browser Control daemon...");

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "pairCode",
      code: normalized,
      ...(port ? { port } : {}),
    });
    if (resp && resp.ok) {
      const slug = resp.slug ? ` as ${resp.slug}` : "";
      setStatus(`Paired${slug}. You can close this tab.`, "ok");
    } else {
      setStatus(resp?.error || "Pairing failed. Generate a new code and try again.", "err");
    }
  } catch (err) {
    setStatus(`Pairing failed: ${err?.message || err}`, "err");
  } finally {
    if (pairBtn) pairBtn.disabled = false;
  }
}

if (formEl) {
  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitCode(codeInput?.value || "", undefined);
  });
}

const { code: hashCode, port: hashPort } = parseHashParams(location.hash);
if (hashCode) {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore */
  }
  submitCode(hashCode, hashPort);
}
