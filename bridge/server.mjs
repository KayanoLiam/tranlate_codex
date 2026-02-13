import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8787);
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 120000);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES ?? 2_000_000);

const DEFAULT_BATCH_SIZE = 6;
const DEFAULT_MAX_CHARS = 1200;
const MAX_CACHE_SIZE = 3000;

const TRANSLATION_MODES = new Set(["bilingual", "translation-only"]);
const TRANSLATION_TONES = new Set(["natural", "faithful", "concise"]);

const translationCache = new Map();
let healthSnapshot = null;
let healthSnapshotAt = 0;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function sanitizeOutput(text) {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .filter((line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH"))
    .join("\n")
    .trim();
}

function resolveCorsOrigin(originHeader) {
  if (!originHeader) {
    return "*";
  }

  if (originHeader.startsWith("chrome-extension://")) {
    return originHeader;
  }

  if (originHeader.startsWith("http://127.0.0.1") || originHeader.startsWith("http://localhost")) {
    return originHeader;
  }

  return "null";
}

function setCorsHeaders(req, res) {
  const allowedOrigin = resolveCorsOrigin(req.headers.origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (allowedOrigin !== "*" && allowedOrigin !== "null") {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT_BYTES) {
        reject(createHttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(createHttpError(400, "Invalid JSON body"));
      }
    });

    req.on("error", (error) => {
      reject(createHttpError(400, `Failed to read request body: ${error.message}`));
    });
  });
}

function normalizeItems(rawItems, maxCharsPerItem) {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const items = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const current = rawItems[index];
    if (!current || typeof current !== "object") {
      continue;
    }

    const id =
      typeof current.id === "string" && current.id.trim().length > 0
        ? current.id.trim()
        : `item-${index + 1}`;

    const text = typeof current.text === "string" ? current.text.replace(/\r\n/g, "\n").trim() : "";
    if (!text) {
      continue;
    }

    const clipped = text.length > maxCharsPerItem ? `${text.slice(0, maxCharsPerItem)}...` : text;
    items.push({ id, text: clipped });
  }

  return items;
}

function chunk(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function getToneInstruction(tone) {
  if (tone === "faithful") {
    return "Translate conservatively. Keep sentence structure and terminology close to the source.";
  }

  if (tone === "concise") {
    return "Translate naturally but keep the output concise and compact.";
  }

  return "Translate naturally with fluent target-language phrasing while preserving meaning.";
}

function getModeInstruction(mode) {
  if (mode === "translation-only") {
    return "Only output the translated text without adding source-language fragments.";
  }
  return "Output should read well as bilingual reading support context.";
}

function buildPrompt({ sourceLang, targetLang, tone, mode, items }) {
  const resolvedSource = sourceLang === "auto" ? "auto-detect" : sourceLang;
  const resolvedTarget = targetLang || "zh-CN";

  return [
    "You are a translation engine.",
    `Task: translate text from ${resolvedSource} to ${resolvedTarget}.`,
    getToneInstruction(tone),
    getModeInstruction(mode),
    "Output constraints:",
    "1) Return ONLY strict JSON, no markdown and no extra text.",
    '2) Use exactly this schema: {"results":[{"id":"string","translatedText":"string"}]}',
    "3) Each input id must appear exactly once in results.",
    "4) Preserve URLs, code snippets, numbers, and proper nouns unless translation is clearly needed.",
    "Input:",
    JSON.stringify(items),
  ].join("\n");
}

function tail(text, maxLines = 30) {
  if (!text) {
    return "";
  }
  const lines = text.trim().split("\n");
  return lines.slice(Math.max(lines.length - maxLines, 0)).join("\n");
}

function sliceBalancedJson(text, startIndex) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const open = stack.pop();
      if (!open) {
        return null;
      }
      if ((open === "{" && char !== "}") || (open === "[" && char !== "]")) {
        return null;
      }
      if (stack.length === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractJsonCandidate(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Continue with fallback extraction.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    const fenced = fencedMatch[1].trim();
    try {
      JSON.parse(fenced);
      return fenced;
    } catch {
      // Continue with fallback extraction.
    }
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char !== "{" && char !== "[") {
      continue;
    }

    const candidate = sliceBalancedJson(trimmed, index);
    if (!candidate) {
      continue;
    }

    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep searching.
    }
  }

  return null;
}

