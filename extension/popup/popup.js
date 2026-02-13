const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const resultText = document.getElementById("resultText");

const translatePageBtn = document.getElementById("translatePageBtn");
const translateSelectionBtn = document.getElementById("translateSelectionBtn");
const restoreBtn = document.getElementById("restoreBtn");
const refreshStatusBtn = document.getElementById("refreshStatusBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");

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

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function executeScript(tabId, files) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files,
      },
      () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      }
    );
  });
}

function setBusy(isBusy) {
  translatePageBtn.disabled = isBusy;
  translateSelectionBtn.disabled = isBusy;
  restoreBtn.disabled = isBusy;
}

function setResult(text, isError = false) {
  resultText.textContent = text;
  resultText.style.color = isError ? "#D65F5F" : "#2B2B2B";
  resultText.style.display = text ? "block" : "none";
}

function setStatus(kind, text) {
  statusBadge.className = `badge ${kind}`;
  statusBadge.textContent = kind === "ok" ? "Ready" : kind === "error" ? "Error" : "Checking";
  statusText.textContent = text;
}

async function getActiveTabId() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  if (!tabs[0] || typeof tabs[0].id !== "number") {
    throw new Error("No active tab found");
  }
  return tabs[0].id;
}

async function callActiveTab(message) {
  const tabId = await getActiveTabId();
  let response;
  try {
    response = await sendTabMessage(tabId, message);
  } catch (error) {
    const recoverable =
      error.message.includes("Receiving end does not exist") ||
      error.message.includes("Could not establish connection");

    if (!recoverable) {
      throw error;
    }

    await executeScript(tabId, ["content.js"]);
    response = await sendTabMessage(tabId, message);
  }

  if (!response?.ok) {
    throw new Error(response?.error || "Tab action failed");
  }
  return response;
}

async function refreshStatus() {
  setStatus("pending", "Checking bridge...");

  try {
    const response = await runtimeSend({ type: "bridge-health" });
    if (!response?.ok) {
      throw new Error(response?.error || "Bridge check failed");
    }

    const health = response.health;
    if (health.ok) {
      setStatus("ok", `Connected (${health.loginMessage || "OpenAI auth ready"})`);
    } else {
      const message = health.loginMessage || "Bridge unavailable";
      setStatus("error", message);
    }
  } catch (error) {
    setStatus("error", error.message);
  }
}

async function handleTranslatePage() {
  setBusy(true);
  setResult("Translating page...");

  try {
    const response = await callActiveTab({ type: "translate-page" });
    const suffix = response.meta?.chunks ? ` in ${response.meta.chunks} chunks` : "";
    const capped =
      response.meta?.hitLimit && response.meta?.maxPageItems
        ? ` (hit page limit ${response.meta.maxPageItems})`
        : "";
    setResult(`Translated ${response.count}/${response.total} blocks${suffix}${capped}`);
  } catch (error) {
    if (error.message.includes("Translation already in progress")) {
      setResult("Previous translation is still running. Please wait for it to finish.", true);
    } else {
      setResult(error.message, true);
    }
  } finally {
    setBusy(false);
  }
}

async function handleTranslateSelection() {
  setBusy(true);
  setResult("Translating selection...");

  try {
    await callActiveTab({ type: "translate-selection" });
    setResult("Selection translated. See floating panel on page.");
  } catch (error) {
    setResult(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function handleRestore() {
  setBusy(true);

  try {
    await callActiveTab({ type: "restore-page" });
    setResult("Page restored");
  } catch (error) {
    setResult(error.message, true);
  } finally {
    setBusy(false);
  }
}

translatePageBtn.addEventListener("click", handleTranslatePage);
translateSelectionBtn.addEventListener("click", handleTranslateSelection);
restoreBtn.addEventListener("click", handleRestore);
refreshStatusBtn.addEventListener("click", refreshStatus);
openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

refreshStatus();
