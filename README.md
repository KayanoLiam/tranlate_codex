# OpenAI Auth Immersive Translator (Chrome)

A local-first Chrome extension that translates web pages using your local Codex CLI ChatGPT login session (OpenAI Auth), without storing an API key in the extension.

## Features

- Full-page bilingual translation (source + translated note).
- Selected-text translation in a floating panel.
- Local bridge health check from popup/options page.
- Tunable settings: source/target language, tone, mode, model, batch size, max chars, max blocks.

## Project Structure

- `extension/`: Chrome MV3 extension files (`manifest.json`, background/content scripts, popup, options).
- `bridge/`: local HTTP bridge service (`server.mjs`) that invokes `codex exec`.
- `DEVELOPMENT.md`: architecture and implementation notes.
- `CAUTIONS.md`: operational and safety caveats.

## How It Works

1. `content.js` extracts visible text blocks.
2. `background.js` sends translation requests to `http://127.0.0.1:8787/translate-batch`.
3. `bridge/server.mjs` runs `codex exec` with your local ChatGPT-authenticated session.
4. Translation results are injected back into the page incrementally.

## Requirements

- Node.js 18 or newer
- Google Chrome
- Codex CLI installed and logged in (`codex login status`)

Expected auth output:

```bash
Logged in using ChatGPT
```

## Quick Start

1. Start the local bridge:

```bash
npm run bridge:start
```

2. Load unpacked extension:
- Open `chrome://extensions`
- Enable `Developer mode`
- Click `Load unpacked`
- Select `extension/`

3. Open popup and click `Refresh Status` (should show `Ready`).

## Usage

- `Translate Page`: translate current page blocks.
- `Translate Selection`: translate selected text only.
- `Restore`: remove injected translations from current page.
- `Settings`: adjust language/model/performance parameters.

## Recommended Settings for Large Pages

- `Batch Size`: `4`
- `Max Blocks Per Page`: `60`
- `Max Chars Per Item`: `1200`

See `CAUTIONS.md` before relying on this setup for important text.