function normalizeParsedResults(parsed, batchItems) {
  let rows = [];

  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.results)) {
      rows = parsed.results;
    } else if (Array.isArray(parsed.translations)) {
      rows = parsed.translations;
    }
  }

  const normalized = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (typeof row === "string") {
      const source = batchItems[index];
      if (source) {
        normalized.push({ id: source.id, translatedText: row.trim() });
      }
      continue;
    }

    if (!row || typeof row !== "object") {
      continue;
    }

    const id = typeof row.id === "string" ? row.id : batchItems[index]?.id;
    const translatedText =
      typeof row.translatedText === "string"
        ? row.translatedText
        : typeof row.translation === "string"
        ? row.translation
        : typeof row.text === "string"
        ? row.text
        : "";

    if (id && translatedText.trim()) {
      normalized.push({ id, translatedText: translatedText.trim() });
    }
  }

  return normalized;
}

function parseTranslationOutput(rawOutput, batchItems) {
  const output = (rawOutput || "").trim();
  if (!output) {
    throw new Error("Codex returned empty output");
  }

  const jsonCandidate = extractJsonCandidate(output);
  if (jsonCandidate) {
    const parsed = JSON.parse(jsonCandidate);
    const normalized = normalizeParsedResults(parsed, batchItems);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  if (batchItems.length === 1) {
    return [{ id: batchItems[0].id, translatedText: output.replace(/^"|"$/g, "").trim() }];
  }

  throw new Error(`Unable to parse Codex output as translation JSON. Output tail: ${tail(output, 12)}`);
}

function setCacheValue(key, value) {
  if (translationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = translationCache.keys().next().value;
    if (firstKey) {
      translationCache.delete(firstKey);
    }
  }
  translationCache.set(key, value);
}

async function runProcess(command, args, { input, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({ code, stdout, stderr, timedOut });
    });

    if (typeof input === "string") {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function runCodexTranslation(prompt, model) {
  const tempDir = await mkdtemp(join(tmpdir(), "openai-translate-"));
  const outputPath = join(tempDir, "last-message.txt");

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "-o",
    outputPath,
  ];

  if (model) {
    args.push("-m", model);
  }

  args.push("-");

  try {
    const runResult = await runProcess(CODEX_BIN, args, { input: prompt });

    let lastMessage = "";
    try {
      lastMessage = await readFile(outputPath, "utf8");
    } catch {
      // The output file may be missing if Codex failed early.
    }

    return {
      ...runResult,
      lastMessage: sanitizeOutput(lastMessage),
      cleanStdout: sanitizeOutput(runResult.stdout),
      cleanStderr: sanitizeOutput(runResult.stderr),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function getHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && healthSnapshot && now - healthSnapshotAt < 10_000) {
    return healthSnapshot;
  }

  const snapshot = {
    ok: false,
    codexInstalled: false,
    codexVersion: null,
    loggedIn: false,
    loginMessage: null,
  };

  try {
    const versionResult = await runProcess(CODEX_BIN, ["--version"], { timeoutMs: 10_000 });
    if (versionResult.code === 0) {
      snapshot.codexInstalled = true;
      snapshot.codexVersion = sanitizeOutput(versionResult.stdout) || sanitizeOutput(versionResult.stderr);
    }
  } catch (error) {
    snapshot.loginMessage = `Failed to run codex: ${error.message}`;
    healthSnapshot = snapshot;
    healthSnapshotAt = Date.now();
    return snapshot;
  }

  try {
    const loginResult = await runProcess(CODEX_BIN, ["login", "status"], { timeoutMs: 20_000 });
    const combined = sanitizeOutput(`${loginResult.stdout}\n${loginResult.stderr}`);
    snapshot.loginMessage = combined || "No login status returned";
    snapshot.loggedIn = /logged in/i.test(combined) && !/not logged in/i.test(combined);
  } catch (error) {
    snapshot.loginMessage = `Failed to check login status: ${error.message}`;
  }

  snapshot.ok = snapshot.codexInstalled && snapshot.loggedIn;
  healthSnapshot = snapshot;
  healthSnapshotAt = Date.now();
  return snapshot;
}

function cacheKey(item, options) {
  return [
    options.sourceLang,
    options.targetLang,
    options.model || "",
    options.mode,
    options.tone,
    item.text,
  ].join("\u0001");
}

async function translateBatch(options) {
  const resultById = new Map();
  const pending = [];
  let cacheHits = 0;

  for (const item of options.items) {
    const key = cacheKey(item, options);
    if (translationCache.has(key)) {
      resultById.set(item.id, translationCache.get(key));
      cacheHits += 1;
      continue;
    }
    pending.push(item);
  }

  const warnings = [];
  const batches = chunk(pending, options.batchSize);

  for (const batch of batches) {
    const prompt = buildPrompt({
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      tone: options.tone,
      mode: options.mode,
      items: batch,
    });

    const codexResult = await runCodexTranslation(prompt, options.model);

    if (codexResult.timedOut) {
      throw createHttpError(504, "Codex request timed out");
    }

    if (codexResult.code !== 0 && !codexResult.lastMessage && !codexResult.cleanStdout) {
      const details = tail(codexResult.cleanStderr || codexResult.stderr || "", 20);
      throw createHttpError(502, `Codex exec failed (exit ${codexResult.code}). ${details}`);
    }

    let parsedRows;
    try {
      parsedRows = parseTranslationOutput(codexResult.lastMessage || codexResult.cleanStdout, batch);
    } catch (error) {
      const details = tail(codexResult.cleanStderr || codexResult.stderr || "", 12);
      throw createHttpError(502, `${error.message}${details ? ` | stderr: ${details}` : ""}`);
    }

    const parsedById = new Map(parsedRows.map((row) => [row.id, row.translatedText]));

    for (const item of batch) {
      const translated = parsedById.get(item.id);
      if (!translated) {
        warnings.push(`Missing translation for id=${item.id}; falling back to source text.`);
        resultById.set(item.id, item.text);
        continue;
      }

      resultById.set(item.id, translated);
      setCacheValue(cacheKey(item, options), translated);
    }
  }

  const results = options.items.map((item) => ({
    id: item.id,
    translatedText: resultById.get(item.id) || item.text,
  }));

  return {
    results,
    warnings,
    meta: {
      provider: "openai-codex-auth",
      model: options.model || "default",
      total: options.items.length,
      cacheHits,
      generated: options.items.length - cacheHits,
    },
  };
}

async function handleHealth(res) {
  const health = await getHealth({ force: true });
  writeJson(res, health.ok ? 200 : 503, health);
}

async function handleTranslate(req, res) {
  const requestStartedAt = Date.now();
  const body = await readJsonBody(req);

  const sourceLang = typeof body.sourceLang === "string" ? body.sourceLang : "auto";
  const targetLang = typeof body.targetLang === "string" ? body.targetLang : "zh-CN";
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "";

  const mode = TRANSLATION_MODES.has(body.mode) ? body.mode : "bilingual";
  const tone = TRANSLATION_TONES.has(body.tone) ? body.tone : "natural";
  const batchSize = clampNumber(body.batchSize, 1, 20, DEFAULT_BATCH_SIZE);
  const maxCharsPerItem = clampNumber(body.maxCharsPerItem, 100, 5000, DEFAULT_MAX_CHARS);

  const items = normalizeItems(body.items, maxCharsPerItem);
  if (items.length === 0) {
    throw createHttpError(400, "No translatable items were provided");
  }

  console.log(
    `[translate] items=${items.length} source=${sourceLang} target=${targetLang} batchSize=${batchSize} model=${
      model || "default"
    }`
  );

  const health = await getHealth();
  if (!health.codexInstalled) {
    throw createHttpError(503, "codex CLI is not available. Install Codex CLI first.");
  }
  if (!health.loggedIn) {
    throw createHttpError(
      503,
      "OpenAI auth is not ready. Run `codex login` in terminal and complete ChatGPT sign-in."
    );
  }

  const translated = await translateBatch({
    sourceLang,
    targetLang,
    model,
    mode,
    tone,
    batchSize,
    items,
  });

  writeJson(res, 200, {
    ok: true,
    ...translated,
  });

  console.log(
    `[translate] done items=${items.length} generated=${translated.meta.generated} cacheHits=${translated.meta.cacheHits} durationMs=${
      Date.now() - requestStartedAt
    }`
  );
}

const server = createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const baseUrl = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const { pathname } = new URL(req.url || "/", baseUrl);

  try {
    if (req.method === "GET" && pathname === "/") {
      writeJson(res, 200, {
        ok: true,
        service: "openai-auth-translate-bridge",
        endpoints: ["GET /health", "POST /translate-batch"],
      });
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      await handleHealth(res);
      return;
    }

    if (req.method === "POST" && pathname === "/translate-batch") {
      await handleTranslate(req, res);
      return;
    }

    writeJson(res, 404, { ok: false, error: "Not Found" });
  } catch (error) {
    console.error(`[bridge-error] ${error.message || "Unknown error"}`);
    const statusCode = error.statusCode || 500;
    writeJson(res, statusCode, {
      ok: false,
      error: error.message || "Internal server error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Bridge running at http://${HOST}:${PORT}`);
  console.log(`Using codex binary: ${CODEX_BIN}`);
});
