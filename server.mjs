import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PAGE_PATH = resolve(ROOT, "bim-ai-video-studio-preview.html");
const MAX_JSON_BYTES = 22 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const ASPECTS = new Set(["9:16", "16:9", "1:1"]);
const VIDEO_SOURCES = new Set([
  "pexels",
  "pixabay",
  "coverr",
  "wavespeed",
  "volcengine_seedance",
  "ofox",
  "infistar",
  "jalapeno",
  "metaso_minimax",
  "muapi",
  "openai_image",
  "codex_image",
]);
const IMAGE_TYPES = new Map([
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/png", [".png"]],
  ["image/bmp", [".bmp"]],
]);
const SUBTITLE_POSITIONS = new Set(["top", "center", "bottom", "two_thirds_bottom"]);
const SUBTITLE_DISPLAY_MODES = new Set(["sentence", "word_by_word"]);
const SUBTITLE_ANIMATIONS = new Set(["none", "pop_spring"]);
const VIDEO_PROVIDERS = [
  { id: "pexels", label: "Pexels", cost: "free-tier", local: false, setup: "Requires a Pexels API key on the engine host; quotas and license terms apply." },
  { id: "pixabay", label: "Pixabay", cost: "free-tier", local: false, setup: "Requires a Pixabay API key on the engine host; quotas and license terms apply." },
  { id: "coverr", label: "Coverr", cost: "review", local: false, setup: "Review current API access, quota, and footage license terms before use." },
  { id: "wavespeed", label: "WaveSpeed AI", cost: "paid", local: false, setup: "Paid video generation; configure its provider key on the engine host." },
  { id: "volcengine_seedance", label: "Volcengine Seedance", cost: "paid", local: false, setup: "Paid video generation; configure its provider key on the engine host." },
  { id: "ofox", label: "Ofox", cost: "paid", local: false, setup: "Paid video generation; configure its provider key on the engine host." },
  { id: "infistar", label: "Infistar", cost: "paid", local: false, setup: "Provider pricing applies; configure and review terms on the engine host." },
  { id: "jalapeno", label: "Jalapeno", cost: "paid", local: false, setup: "Provider pricing applies; configure and review terms on the engine host." },
  { id: "metaso_minimax", label: "Metaso MiniMax", cost: "paid", local: false, setup: "Paid video generation; configure its provider key on the engine host." },
  { id: "muapi", label: "MuAPI", cost: "paid", local: false, setup: "Paid video generation; configure its provider key on the engine host." },
  { id: "openai_image", label: "OpenAI-compatible image", cost: "review", local: false, setup: "Configurable endpoint may be local or cloud; verify its URL, pricing, and terms." },
  { id: "codex_image", label: "Codex image", cost: "review", local: false, setup: "Account eligibility and subscription terms apply; review before enabling." },
];
const DEFAULT_ENABLED_PROVIDERS = Object.fromEntries(
  VIDEO_PROVIDERS.map(({ id, cost }) => [id, cost === "free-tier"]),
);

function defaultSettings(apiKey = "") {
  return {
    llmProvider: "ollama",
    subtitleProvider: "edge",
    engineLlmConfigured: false,
    engineSubtitleConfigured: false,
    defaultVideoProvider: "pexels",
    enabledProviders: { ...DEFAULT_ENABLED_PROVIDERS },
    allowPaidProviders: false,
    dailyVideoLimit: 5,
    dailyPaidLimit: 0,
    moneyPrinterApiKey: apiKey,
  };
}

