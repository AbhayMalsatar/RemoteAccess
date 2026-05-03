const hostSessionCodeInput = document.getElementById("hostSessionCode");
const viewerSessionCodeInput = document.getElementById("viewerSessionCode");
const hostBtn = document.getElementById("hostBtn");
const viewerBtn = document.getElementById("viewerBtn");
const connectBtn = document.getElementById("connectBtn");
const newKeyBtn = document.getElementById("newKeyBtn");
const copyKeyBtn = document.getElementById("copyKeyBtn");
const toastEl = document.getElementById("toast");

function randomSessionKey() {
  return String(Math.floor(Math.random() * 100000000)).padStart(8, "0");
}

function showToast(text, isError = true) {
  toastEl.textContent = text || "";
  toastEl.style.color = isError ? "#e87171" : "#7cb97c";
}

async function saveState() {
  await chrome.storage.local.set({
    hostSessionCode: hostSessionCodeInput.value.trim(),
    viewerSessionCode: viewerSessionCodeInput.value.trim()
  });
}

async function loadState() {
  const { hostSessionCode = "", viewerSessionCode = "" } = await chrome.storage.local.get([
    "hostSessionCode",
    "viewerSessionCode"
  ]);
  hostSessionCodeInput.value = hostSessionCode || randomSessionKey();
  viewerSessionCodeInput.value = viewerSessionCode;
  if (!hostSessionCode) {
    await saveState();
  }
}

function buildPageUrl(page, sessionKey) {
  const url = new URL(chrome.runtime.getURL(page));
  url.searchParams.set("sessionKey", sessionKey);
  return url.toString();
}

newKeyBtn.addEventListener("click", async () => {
  hostSessionCodeInput.value = randomSessionKey();
  await saveState();
  showToast("New code generated.", false);
});

copyKeyBtn.addEventListener("click", async () => {
  const key = hostSessionCodeInput.value.trim();
  if (!key) {
    showToast("No code to copy.");
    return;
  }
  try {
    await navigator.clipboard.writeText(key);
    showToast("Copied.", false);
  } catch {
    showToast("Could not copy.");
  }
});

hostBtn.addEventListener("click", async () => {
  showToast("");
  const sessionKey = hostSessionCodeInput.value.trim();
  if (!/^\d{8}$/.test(sessionKey)) {
    showToast("Invalid host code. Generate 8 digits.");
    return;
  }
  viewerSessionCodeInput.value = sessionKey;
  await saveState();
  const hostUrl = buildPageUrl("host.html", sessionKey);
  await chrome.tabs.create({ url: hostUrl });
  window.close();
});

viewerBtn.addEventListener("click", async () => {
  showToast("");
  const sessionKey = viewerSessionCodeInput.value.trim();
  if (!/^\d{8}$/.test(sessionKey)) {
    showToast("Enter host 8 digit session code.");
    return;
  }
  await saveState();
  const viewerUrl = buildPageUrl("viewer.html", sessionKey);
  await chrome.tabs.create({ url: viewerUrl });
  window.close();
});

connectBtn.addEventListener("click", async () => {
  showToast("");
  const sessionKey = viewerSessionCodeInput.value.trim();
  if (!/^\d{8}$/.test(sessionKey)) {
    showToast("Enter valid 8 digit session code.");
    return;
  }
  await saveState();
  const viewerUrl = buildPageUrl("viewer.html", sessionKey);
  await chrome.tabs.create({ url: viewerUrl });
  window.close();
});

loadState();
