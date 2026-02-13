const NOTE_CLASS = "openai-immersive-translation-note";
const STYLE_ID = "openai-immersive-translation-style";
const SELECTION_PANEL_ID = "openai-immersive-selection-panel";
const SOURCE_TEXT_ATTR = "data-openai-source-text";
const TRANSLATION_ID_ATTR = "data-openai-translation-id";
const TRANSLATED_ATTR = "data-openai-translated";

const PRIMARY_BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th";
const FALLBACK_LEAF_SELECTOR = "div";
const DEFAULT_MAX_PAGE_ITEMS = 220;
const MIN_TEXT_LENGTH = 3;
const BLOCK_LIKE_CHILD_SELECTOR =
  "p,li,h1,h2,h3,h4,h5,h6,blockquote,figcaption,td,th,div,section,article,main,aside,nav,header,footer,ul,ol,table,tr";

let isTranslating = false;

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

function normalizeText(text) {
  if (!text) {
    return "";
  }
  return text.replace(/\s+/g, " ").trim();
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${NOTE_CLASS} {
      margin-top: 0.35em;
      padding-top: 0.35em;
      border-top: 1px dashed rgba(145, 168, 86, 0.45);
      font-size: 0.92em;
      line-height: 1.55;
      color: #2B2B2B;
      white-space: pre-wrap;
      font-family: "Segoe UI", "SF Pro Text", "Hiragino Kaku Gothic ProN", Arial, sans-serif;
    }

    #${SELECTION_PANEL_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      max-width: min(640px, calc(100vw - 32px));
      max-height: 50vh;
      overflow: auto;
      background: #F8F6F2;
      color: #2B2B2B;
      border: 1px solid #E5E0D8;
      border-radius: 8px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.1);
      z-index: 2147483647;
      font-size: 14px;
      line-height: 1.5;
      font-family: "Segoe UI", "SF Pro Text", "Hiragino Kaku Gothic ProN", Arial, sans-serif;
    }

    #${SELECTION_PANEL_ID} header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid #E5E0D8;
      font-weight: 600;
      background: #FFFFFF;
      border-radius: 8px 8px 0 0;
    }

    #${SELECTION_PANEL_ID} .content {
      padding: 14px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    #${SELECTION_PANEL_ID} button {
      border: none;
      background: #91A856;
      color: white;
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: opacity 0.2s;
    }

    #${SELECTION_PANEL_ID} button:hover {
      opacity: 0.9;
    }
  `;

  document.documentElement.appendChild(style);
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isExcluded(element) {
  return Boolean(
    element.closest("script,style,noscript,pre,code,textarea,[contenteditable='true'],svg,math")
  );
}

function isMeaningfulText(text) {
  if (!text || text.length < MIN_TEXT_LENGTH) {
    return false;
  }

  if (isLikelyDataOrCodeBlob(text)) {
    return false;
  }

  // Require at least one letter/number-like symbol to avoid punctuation-only rows.
  return /[\p{L}\p{N}]/u.test(text);
}

function isLikelyDataOrCodeBlob(text) {
  const compact = normalizeText(text);
  if (!compact) {
    return false;
  }

  const braceCount = (compact.match(/[{}\[\]]/g) || []).length;
  if (braceCount >= 6 && /":/.test(compact)) {
    return true;
  }

  if (
    compact.length > 120 &&
    /(function\s*\(|=>|\bconst\b|\blet\b|\bvar\b|\bclass\b|@media|\.css|#include)/.test(compact)
  ) {
    return true;
  }

  if (compact.length > 120) {
    const punctuationCount = (compact.match(/[{}\[\]"'=,:;]/g) || []).length;
    const ratio = punctuationCount / compact.length;
    if (ratio > 0.22 && /:/.test(compact)) {
      return true;
    }
  }

  return false;
}

function hasDirectTranslatableChild(element) {
  for (const child of element.children) {
    if (child.matches && child.matches(PRIMARY_BLOCK_SELECTOR)) {
      return true;
    }
  }
  return false;
}

function hasMeaningfulBlockChild(element) {
  for (const child of element.children) {
    if (!isVisible(child)) {
      continue;
    }
    if (!(child.matches && child.matches(BLOCK_LIKE_CHILD_SELECTOR))) {
      continue;
    }
    const text = normalizeText(child.innerText || "");
    if (isMeaningfulText(text)) {
      return true;
    }
  }
  return false;
}

function getDirectText(element) {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += ` ${node.textContent || ""}`;
    }
  }
  return normalizeText(text);
}

function extractSourceText(element) {
  if (element.hasAttribute(SOURCE_TEXT_ATTR)) {
    return element.getAttribute(SOURCE_TEXT_ATTR) || "";
  }

  const clone = element.cloneNode(true);
  clone.querySelectorAll(`.${NOTE_CLASS}`).forEach((node) => node.remove());
  const text = normalizeText(clone.innerText || "");

  if (text) {
    element.setAttribute(SOURCE_TEXT_ATTR, text);
  }

  return text;
}

function collectTranslatableRows(maxCharsPerItem, maxItems) {
  const rows = [];
  let counter = 0;
  let hitLimit = false;

  function pushRow(element, rawText) {
    const text = normalizeText(rawText);
    if (!isMeaningfulText(text)) {
      return;
    }

    if (rows.length >= maxItems) {
      hitLimit = true;
      return;
    }

    const id = element.getAttribute(TRANSLATION_ID_ATTR) || `node-${++counter}`;
    element.setAttribute(TRANSLATION_ID_ATTR, id);
    element.setAttribute(SOURCE_TEXT_ATTR, text);

    const clipped = text.length > maxCharsPerItem ? `${text.slice(0, maxCharsPerItem)}...` : text;
    rows.push({
      id,
      text: clipped,
      element,
    });
  }

  const primaryNodes = document.querySelectorAll(PRIMARY_BLOCK_SELECTOR);
  for (const element of primaryNodes) {
    if (!element || !element.isConnected) {
      continue;
    }

    if (!isVisible(element)) {
      continue;
    }

    if (isExcluded(element)) {
      continue;
    }

    if (hasDirectTranslatableChild(element)) {
      continue;
    }

    const sourceText = extractSourceText(element);
    pushRow(element, sourceText);
    if (hitLimit) {
      break;
    }
  }

  if (!hitLimit) {
    const fallbackNodes = document.querySelectorAll(FALLBACK_LEAF_SELECTOR);
    for (const element of fallbackNodes) {
      if (!element || !element.isConnected) {
        continue;
      }

      if (!isVisible(element) || isExcluded(element)) {
        continue;
      }

      if (element.matches(PRIMARY_BLOCK_SELECTOR)) {
        continue;
      }

      // Skip nested candidates if an ancestor is already tracked.
      const taggedAncestor = element.closest(`[${TRANSLATION_ID_ATTR}]`);
      if (taggedAncestor && taggedAncestor !== element) {
        continue;
      }

      const directText = getDirectText(element);
      if (isMeaningfulText(directText)) {
        pushRow(element, directText);
      } else {
        if (element.children.length > 3) {
          continue;
        }
        if (hasMeaningfulBlockChild(element)) {
          continue;
        }
        const nestedText = extractSourceText(element);
        pushRow(element, nestedText);
      }

      if (hitLimit) {
        break;
      }
    }
  }

  return { rows, hitLimit };
}

function chunkRows(rows, chunkSize) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function getOrCreateNote(element) {
  for (const child of element.children) {
    if (child.classList && child.classList.contains(NOTE_CLASS)) {
      return child;
    }
  }

  const note = document.createElement("div");
  note.className = NOTE_CLASS;
  element.appendChild(note);
  return note;
}

function applyTranslation(element, translatedText) {
  const note = getOrCreateNote(element);
  note.textContent = translatedText;
  element.setAttribute(TRANSLATED_ATTR, "true");
}

function removeSelectionPanel() {
  const panel = document.getElementById(SELECTION_PANEL_ID);
  if (panel) {
    panel.remove();
  }
}

function showSelectionPanel(original, translated) {
  removeSelectionPanel();

  const panel = document.createElement("section");
  panel.id = SELECTION_PANEL_ID;

  const header = document.createElement("header");
  header.textContent = "Selection Translation";

  const closeButton = document.createElement("button");
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => panel.remove());
  header.appendChild(closeButton);

  const content = document.createElement("div");
  content.className = "content";
  content.textContent = `${original}\n\n${translated}`;

  panel.appendChild(header);
  panel.appendChild(content);
  document.documentElement.appendChild(panel);
}

function restorePage() {
  document.querySelectorAll(`.${NOTE_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATED_ATTR);
  });
  document.querySelectorAll(`[${SOURCE_TEXT_ATTR}]`).forEach((node) => {
    node.removeAttribute(SOURCE_TEXT_ATTR);
  });
  document.querySelectorAll(`[${TRANSLATION_ID_ATTR}]`).forEach((node) => {
    node.removeAttribute(TRANSLATION_ID_ATTR);
  });
  removeSelectionPanel();
}

