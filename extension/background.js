const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:8787",
  sourceLang: "auto",
  targetLang: "zh-CN",
  mode: "bilingual",
  tone: "natural",
  model: "",
  batchSize: 6,
  maxCharsPerItem: 1200,
  maxPageItems: 220,
};

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function normalizeInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSettings(input) {
  const current = input || {};
  return {
    bridgeUrl:
      typeof current.bridgeUrl === "string" && current.bridgeUrl.trim()
        ? current.bridgeUrl.trim().replace(/\/$/, "")
        : DEFAULT_SETTINGS.bridgeUrl,
    sourceLang:
      typeof current.sourceLang === "string" && current.sourceLang.trim()
        ? current.sourceLang.trim()
        : DEFAULT_SETTINGS.sourceLang,
    targetLang:
      typeof current.targetLang === "string" && current.targetLang.trim()
        ? current.targetLang.trim()
        : DEFAULT_SETTINGS.targetLang,
    mode: current.mode === "translation-only" ? "translation-only" : "bilingual",
    tone:
      current.tone === "faithful" || current.tone === "concise" ? current.tone : DEFAULT_SETTINGS.tone,
    model: typeof current.model === "string" ? current.model.trim() : "",
    batchSize: normalizeInt(current.batchSize, DEFAULT_SETTINGS.batchSize, 1, 20),
    maxCharsPerItem: normalizeInt(current.maxCharsPerItem, DEFAULT_SETTINGS.maxCharsPerItem, 100, 5000),
    maxPageItems: normalizeInt(current.maxPageItems, DEFAULT_SETTINGS.maxPageItems, 20, 500),
  };
}

async function getSettings() {
  const stored = await storageGet(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

async function saveSettings(newSettings) {
  const normalized = normalizeSettings(newSettings);
  await storageSet(normalized);
  return normalized;
}

async function fetchJson(url, options = {}, timeoutMs = 90000, allowNonOk = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const rawText = await response.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { raw: rawText };
    }

    if (!response.ok && !allowNonOk) {
      const message = data && data.error ? data.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    return {
      ...data,
      _httpStatus: response.status,
      _httpOk: response.ok,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getBridgeHealth(bridgeUrlOverride) {
  const settings = await getSettings();
  const bridgeUrl =
    typeof bridgeUrlOverride === "string" && bridgeUrlOverride.trim()
      ? bridgeUrlOverride.trim().replace(/\/$/, "")
      : settings.bridgeUrl;

  const health = await fetchJson(`${bridgeUrl}/health`, { method: "GET" }, 30000, true);
  return {
    bridgeUrl,
    health,
  };
}

async function requestTranslation(payload = {}) {
  const settings = await getSettings();
  const bridgeUrl = settings.bridgeUrl;

  const requestBody = {
    sourceLang: payload.sourceLang || settings.sourceLang,
    targetLang: payload.targetLang || settings.targetLang,
    mode: payload.mode || settings.mode,
    tone: payload.tone || settings.tone,
    model: payload.model || settings.model,
    batchSize: payload.batchSize || settings.batchSize,
    maxCharsPerItem: payload.maxCharsPerItem || settings.maxCharsPerItem,
    items: Array.isArray(payload.items) ? payload.items : [],
  };

  return fetchJson(
    `${bridgeUrl}/translate-batch`,
    {
      method: "POST",
      body: JSON.stringify(requestBody),
    },
    180000
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const current = await storageGet(DEFAULT_SETTINGS);
    const normalized = normalizeSettings({ ...DEFAULT_SETTINGS, ...current });
    await storageSet(normalized);
  } catch (error) {
    console.error("Failed to initialize settings:", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "ping":
        sendResponse({ ok: true, message: "pong" });
        return;

      case "get-settings": {
        const settings = await getSettings();
        sendResponse({ ok: true, settings });
        return;
      }

      case "save-settings": {
        const settings = await saveSettings(message.settings || {});
        sendResponse({ ok: true, settings });
        return;
      }

      case "bridge-health": {
        const result = await getBridgeHealth(message.bridgeUrl);
        sendResponse({ ok: true, ...result });
        return;
      }

      case "translate-batch": {
        const translated = await requestTranslation(message.payload || {});
        sendResponse(translated);
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unsupported message type" });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || "Unexpected error" });
  });

  return true;
});
