import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAppServer } from "./server.mjs";

let upstream;
let upstreamUrl;
let app;
let appUrl;
let dataDir;
const requests = [];

before(async () => {
  upstream = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ url: request.url, key: request.headers["x-api-key"], body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/ping") {
      response.end(JSON.stringify("pong"));
    } else if (request.url === "/api/v1/scripts") {
      response.end(JSON.stringify({ status: 200, data: { video_script: "generated script" } }));
    } else if (request.url === "/api/v1/videos") {
      response.end(JSON.stringify({ status: 200, data: { task_id: "task-123" } }));
    } else if (request.url.startsWith("/api/v1/tasks?")) {
      response.end(JSON.stringify({ status: 200, data: { tasks: [{ task_id: "task-123", videos: ["/tasks/task-123/output.mp4"] }] } }));
    } else if (request.url === "/api/v1/tasks/task-123") {
      response.end(JSON.stringify({ status: 200, data: { task_id: "task-123", state: 1, progress: 100, videos: [`${upstreamUrl}/tasks/task-123/output.mp4`] } }));
    } else if (request.url === "/api/v1/video_materials") {
      response.end(JSON.stringify({ status: 200, data: { file: "uploaded-image.png" } }));
    } else if (request.url === "/tasks/task-123/output.mp4") {
      response.setHeader("content-type", "video/mp4");
      response.end("video bytes");
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ detail: "not found" }));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  dataDir = await mkdtemp(join(tmpdir(), "bim-ai-studio-test-"));
  const fetchImpl = (input, options) => {
    const url = new URL(input);
    if (url.pathname === "/api/tags" && url.port === "11434") {
      return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "test-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    }
    return fetch(input, options);
  };
  app = createAppServer({
    upstreamUrl,
    apiKey: "test-key",
    dataDir,
    appApiBaseUrl: "https://api.bimaharis.my.id",
    corsOrigins: "https://bimaharis.my.id",
    fetchImpl,
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  appUrl = `http://127.0.0.1:${app.address().port}`;
  await fetch(`${appUrl}/api/providers/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engineLlmConfigured: true }),
  });
});

after(async () => {
  await Promise.all(
    [upstream, app].map((server) => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  );
  await rm(dataDir, { recursive: true, force: true });
});

test("health check verifies the MoneyPrinterTurbo API", async () => {
  const response = await fetch(`${appUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { app: "ok", engine: "ok" });
  assert.equal(requests.at(-1).key, "test-key");
});

test("provider settings report local services without exposing credentials", async () => {
  const response = await fetch(`${appUrl}/api/providers`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.llmProvider, "ollama");
  assert.equal(body.services.ollama.status, "connected");
  assert.equal(body.services.edgeTts.requiresInternet, true);
  assert.equal(body.settings.hasMoneyPrinterApiKey, true);
  assert.equal(JSON.stringify(body).includes("test-key"), false);
});

test("paid providers are disabled unless explicitly enabled, consented, and budgeted", async () => {
  const denied = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text", subject: "Paid test", count: 1, duration: 5, aspect: "9:16",
      source: "wavespeed", confirmPaid: true,
    }),
  });
  assert.equal(denied.status, 403);
  const callsBeforeOptIn = requests.length;

  await fetch(`${appUrl}/api/providers/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabledProviders: { wavespeed: true },
      allowPaidProviders: true,
      dailyPaidLimit: 2,
    }),
  });
  const unconfirmed = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text", subject: "Paid test", count: 1, duration: 5, aspect: "9:16",
      source: "wavespeed",
    }),
  });
  assert.equal(unconfirmed.status, 402);
  assert.equal(requests.length, callsBeforeOptIn);

  const confirmed = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text", subject: "Paid test", count: 1, duration: 5, aspect: "9:16",
      source: "wavespeed", confirmPaid: true,
    }),
  });
  assert.equal(confirmed.status, 200);
  const providers = await fetch(`${appUrl}/api/providers`).then((result) => result.json());
  assert.equal(providers.settings.usage.paidUnits, 1);
  assert.equal(providers.settings.usage.recent[0].provider, "wavespeed");
});

test("script drafting maps fields to the official script endpoint", async () => {
  const response = await fetch(`${appUrl}/api/scripts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "A local garden", language: "id-ID" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.video_script, "generated script");
  assert.equal(requests.at(-1).url, "/api/v1/scripts");
  assert.deepEqual(JSON.parse(requests.at(-1).body), {
    video_subject: "A local garden",
    video_language: "id-ID",
    paragraph_number: 1,
  });
});

