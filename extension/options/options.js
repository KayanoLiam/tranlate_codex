const bridgeUrlInput = document.getElementById("bridgeUrl");
const sourceLangInput = document.getElementById("sourceLang");
const targetLangInput = document.getElementById("targetLang");
const modelInput = document.getElementById("model");
const modeInput = document.getElementById("mode");
const toneInput = document.getElementById("tone");
const batchSizeInput = document.getElementById("batchSize");
const maxCharsPerItemInput = document.getElementById("maxCharsPerItem");
const maxPageItemsInput = document.getElementById("maxPageItems");

const settingsForm = document.getElementById("settingsForm");
const testBtn = document.getElementById("testBtn");
const statusText = document.getElementById("statusText");

function runtimeSend(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "#b24b30" : "#1d2f3b";
}

function toInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function readFormSettings() {
  return {
    bridgeUrl: bridgeUrlInput.value.trim() || "http://127.0.0.1:8787",
    sourceLang: sourceLangInput.value.trim() || "auto",
    targetLang: targetLangInput.value.trim() || "zh-CN",
    model: modelInput.value.trim(),
    mode: modeInput.value === "translation-only" ? "translation-only" : "bilingual",
    tone: ["natural", "faithful", "concise"].includes(toneInput.value) ? toneInput.value : "natural",
    batchSize: toInt(batchSizeInput.value, 6, 1, 20),
    maxCharsPerItem: toInt(maxCharsPerItemInput.value, 1200, 100, 5000),
    maxPageItems: toInt(maxPageItemsInput.value, 220, 20, 500),
  };
}

function fillForm(settings) {
  bridgeUrlInput.value = settings.bridgeUrl || "http://127.0.0.1:8787";
  sourceLangInput.value = settings.sourceLang || "auto";
  targetLangInput.value = settings.targetLang || "zh-CN";
  modelInput.value = settings.model || "";
  modeInput.value = settings.mode || "bilingual";
  toneInput.value = settings.tone || "natural";
  batchSizeInput.value = String(settings.batchSize || 6);
  maxCharsPerItemInput.value = String(settings.maxCharsPerItem || 1200);
  maxPageItemsInput.value = String(settings.maxPageItems || 220);
}

async function loadSettings() {
  const response = await runtimeSend({ type: "get-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load settings");
  }
  fillForm(response.settings);
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const settings = readFormSettings();
    const response = await runtimeSend({
      type: "save-settings",
      settings,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to save settings");
    }

    fillForm(response.settings);
    setStatus("Settings saved");
  } catch (error) {
    setStatus(error.message, true);
  }
});

testBtn.addEventListener("click", async () => {
  try {
    const bridgeUrl = bridgeUrlInput.value.trim() || "http://127.0.0.1:8787";
    const response = await runtimeSend({ type: "bridge-health", bridgeUrl });

    if (!response?.ok) {
      throw new Error(response?.error || "Bridge health check failed");
    }

    if (response.health?.ok) {
      setStatus(`Bridge OK: ${response.health.loginMessage || "OpenAI auth ready"}`);
    } else {
      setStatus(`Bridge not ready: ${response.health?.loginMessage || "Unknown error"}`, true);
    }
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadSettings().catch((error) => {
  setStatus(error.message, true);
});
