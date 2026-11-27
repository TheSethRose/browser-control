const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const handoffBox = document.getElementById("handoffBox");
const handoffMsg = document.getElementById("handoffMsg");
const handoffDoneBtn = document.getElementById("handoffDoneBtn");
const modeAll = document.getElementById("modeAll");
const modeLent = document.getElementById("modeLent");
const lendBtn = document.getElementById("lendBtn");
const detachBtn = document.getElementById("detachBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const tabGroupMode = document.getElementById("tabGroupMode");
const autoCollapse = document.getElementById("autoCollapse");
const idleCleanup = document.getElementById("idleCleanup");
const muteAgentTabs = document.getElementById("muteAgentTabs");
const portInput = document.getElementById("portInput");
const tokenInput = document.getElementById("tokenInput");
const pairBtn = document.getElementById("pairBtn");

let currentTabId = null;
let activeHandoffTabId = null;
let activeHandoffId;

function setIdleSelectValue(minutes) {
  const val = String(minutes === 0 ? 0 : minutes || 30);
  const exists = [...idleCleanup.options].some((o) => o.value === val);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = `${val} min`;
    idleCleanup.appendChild(opt);
  }
  idleCleanup.value = val;
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  currentTabId = s.activeTabId;
  statusEl.textContent = s.connected ? "Connected" : s.hasToken ? "Waiting for relay" : "Not paired";
  statusEl.className = `pill ${s.connected ? "on" : s.hasToken ? "wait" : "off"}`;
  infoEl.textContent = s.connected
    ? ""
    : (s.lastError && s.lastError !== "Waiting for relay" ? s.lastError : `Waiting for relay on 127.0.0.1:49222-49229`);
  infoEl.hidden = s.connected;
  modeAll.setAttribute("aria-pressed", String(s.mode === "all"));
  modeLent.setAttribute("aria-pressed", String(s.mode === "lent"));
  lendBtn.style.display = s.mode === "lent" ? "" : "none";
  lendBtn.textContent = s.activeTabLent ? "Stop sharing this tab" : "Share this tab";
  lendBtn.className = "wide secondary";
  portInput.value = String(s.port || 49222);

  const handoffs = Array.isArray(s.handoffs) ? s.handoffs : [];
  const handoff = handoffs.find((h) => h.tabId === currentTabId) || handoffs[0] || null;
  if (handoff) {
    activeHandoffTabId = handoff.tabId;
    activeHandoffId = handoff.handoffId;
    handoffMsg.textContent = handoff.message || "Complete this step, then click Continue.";
    handoffBox.classList.add("active");
  } else {
    activeHandoffTabId = null;
    handoffBox.classList.remove("active");
  }

  const cfg = s.settings || {};
  tabGroupMode.value = cfg.tabGroupMode === "none" ? "none" : "shared";
  autoCollapse.checked = cfg.autoCollapse !== false;
  setIdleSelectValue(cfg.idleCleanupMinutes ?? 30);
  muteAgentTabs.checked = cfg.muteAgentTabs === true;
}

async function saveSettings(patch) {
  await chrome.runtime.sendMessage({ type: "setSettings", settings: patch });
  await refresh();
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

handoffDoneBtn.addEventListener("click", async () => {
  if (typeof activeHandoffTabId !== "number" || typeof activeHandoffId !== "string") return;
  await chrome.runtime.sendMessage({ type: "completeHandoff", tabId: activeHandoffTabId, handoffId: activeHandoffId });
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

tabGroupMode.addEventListener("change", () => {
  saveSettings({ tabGroupMode: tabGroupMode.value });
});

autoCollapse.addEventListener("change", () => {
  saveSettings({ autoCollapse: autoCollapse.checked });
});

idleCleanup.addEventListener("change", () => {
  saveSettings({ idleCleanupMinutes: Number(idleCleanup.value) });
});

muteAgentTabs.addEventListener("change", () => {
  saveSettings({ muteAgentTabs: muteAgentTabs.checked });
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