async function getSettings() {
  const response = await runtimeSend({ type: "get-settings" });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to load settings");
  }
  return response.settings;
}

async function requestTranslation(settings, items) {
  const response = await runtimeSend({
    type: "translate-batch",
    payload: {
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      mode: settings.mode,
      tone: settings.tone,
      model: settings.model,
      batchSize: settings.batchSize,
      maxCharsPerItem: settings.maxCharsPerItem,
      items,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Translation request failed");
  }

  return response;
}

async function translatePage() {
  if (isTranslating) {
    return { ok: false, error: "Translation already in progress" };
  }

  isTranslating = true;

  try {
    ensureStyle();

    const settings = await getSettings();
    const maxPageItems =
      typeof settings.maxPageItems === "number" && Number.isFinite(settings.maxPageItems)
        ? Math.min(Math.max(Math.floor(settings.maxPageItems), 20), 500)
        : DEFAULT_MAX_PAGE_ITEMS;

    const { rows, hitLimit } = collectTranslatableRows(settings.maxCharsPerItem || 1200, maxPageItems);

    if (rows.length === 0) {
      return { ok: true, count: 0, total: 0, message: "No translatable content found" };
    }

    const requestChunkSize = Math.min(Math.max(settings.batchSize || 6, 1), 20);
    const chunks = chunkRows(rows, requestChunkSize);
    const warnings = [];
    let applied = 0;
    let generated = 0;

    for (const chunk of chunks) {
      const payloadItems = chunk.map((row) => ({ id: row.id, text: row.text }));
      const translated = await requestTranslation(settings, payloadItems);
      warnings.push(...(translated.warnings || []));

      const map = new Map();
      for (const result of translated.results || []) {
        if (result && typeof result.id === "string" && typeof result.translatedText === "string") {
          map.set(result.id, result.translatedText);
        }
      }

      for (const row of chunk) {
        const translatedText = map.get(row.id);
        if (!translatedText) {
          continue;
        }
        applyTranslation(row.element, translatedText);
        applied += 1;
      }

      if (translated.meta && typeof translated.meta.generated === "number") {
        generated += translated.meta.generated;
      }
    }

    return {
      ok: true,
      count: applied,
      total: rows.length,
      warnings,
      meta: {
        chunks: chunks.length,
        generated,
        hitLimit,
        maxPageItems,
      },
    };
  } finally {
    isTranslating = false;
  }
}

async function translateSelection() {
  ensureStyle();

  const selection = window.getSelection();
  const sourceText = normalizeText(selection ? selection.toString() : "");
  if (!sourceText) {
    return { ok: false, error: "Select text first" };
  }

  const settings = await getSettings();
  const clipped =
    sourceText.length > settings.maxCharsPerItem
      ? `${sourceText.slice(0, settings.maxCharsPerItem)}...`
      : sourceText;

  const translated = await requestTranslation(settings, [{ id: "selection-1", text: clipped }]);
  const result = (translated.results || [])[0];
  if (!result || typeof result.translatedText !== "string") {
    throw new Error("Bridge returned empty selection translation");
  }

  showSelectionPanel(sourceText, result.translatedText);

  return {
    ok: true,
    translatedText: result.translatedText,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "translate-page": {
        const result = await translatePage();
        sendResponse(result);
        return;
      }

      case "translate-selection": {
        const result = await translateSelection();
        sendResponse(result);
        return;
      }

      case "restore-page": {
        restorePage();
        sendResponse({ ok: true });
        return;
      }

      default:
        sendResponse({ ok: false, error: "Unsupported content action" });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || "Content script error" });
  });

  return true;
});
