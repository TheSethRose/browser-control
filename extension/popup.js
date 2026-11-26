const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const modeAll = document.getElementById("modeAll");
const modeLent = document.getElementById("modeLent");
const lendBtn = document.getElementById("lendBtn");
const detachBtn = document.getElementById("detachBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const portInput = document.getElementById("portInput");
const tokenInput = document.getElementById("tokenInput");
const pairBtn = document.getElementById("pairBtn");

let currentTabId = null;

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  currentTabId = s.activeTabId;
  statusEl.textContent = s.connected ? "Connected" : s.hasToken ? "Waiting for relay" : "Not paired";
  statusEl.className = `pill ${s.connected ? "on" : "off"}`;
  infoEl.textContent = s.connected
    ? `Paired on 127.0.0.1:${s.port}. ${s.attachedCount} tab(s) with debugger attached.`
    : (s.lastError && s.lastError !== "Waiting for relay" ? s.lastError : `Waiting for relay on 127.0.0.1:${s.port}`);
  modeAll.className = s.mode === "all" ? "primary" : "";
  modeLent.className = s.mode === "lent" ? "primary" : "";
  lendBtn.style.display = s.mode === "lent" ? "block" : "none";
  lendBtn.textContent = s.activeTabLent ? "Revoke this tab" : "Lend this tab";
  portInput.value = String(s.port || 49222);
}

modeAll.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "setMode", mode: "all" });
  await refresh();
});

modeLent.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "setMode", mode: "lent" });
  await refresh();
});

lendBtn.addEventListener("click", async () => {
  if (typeof currentTabId !== "number") return;
  await chrome.runtime.sendMessage({ type: "toggleLend", tabId: currentTabId });
  await refresh();
});

detachBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "detachAll" });
  await refresh();
});

reconnectBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(refresh, 300);
});

pairBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "pair",
    port: Number(portInput.value) || 49222,
    token: tokenInput.value.trim(),
  });
  tokenInput.value = "";
  setTimeout(refresh, 300);
});

refresh();