function loadLocalState(dataDir, apiKey) {
  const settingsPath = resolve(dataDir, "provider-settings.json");
  if (!existsSync(settingsPath)) {
    return { settings: defaultSettings(apiKey), usage: [] };
  }
  let saved;
  try {
    saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read local provider settings at ${settingsPath}: ${error.message}`);
  }
  const settings = { ...defaultSettings(apiKey), ...saved.settings };
  settings.enabledProviders = {
    ...DEFAULT_ENABLED_PROVIDERS,
    ...(saved.settings?.enabledProviders || {}),
  };
  settings.moneyPrinterApiKey = apiKey || settings.moneyPrinterApiKey || "";
  const usage = Array.isArray(saved.usage) ? saved.usage : [];
  return { settings, usage };
}

function loadDotEnv() {
  let contents;
  try {
    contents = readFileSync(resolve(ROOT, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadDotEnv();

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

function errorMessage(payload, status) {
  if (typeof payload?.detail === "string") return payload.detail;
  if (typeof payload?.message === "string") return payload.message;
  return `Video engine returned HTTP ${status}`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error("Request body exceeds the allowed size.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const error = new Error("Request body must be a JSON object.");
      error.status = 400;
      throw error;
    }
    return body;
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validImageSignature(type, bytes) {
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return type === "image/bmp" && bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM";
}

function validateImage(input) {
  if (!input || typeof input !== "object") throw new Error("Image upload is required.");
  if (typeof input.name !== "string" || input.name.length > 180) {
    throw new Error("Image filename is invalid.");
  }
  const extension = extname(input.name).toLowerCase();
  const allowedExtensions = IMAGE_TYPES.get(input.type);
  if (!allowedExtensions?.includes(extension)) {
    throw new Error("Only JPEG, PNG, and BMP images are supported by the video engine.");
  }
  if (typeof input.data !== "string" || input.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8) {
    throw new Error("Image exceeds the 15 MB limit or has invalid data.");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
    throw new Error("Image data must be valid base64.");
  }
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !validImageSignature(input.type, bytes)) {
    throw new Error("Image is empty, too large, or does not match its declared file type.");
  }
  return { bytes, extension };
}

function rewriteTaskFiles(payload, upstreamBase) {
  const base = new URL(upstreamBase);
  const fileKeys = new Set(["videos", "combined_videos", "audio_file", "subtitle_path"]);
  const rewrite = (value) => {
    if (typeof value !== "string") return value;
    let path;
    try {
      const parsed = new URL(value, base);
      if (!["http:", "https:"].includes(parsed.protocol)) return value;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return value;
    }
    if (!path.startsWith("/tasks/")) return value;
    return `/api/files?path=${encodeURIComponent(path)}`;
  };
  const visit = (value) => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = fileKeys.has(key)
        ? Array.isArray(child)
          ? child.map(rewrite)
          : rewrite(child)
        : visit(child);
    }
    return result;
  };
  return visit(payload);
}

export function createAppServer({
  upstreamUrl = process.env.MONEYPRINTERTURBO_URL || "http://127.0.0.1:8080",
  apiKey = process.env.MONEYPRINTERTURBO_API_KEY || "",
  dataDir = process.env.BIM_DATA_DIR || resolve(ROOT, ".local-data"),
  ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  appApiBaseUrl = process.env.APP_API_BASE_URL || "",
  corsOrigins = process.env.APP_CORS_ORIGINS || "",
  fetchImpl = fetch,
} = {}) {
  let upstream;
  try {
    upstream = new URL(upstreamUrl);
    if (!["http:", "https:"].includes(upstream.protocol)) throw new Error();
  } catch {
    throw new Error("MONEYPRINTERTURBO_URL must be an HTTP(S) URL.");
  }
  let ollama;
  try {
    ollama = new URL(ollamaUrl);
    if (
      ollama.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "::1"].includes(ollama.hostname)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("OLLAMA_URL must be a local HTTP URL (127.0.0.1, localhost, or ::1).");
  }
  if (appApiBaseUrl) {
    let apiBase;
    try {
      apiBase = new URL(appApiBaseUrl);
      if (!["http:", "https:"].includes(apiBase.protocol) || apiBase.username || apiBase.password) throw new Error();
    } catch {
      throw new Error("APP_API_BASE_URL must be an HTTP(S) URL without credentials.");
    }
  }
  const allowedOrigins = new Set(corsOrigins.split(",").map((origin) => origin.trim()).filter(Boolean));
  const resolvedDataDir = resolve(dataDir);
  const settingsPath = resolve(resolvedDataDir, "provider-settings.json");
  const envApiKey = apiKey;
  const localState = loadLocalState(resolvedDataDir, envApiKey);
  let currentApiKey = envApiKey || localState.settings.moneyPrinterApiKey || "";

  function persistState() {
    mkdirSync(resolvedDataDir, { recursive: true, mode: 0o700 });
    chmodSync(resolvedDataDir, 0o700);
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify(
        {
          settings: { ...localState.settings, moneyPrinterApiKey: envApiKey || currentApiKey },
          usage: localState.usage.slice(-1000),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, settingsPath);
    chmodSync(settingsPath, 0o600);
  }

  function todayUsage() {
    const today = new Date().toISOString().slice(0, 10);
    return localState.usage.filter((entry) => entry.date === today);
  }

  function usageSummary() {
    const entries = todayUsage();
    return {
      date: new Date().toISOString().slice(0, 10),
      videoUnits: entries.filter((entry) => entry.kind === "video").reduce((sum, entry) => sum + entry.units, 0),
      paidUnits: entries.filter((entry) => entry.paid).reduce((sum, entry) => sum + entry.units, 0),
      requestCount: entries.length,
      recent: localState.usage.slice(-30).reverse().map(({ id, at, provider, kind, units, paid, status }) => ({
        id, at, provider, kind, units, paid, status,
      })),
    };
  }

  function reserveUsage({ provider, kind, units = 1, paid = false, confirmed = false }) {
    const daily = todayUsage();
    const videoUnits = daily.filter((entry) => entry.kind === "video").reduce((sum, entry) => sum + entry.units, 0);
    if (kind === "video" && videoUnits + units > localState.settings.dailyVideoLimit) {
      return { error: `Daily video limit reached (${localState.settings.dailyVideoLimit} clips). Change the limit in Provider Settings to continue.` };
    }
    if (paid) {
      if (!localState.settings.allowPaidProviders) {
        return { error: "Paid/review-required providers are disabled. Enable them explicitly in Provider Settings first." };
      }
      if (!confirmed) {
        return { error: "Explicit confirmation is required before a paid/review-required provider request." };
      }
      const paidUnits = daily.filter((entry) => entry.paid).reduce((sum, entry) => sum + entry.units, 0);
      if (localState.settings.dailyPaidLimit < 1 || paidUnits + units > localState.settings.dailyPaidLimit) {
        return { error: `Paid usage limit reached (${localState.settings.dailyPaidLimit} units/day). Increase it explicitly in Provider Settings.` };
      }
    }
    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10),
      provider,
      kind,
      units,
      paid,
      status: "reserved",
    };
    localState.usage.push(entry);
    persistState();
    return { entry };
  }

  function finishUsage(entry, status) {
    entry.status = status;
    persistState();
  }

  function publicProviderSettings() {
    return {
      llmProvider: localState.settings.llmProvider,
      subtitleProvider: localState.settings.subtitleProvider,
      engineLlmConfigured: localState.settings.engineLlmConfigured,
      engineSubtitleConfigured: localState.settings.engineSubtitleConfigured,
      defaultVideoProvider: localState.settings.defaultVideoProvider,
      enabledProviders: { ...localState.settings.enabledProviders },
      allowPaidProviders: localState.settings.allowPaidProviders,
      dailyVideoLimit: localState.settings.dailyVideoLimit,
      dailyPaidLimit: localState.settings.dailyPaidLimit,
      hasMoneyPrinterApiKey: Boolean(currentApiKey),
      engineApiKeyManagedByEnvironment: Boolean(envApiKey),
      usage: usageSummary(),
    };
  }

  async function callUpstream(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (currentApiKey) headers.set("x-api-key", currentApiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await fetchImpl(new URL(path, upstream), {
        ...options,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function proxyJson(response, outgoing, { rewriteFiles = false } = {}) {
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      sendJson(outgoing, 502, { error: "The video engine returned an invalid JSON response." });
      return;
    }
    if (rewriteFiles) payload = rewriteTaskFiles(payload, upstream);
    if (!response.ok) {
      sendJson(outgoing, response.status, { error: errorMessage(payload, response.status), upstream: payload });
      return;
    }
    sendJson(outgoing, response.status, payload);
  }

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      const requestOrigin = request.headers.origin;
      if (allowedOrigins.size && requestOrigin) {
        if (!allowedOrigins.has(requestOrigin)) {
          sendJson(response, 403, { error: "This browser origin is not allowed." });
          return;
        }
        response.setHeader("access-control-allow-origin", requestOrigin);
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        response.setHeader("access-control-allow-headers", "Content-Type");
      }
      if (request.method === "OPTIONS" && allowedOrigins.has(requestOrigin)) {
        response.writeHead(204, { "access-control-max-age": "600" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/config.js") {
        const config = Buffer.from(`window.BIM_VIDEOAI_API_BASE_URL=${JSON.stringify(appApiBaseUrl)};`);
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": config.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(config);
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const page = readFileSync(PAGE_PATH);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": page.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'self' 'unsafe-inline'; connect-src 'self' ${appApiBaseUrl ? new URL(appApiBaseUrl).origin : ""}; img-src 'self' blob: data:; media-src 'self' blob:`,
        });
        response.end(page);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        try {
          const result = await callUpstream("/ping");
          const text = await result.text();
          if (!result.ok || text.trim() !== '"pong"') {
            sendJson(response, 503, { app: "ok", engine: "unavailable", message: "The video engine did not respond to its health check." });
            return;
          }
          sendJson(response, 200, { app: "ok", engine: "ok" });
        } catch {
          sendJson(response, 503, { app: "ok", engine: "unavailable", message: "Cannot connect to the video engine. Check its URL and start its API." });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/providers") {
        const [ollamaStatus, engineStatus] = await Promise.all([
          (async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2500);
            try {
              const result = await fetchImpl(new URL("/api/tags", ollama), { signal: controller.signal });
              if (!result.ok) return "unavailable";
              const data = await result.json();
              return Array.isArray(data.models) && data.models.length ? "connected" : "no-models";
            } catch {
              return "unavailable";
            } finally {
              clearTimeout(timeout);
            }
          })(),
          (async () => {
            try {
              const result = await callUpstream("/ping");
              return result.ok && (await result.text()).trim() === '"pong"' ? "connected" : "unavailable";
            } catch {
              return "unavailable";
            }
          })(),
        ]);
        sendJson(response, 200, {
          settings: publicProviderSettings(),
          services: {
            ollama: { status: ollamaStatus, local: true, apiKeyRequired: false },
            moneyPrinterTurbo: { status: engineStatus },
            edgeTts: { status: "not-verified", requiresInternet: true, classification: "no API fee; internet required" },
            whisper: { status: "configure-in-engine", local: true, classification: "downloads a local model; large disk use" },
            ffmpeg: { status: "not-verifiable-through-engine-api" },
          },
          videoProviders: VIDEO_PROVIDERS.map((provider) => ({
            ...provider,
            enabled: Boolean(localState.settings.enabledProviders[provider.id]),
            status: provider.cost === "free-tier" ? "check-engine-config" : "disabled-until-explicitly-enabled",
          })),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/licenses") {
        sendJson(response, 200, {
          moneyPrinterTurbo: readFileSync(resolve(ROOT, "LICENSE"), "utf8"),
          thirdParty: readFileSync(resolve(ROOT, "THIRD_PARTY_LICENSES.md"), "utf8"),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/licenses") {
        const notices = readFileSync(resolve(ROOT, "THIRD_PARTY_LICENSES.md"));
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-length": notices.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(notices);
        return;
      }

      const licenseFile = new Map([
        ["/LICENSE", "LICENSE"],
        ["/THIRD_PARTY_LICENSES.md", "THIRD_PARTY_LICENSES.md"],
      ]).get(url.pathname);
      if (request.method === "GET" && licenseFile) {
        const notice = readFileSync(resolve(ROOT, licenseFile));
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": notice.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(notice);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/providers/settings") {
        const input = await readJson(request);
        const next = {
          ...localState.settings,
          enabledProviders: { ...localState.settings.enabledProviders },
        };
        if (input.llmProvider != null) {
          if (!["ollama", "cloud"].includes(input.llmProvider)) {
            sendJson(response, 400, { error: "LLM provider must be ollama or cloud." });
            return;
          }
          next.llmProvider = input.llmProvider;
        }
        if (input.subtitleProvider != null) {
          if (!["edge", "whisper"].includes(input.subtitleProvider)) {
            sendJson(response, 400, { error: "Subtitle provider must be edge or whisper." });
            return;
          }
          next.subtitleProvider = input.subtitleProvider;
        }
        if (input.engineLlmConfigured != null) {
          if (typeof input.engineLlmConfigured !== "boolean") {
            sendJson(response, 400, { error: "Local LLM configuration confirmation must be a boolean." });
            return;
          }
          next.engineLlmConfigured = input.engineLlmConfigured;
        }
        if (input.engineSubtitleConfigured != null) {
          if (typeof input.engineSubtitleConfigured !== "boolean") {
            sendJson(response, 400, { error: "Subtitle engine configuration confirmation must be a boolean." });
            return;
          }
          next.engineSubtitleConfigured = input.engineSubtitleConfigured;
        }
        if (input.defaultVideoProvider != null) {
          if (!VIDEO_PROVIDERS.some(({ id }) => id === input.defaultVideoProvider)) {
            sendJson(response, 400, { error: "Choose a supported video source." });
            return;
          }
          next.defaultVideoProvider = input.defaultVideoProvider;
        }
        if (input.enabledProviders != null) {
          if (!input.enabledProviders || typeof input.enabledProviders !== "object" || Array.isArray(input.enabledProviders)) {
            sendJson(response, 400, { error: "Provider enable settings must be an object." });
            return;
          }
          for (const [id, enabled] of Object.entries(input.enabledProviders)) {
            if (!VIDEO_PROVIDERS.some((provider) => provider.id === id) || typeof enabled !== "boolean") {
              sendJson(response, 400, { error: "Invalid provider enable setting." });
              return;
            }
            next.enabledProviders[id] = enabled;
          }
        }
        if (!next.enabledProviders[next.defaultVideoProvider]) {
          sendJson(response, 400, { error: "The default footage provider must be enabled. Change the default before disabling it." });
          return;
        }
        if (input.allowPaidProviders != null) {
          if (typeof input.allowPaidProviders !== "boolean") {
            sendJson(response, 400, { error: "Paid provider permission must be a boolean." });
            return;
          }
          next.allowPaidProviders = input.allowPaidProviders;
        }
        for (const field of ["dailyVideoLimit", "dailyPaidLimit"]) {
          if (input[field] != null) {
            if (!Number.isInteger(input[field]) || input[field] < (field === "dailyPaidLimit" ? 0 : 1) || input[field] > 100) {
              sendJson(response, 400, { error: `${field} must be between ${field === "dailyPaidLimit" ? 0 : 1} and 100.` });
              return;
            }
            next[field] = input[field];
          }
        }
        if (input.moneyPrinterApiKey != null) {
          if (envApiKey) {
            sendJson(response, 400, { error: "MONEYPRINTERTURBO_API_KEY is set in the environment and cannot be changed in the UI." });
            return;
          }
          if (typeof input.moneyPrinterApiKey !== "string" || input.moneyPrinterApiKey.length > 512 || /[\r\n]/.test(input.moneyPrinterApiKey)) {
            sendJson(response, 400, { error: "Video engine API key is invalid." });
            return;
          }
          currentApiKey = input.moneyPrinterApiKey;
          next.moneyPrinterApiKey = currentApiKey;
        }
        if (input.clearMoneyPrinterApiKey === true && !envApiKey) {
          currentApiKey = "";
          next.moneyPrinterApiKey = "";
        }
        Object.assign(localState.settings, next);
        persistState();
        sendJson(response, 200, { settings: publicProviderSettings() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scripts") {
        const body = await readJson(request);
        if (typeof body.subject !== "string" || !body.subject.trim() || body.subject.length > 500) {
          sendJson(response, 400, { error: "A topic of 1–500 characters is required." });
          return;
        }
        const provider = localState.settings.llmProvider;
        if (provider === "ollama" && !localState.settings.engineLlmConfigured) {
          sendJson(response, 412, { error: "Confirm that the video engine is configured to use local Ollama in Provider Settings before drafting with AI." });
          return;
        }
        if (provider === "cloud" && !body.confirmPaid) {
          sendJson(response, 402, { error: "Cloud LLM is a paid/review-required provider. Enable paid use and confirm this request explicitly." });
          return;
        }
        if (provider === "ollama") {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2500);
          let ollamaReady = false;
          try {
            const result = await fetchImpl(new URL("/api/tags", ollama), { signal: controller.signal });
            const data = result.ok ? await result.json() : null;
            ollamaReady = Array.isArray(data?.models) && data.models.length > 0;
          } catch {
            ollamaReady = false;
          } finally {
            clearTimeout(timeout);
          }
          if (!ollamaReady) {
            sendJson(response, 503, { error: "Ollama is not reachable or has no local models. Start Ollama and pull a model before drafting." });
            return;
          }
        }
        const reservation = reserveUsage({
          provider: provider === "ollama" ? "ollama" : "configured-cloud-llm",
          kind: "script",
          paid: provider === "cloud",
          confirmed: body.confirmPaid === true,
        });
        if (reservation.error) {
          sendJson(response, provider === "cloud" ? 402 : 429, { error: reservation.error });
          return;
        }
        const payload = {
          video_subject: body.subject.trim(),
          video_language: typeof body.language === "string" ? body.language.slice(0, 64) : "",
          paragraph_number: 1,
        };
        try {
          const result = await callUpstream("/api/v1/scripts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          finishUsage(reservation.entry, result.ok ? "accepted" : "failed-or-charge-unknown");
          await proxyJson(result, response);
        } catch (error) {
          finishUsage(reservation.entry, "failed-or-charge-unknown");
          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/materials") {
        const body = await readJson(request);
        let image;
        try {
          image = validateImage(body);
        } catch (error) {
          sendJson(response, 400, { error: error.message });
          return;
        }
        const form = new FormData();
        form.append(
          "file",
          new Blob([image.bytes], { type: body.type }),
          `reference${image.extension}`,
        );
        const result = await callUpstream("/api/v1/video_materials", {
          method: "POST",
          body: form,
        });
        await proxyJson(result, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/videos") {
        const input = await readJson(request);
        if (input.mode === "video") {
          sendJson(response, 400, { error: "Video-to-video is not supported by the configured video engine." });
          return;
        }
        if (!["text", "image"].includes(input.mode)) {
          sendJson(response, 400, { error: "Unsupported generation mode." });
          return;
        }
        if (typeof input.subject !== "string" || !input.subject.trim() || input.subject.length > 500) {
          sendJson(response, 400, { error: "A topic of 1–500 characters is required." });
          return;
        }
        if (input.script != null && (typeof input.script !== "string" || input.script.length > 8000)) {
          sendJson(response, 400, { error: "Script must be 8,000 characters or fewer." });
          return;
        }
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) {
          sendJson(response, 400, { error: "Video count must be between 1 and 5." });
          return;
        }
        if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 15) {
          sendJson(response, 400, { error: "Clip duration must be between 1 and 15 seconds." });
          return;
        }
        if (!ASPECTS.has(input.aspect)) {
          sendJson(response, 400, { error: "Aspect ratio must be 9:16, 16:9, or 1:1." });
          return;
        }
        if (input.mode === "image" && (typeof input.material !== "string" || !/^[A-Za-z0-9._-]{1,180}$/.test(input.material))) {
          sendJson(response, 400, { error: "Upload an image reference before generating in image-material mode." });
          return;
        }
        const selectedSource = input.mode === "image" ? "local" : input.source || localState.settings.defaultVideoProvider;
        const selectedProvider = VIDEO_PROVIDERS.find(({ id }) => id === selectedSource);
        if (input.mode !== "image" && !selectedProvider) {
          sendJson(response, 400, { error: "Choose a supported video provider." });
          return;
        }
        if (input.mode !== "image" && !localState.settings.enabledProviders[selectedSource]) {
          sendJson(response, 403, { error: "This provider is disabled. Enable it explicitly in Provider Settings first." });
          return;
        }
        const source = input.mode === "image" ? "local" : selectedSource;
        const usesPaidLlm = localState.settings.llmProvider === "cloud";
        if (!usesPaidLlm && !localState.settings.engineLlmConfigured) {
          sendJson(response, 412, { error: "Confirm that the engine uses local Ollama in Provider Settings before generating. This prevents accidental cloud LLM usage." });
          return;
        }
        if (input.subtitles !== false && localState.settings.subtitleProvider === "whisper" && !localState.settings.engineSubtitleConfigured) {
          sendJson(response, 412, { error: "Confirm that the video engine is configured for local Whisper in Provider Settings before generating subtitles." });
          return;
        }
        const paidProvider = (input.mode !== "image" && selectedProvider.cost !== "free-tier") || usesPaidLlm;
        if (paidProvider && input.confirmPaid !== true) {
          sendJson(response, 402, { error: "This provider is paid or requires cost review. Confirm the request explicitly." });
          return;
        }
        if (input.subtitlePosition != null && !SUBTITLE_POSITIONS.has(input.subtitlePosition)) {
          sendJson(response, 400, { error: "Choose a supported subtitle position." });
          return;
        }
        if (input.subtitleDisplayMode != null && !SUBTITLE_DISPLAY_MODES.has(input.subtitleDisplayMode)) {
          sendJson(response, 400, { error: "Choose a supported subtitle display mode." });
          return;
        }
        if (input.subtitleAnimation != null && !SUBTITLE_ANIMATIONS.has(input.subtitleAnimation)) {
          sendJson(response, 400, { error: "Choose a supported subtitle animation." });
          return;
        }
        if (input.subtitleColor != null && (typeof input.subtitleColor !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(input.subtitleColor))) {
          sendJson(response, 400, { error: "Subtitle color must be a six-digit hex color." });
          return;
        }
        if (input.subtitleFontSize != null && (!Number.isInteger(input.subtitleFontSize) || input.subtitleFontSize < 20 || input.subtitleFontSize > 120)) {
          sendJson(response, 400, { error: "Subtitle font size must be between 20 and 120." });
          return;
        }
        const payload = {
          video_subject: input.subject.trim(),
          video_script: input.script?.trim() || "",
          video_count: input.count,
          video_clip_duration: input.duration,
          video_aspect: input.aspect,
          video_source: source,
          video_language: typeof input.language === "string" ? input.language.slice(0, 64) : "",
          image_motion: input.imageMotion === "static" ? "static" : "zoom",
          subtitle_enabled: input.subtitles !== false,
          subtitle_position: SUBTITLE_POSITIONS.has(input.subtitlePosition) ? input.subtitlePosition : "bottom",
          subtitle_display_mode: SUBTITLE_DISPLAY_MODES.has(input.subtitleDisplayMode) ? input.subtitleDisplayMode : "sentence",
          subtitle_animation: SUBTITLE_ANIMATIONS.has(input.subtitleAnimation) ? input.subtitleAnimation : "none",
          font_size: Number.isInteger(input.subtitleFontSize) ? input.subtitleFontSize : 60,
          text_fore_color: /^#[0-9A-Fa-f]{6}$/.test(input.subtitleColor || "") ? input.subtitleColor : "#FFFFFF",
          voice_name: typeof input.voiceName === "string" ? input.voiceName.slice(0, 128) : "",
          voice_volume: Number.isFinite(input.voiceVolume) ? Math.min(2, Math.max(0, input.voiceVolume)) : 1,
          bgm_type: input.music === false ? "none" : "random",
          bgm_volume: Number.isFinite(input.musicVolume) ? Math.min(1, Math.max(0, input.musicVolume)) : 0.2,
        };
        if (input.mode === "image") {
          payload.video_materials = [{ provider: "local", url: input.material, duration: 0 }];
        }
        const reservation = reserveUsage({
          provider: input.mode === "image" ? "local-image-material" : usesPaidLlm ? `${selectedSource}+cloud-llm` : selectedSource,
          kind: "video",
          units: input.count,
          paid: paidProvider,
          confirmed: input.confirmPaid === true,
        });
        if (reservation.error) {
          sendJson(response, paidProvider ? 402 : 429, { error: reservation.error });
          return;
        }
        try {
          const result = await callUpstream("/api/v1/videos", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          finishUsage(reservation.entry, result.ok ? "accepted" : "failed-or-charge-unknown");
          await proxyJson(result, response);
        } catch (error) {
          finishUsage(reservation.entry, "failed-or-charge-unknown");
          throw error;
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const page = Number(url.searchParams.get("page") || 1);
        const pageSize = Number(url.searchParams.get("page_size") || 20);
        if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
          sendJson(response, 400, { error: "Invalid task history pagination." });
          return;
        }
        const result = await callUpstream(`/api/v1/tasks?page=${page}&page_size=${pageSize}`);
        await proxyJson(result, response, { rewriteFiles: true });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        if (!TASK_ID_PATTERN.test(taskMatch[1])) {
          sendJson(response, 400, { error: "Invalid task ID." });
          return;
        }
        const result = await callUpstream(`/api/v1/tasks/${encodeURIComponent(taskMatch[1])}`);
        await proxyJson(result, response, { rewriteFiles: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/files") {
          const filePath = url.searchParams.get("path") || "";
          let segments;
          try {
            if (!filePath.startsWith("/")) throw new Error("invalid path");
            segments = filePath.slice(1).split("/").map((segment) => decodeURIComponent(segment));
            if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) {
              sendJson(response, 400, { error: "Invalid output file path." });
              return;
            }
          } catch {
            sendJson(response, 400, { error: "Invalid output file path." });
            return;
          }
          if (
            !filePath.startsWith("/tasks/") ||
            segments.length < 3 ||
            segments[0] !== "tasks" ||
            !TASK_ID_PATTERN.test(segments[1])
          ) {
            sendJson(response, 400, { error: "Invalid output file path." });
            return;
          }
          const target = `${upstream.origin}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
        const headers = new Headers();
        if (currentApiKey) headers.set("x-api-key", currentApiKey);
        const range = request.headers.range;
        if (range) headers.set("range", range);
        const result = await fetchImpl(target, { headers });
        const outgoingHeaders = {};
        for (const name of ["content-type", "content-length", "content-disposition", "accept-ranges", "content-range"]) {
          const value = result.headers.get(name);
          if (value) outgoingHeaders[name] = value;
        }
        outgoingHeaders["cache-control"] = "no-store";
        outgoingHeaders["x-content-type-options"] = "nosniff";
        response.writeHead(result.status, outgoingHeaders);
        if (result.body) Readable.fromWeb(result.body).pipe(response);
        else response.end();
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "API route not found." });
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = Number.isInteger(error.status) ? error.status : 502;
      sendJson(response, status, {
        error: status === 502 ? "Cannot reach the video engine or process its response." : error.message,
      });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.listen(port, host, () => {
      console.log(`Bim AI Video Studio running at http://${host}:${port}`);
    });
  }
}