test("image upload is validated and forwarded to MoneyPrinterTurbo", async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const response = await fetch(`${appUrl}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "reference.png", type: "image/png", data: png }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.file, "uploaded-image.png");
  assert.equal(requests.at(-1).url, "/api/v1/video_materials");
  assert.equal(requests.at(-1).key, "test-key");
  assert.match(requests.at(-1).body, /name="file"/);

  const invalid = await fetch(`${appUrl}/api/materials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "reference.png", type: "image/png", data: Buffer.from("not a PNG").toString("base64") }),
  });
  assert.equal(invalid.status, 400);
});

test("video generation maps the UI values to the upstream request schema", async () => {
  const response = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text",
      subject: "Ocean conservation",
      count: 2,
      duration: 10,
      aspect: "16:9",
      source: "pexels",
      language: "en",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.task_id, "task-123");
  const recorded = requests.at(-1);
  assert.equal(recorded.url, "/api/v1/videos");
  assert.equal(recorded.key, "test-key");
  assert.deepEqual(JSON.parse(recorded.body), {
    video_subject: "Ocean conservation",
    video_script: "",
    video_count: 2,
    video_clip_duration: 10,
    video_aspect: "16:9",
    video_source: "pexels",
    video_language: "en",
    image_motion: "zoom",
    subtitle_enabled: true,
    subtitle_position: "bottom",
    subtitle_display_mode: "sentence",
    subtitle_animation: "none",
    font_size: 60,
    text_fore_color: "#FFFFFF",
    voice_name: "",
    voice_volume: 1,
    bgm_type: "random",
    bgm_volume: 0.2,
  });
});

test("image mode sends uploaded materials through the supported local-material path", async () => {
  const response = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "image",
      subject: "A local garden",
      count: 1,
      duration: 5,
      aspect: "9:16",
      material: "stored-image.png",
    }),
  });
  assert.equal(response.status, 200);
  const payload = JSON.parse(requests.at(-1).body);
  assert.equal(payload.video_source, "local");
  assert.deepEqual(payload.video_materials, [{ provider: "local", url: "stored-image.png", duration: 0 }]);
});

test("rejects video-to-video and invalid generation parameters", async () => {
  const response = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "video" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not supported/i);
});

test("task history and status use proxied output URLs", async () => {
  const history = await fetch(`${appUrl}/api/tasks`).then((response) => response.json());
  assert.equal(history.data.tasks[0].videos[0], "/api/files?path=%2Ftasks%2Ftask-123%2Foutput.mp4");
  const task = await fetch(`${appUrl}/api/tasks/task-123`).then((response) => response.json());
  assert.equal(task.data.videos[0], "/api/files?path=%2Ftasks%2Ftask-123%2Foutput.mp4");
});

test("download proxy preserves video bytes and rejects unsafe paths", async () => {
  const download = await fetch(`${appUrl}/api/files?path=${encodeURIComponent("/tasks/task-123/output.mp4")}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "video/mp4");
  assert.equal(await download.text(), "video bytes");

  const unsafe = await fetch(`${appUrl}/api/files?path=${encodeURIComponent("/tasks/../secret")}`);
  assert.equal(unsafe.status, 400);
});

test("local Whisper requires explicit engine configuration before subtitle generation", async () => {
  const before = requests.length;
  const settings = await fetch(`${appUrl}/api/providers/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subtitleProvider: "whisper", engineSubtitleConfigured: false }),
  });
  assert.equal(settings.status, 200);
  const response = await fetch(`${appUrl}/api/videos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "text", subject: "Local subtitle test", count: 1, duration: 5, aspect: "9:16",
      source: "pexels", subtitles: true,
    }),
  });
  assert.equal(response.status, 412);
  assert.equal(requests.length, before);
  await fetch(`${appUrl}/api/providers/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subtitleProvider: "edge", engineSubtitleConfigured: false }),
  });
});

test("license endpoint returns the included upstream MIT notice", async () => {
  const response = await fetch(`${appUrl}/api/licenses`);
  assert.equal(response.status, 200);
  const licenses = await response.json();
  assert.match(licenses.moneyPrinterTurbo, /^MIT License\n\nCopyright \(c\) 2024 Harry/);
  assert.match(licenses.thirdParty, /Third-party licenses/);
});

test("public API base configuration is public-only and CORS is origin restricted", async () => {
  const config = await fetch(`${appUrl}/config.js`);
  assert.equal(config.status, 200);
  assert.match(await config.text(), /BIM_VIDEOAI_API_BASE_URL="https:\/\/api\.bimaharis\.my\.id"/);

  const allowed = await fetch(`${appUrl}/api/providers`, {
    headers: { origin: "https://bimaharis.my.id" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://bimaharis.my.id");

  const preflight = await fetch(`${appUrl}/api/videos`, {
    method: "OPTIONS",
    headers: {
      origin: "https://bimaharis.my.id",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert.equal(preflight.status, 204);
  const denied = await fetch(`${appUrl}/api/providers`, {
    headers: { origin: "https://untrusted.example" },
  });
  assert.equal(denied.status, 403);
});
