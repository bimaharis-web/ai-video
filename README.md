# Bim AI Video Studio

Personal, local-first video studio frontend for the official
[MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) FastAPI
engine. The Bim interface is served by a small Node.js proxy; provider
credentials remain in server-side configuration and are never sent to the
browser.

## What works

- Topic-to-video generation, automatic or custom scripts, task progress,
  history, preview, and download through MoneyPrinterTurbo's documented API.
- Script drafting with the configured MoneyPrinterTurbo LLM provider.
- Aspect ratio (9:16, 16:9, 1:1), 1–15-second clips (UI presets: 5, 10, 15),
  1–5 videos, language, subtitles, voice name, music, and supported material
  providers.
- JPEG, PNG, and BMP uploads (up to 15 MB) as **local visual materials** with
  MoneyPrinterTurbo's static/zoom image-motion rendering.

Image-material mode is not provider-native image-to-video generation.
Video-to-video, arbitrary camera movement, arbitrary visual styles, generic
resolution selection, and selecting a provider model ID are not exposed as if
they worked: those need provider-specific adapters or API support.

## Requirements

- Node.js 20 or newer.
- A separately installed and running MoneyPrinterTurbo instance
  (Python 3.11 or newer, plus the system/media dependencies required by that
  project). This workspace contains the Bim app and proxy; it does not vendor
  or silently install the video engine.
- For the local-first workflow, install Ollama and a model locally, then
  configure the video engine to use Ollama. Edge TTS is its low-cost default
  for voice and requires an internet connection. Whisper can run locally when
  configured in the engine, but downloads model files and needs additional
  storage. FFmpeg is provided by the separately installed engine. Free-tier
  stock sources still require their own credentials and are subject to quotas
  and usage licenses.

Follow MoneyPrinterTurbo's current installation instructions:
[README-en.md](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/README-en.md).
Start its API and verify `/ping` and `/docs` on the port shown by its
configuration. The upstream default is 8080, but it can be changed.

## Run locally

```sh
cp .env.example .env
```

Set `MONEYPRINTERTURBO_URL` to the actual API URL. If MoneyPrinterTurbo has
`app.api_key` enabled, set the same value in `MONEYPRINTERTURBO_API_KEY` in this
app's local `.env`; the proxy sends it as `x-api-key` server-to-server. Do not
put provider keys or the MoneyPrinterTurbo API key into the HTML or browser.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server binds to
loopback only and does not require CORS. Set `OLLAMA_URL` only to a local
Ollama address; its default is `http://127.0.0.1:11434`. Provider preferences,
usage logs, and an optional engine API key are stored in `.local-data/`, with
restrictive file permissions. `.env` and `.local-data/` are excluded from Git.
Generation requests are not automatically retried.

## Publishing under `bimaharis.my.id/videoai/`

The domain's current site is GitHub Pages from `bimaharis-web/bima-haris-portfolio`.
GitHub Pages serves static files only; it cannot run this Node.js API or access
the video engine on a private computer. The `/videoai/` page can be published
as `videoai/index.html` in the portfolio repository, but generation remains
disabled until a separate HTTPS backend is deployed.

When a backend host is ready:

1. Deploy this Node app behind HTTPS on a host that can also reach the video
   engine and Ollama. Do not expose the app directly to the public internet
   without an authentication/access-control layer. GitHub Pages CORS is not
   authentication.
2. Set `APP_CORS_ORIGINS=https://bimaharis.my.id` on the backend, keep provider
   keys and `MONEYPRINTERTURBO_API_KEY` on the backend, and configure the
   engine URL there.
3. Set the public backend origin in `videoai/config.js` in the portfolio
   repository, for example
   `window.BIM_VIDEOAI_API_BASE_URL = "https://api.example.com";`. This value
   is intentionally public and must contain no API key or password.
4. Publish both repositories. The portfolio's GitHub Pages workflow serves
   `/videoai/`; the `ai-video` repository retains the API app source.

The current deployment intentionally leaves the public API origin empty.
It displays an explicit not-configured message and disables AI actions until
a real backend is configured; it does not pretend that GitHub Pages can run
generation on its own. The backend host, HTTPS/DNS, and access-control
configuration are still required and are not available in this workspace.

## Provider and cost settings

Open **AI Provider Settings** in the interface to inspect Ollama and engine
availability, choose the default footage source, enable or disable sources,
and set daily clip and paid-request limits. Pexels/Pixabay are marked
**Free tier**, not unlimited or guaranteed free; their API quotas and footage
license terms apply. Providers with paid or uncertain pricing are disabled by
default and classified as paid/review-required.

The local Ollama setting requires an explicit confirmation that the video
engine itself is configured with Ollama. The app checks Ollama's local tags
endpoint, but the engine API does not expose a configuration inspection route.
The app also cannot change the engine's LLM, Edge TTS, or Whisper configuration
through its public API. The Edge/Whisper selector records a preference only;
configure and verify the actual engine settings separately. Whisper model
downloads can be large.

Paid/review-required requests are blocked unless a provider is enabled, paid
usage is explicitly enabled, a nonzero daily limit is set, and the user
confirms each request. There is no reliable price-estimate endpoint, so the
app warns that provider charges may apply but cannot calculate an estimate.
Usage logs are local bookkeeping, not provider billing records. Provider API
keys must be configured on the engine host; the optional key field in this app
is only for authenticating to the local engine and is never sent to browser
JavaScript.

## Provider setup

The provider selector passes supported `video_source` values to
`/api/v1/videos`; it does not inspect provider credentials. Configure the
selected source and any required keys on the engine host first. A provider
selection that is not configured returns an error rather than a simulated
result. Current provider classifications are conservative and must be checked
against the service's current terms and pricing before use.

For private image generation, configure an OpenAI-compatible image service in
MoneyPrinterTurbo and select **OpenAI-compatible image**. For AI video
materials, select a provider supported by your installed MoneyPrinterTurbo
version and configure its credentials there. Provider capabilities, pricing,
model availability, and duration/resolution constraints vary; review the
upstream configuration and provider terms before submitting paid jobs.

## Local API proxy

The Node server exposes only the application routes required by this UI:

- `GET /api/health`
- `GET /api/providers`
- `POST /api/providers/settings`
- `GET /api/licenses`
- `POST /api/scripts`
- `POST /api/materials` (validated JPEG/PNG/BMP upload)
- `POST /api/videos`
- `GET /api/tasks?page=1&page_size=20`
- `GET /api/tasks/{task_id}`
- `GET /api/files?path=/tasks/{task_id}/...` (validated output proxy)

These proxy routes map to MoneyPrinterTurbo's `/ping`, `/api/v1/scripts`,
`/api/v1/video_materials`, `/api/v1/videos`, `/api/v1/tasks`,
`/api/v1/tasks/{task_id}`, and `/tasks/...` output routes. Requests and
responses follow the upstream API schema; upstream errors are returned to the
UI.

## Validation

```sh
npm test
```

Tests use a local fake upstream only to verify request mapping and proxy
behavior; they do not simulate successful AI generation. An actual generated
video requires a running MoneyPrinterTurbo service and configured provider.

## Attribution and license

The application uses the identity **Bim AI Video Studio · Developed by
bimaharis**. MoneyPrinterTurbo is a separately installed MIT-licensed engine;
its original license text is included in [`LICENSE`](./LICENSE), with
supplementary notes in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
Provider, model, font, codec, and media-source terms are separate and depend on
the services and build versions in use.
