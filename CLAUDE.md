# CLAUDE.md

Bounce is a mobile-first PWA for editing Suno MP3/WAV files on the device. The one exception is the opt-in cloud tempo/pitch tool, which uploads the song to a Rubber Band container on Cloudflare. Product rationale and sources are in `docs/PRODUCT.md`; read it before changing features.

## Commands

- `npm run dev` starts the dev server (app only, no `/api`). `npm run build` runs the type check and produces the production build in `dist/`.
- `npm test` runs the Vitest unit tests. They need `ffmpeg`/`ffprobe` on the PATH, because exports are checked with them.
- `npm run test:container` runs the Docker integration tests in `tests/container/` (separate config, `vitest.container.config.ts`). They build `container/`, test it directly, and test `/api` through the Worker and Durable Objects under `wrangler dev` with containers on. Without Docker they are skipped, unless `REQUIRE_DOCKER=1` (set in CI). In Claude cloud sessions, start the daemon with `dockerd &`; if Docker Hub answers 429, set `{"registry-mirrors":["https://mirror.gcr.io"]}` in `/etc/docker/daemon.json` first.
- `npm run test:e2e` runs Playwright against a fresh build. `@playwright/test` is pinned to 1.56.1 to match the preinstalled Chromium 1194 in Claude cloud sessions. Do not run `playwright install` there. Chromium runs with `--disable-gpu` (see `playwright.config.ts`).
- `npm run typecheck` runs TypeScript 7 (`tsc`), with no emit, for the app (`tsconfig.json`) and the Worker (`worker/tsconfig.json`, Workers types).
- `npm run test:e2e:cf` runs the same e2e tests against `wrangler dev --enable-containers=false`: Cloudflare's asset server, with `public/_headers` applied and the Worker on `/api/*`. CI uses this target. `npm run preview:cf` serves the build the same way, with the container running in Docker.
- Hosting is a Cloudflare Worker (`wrangler.jsonc`): static assets from `dist/`, plus `worker/index.ts` for `/api/*` only (`assets.run_worker_first`), plus a container built from `container/Dockerfile`. The `deploy` job in `.github/workflows/ci.yml` runs `wrangler deploy` on pushes to `main` after the `test` job passes, with the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Workers Builds is not used. There are no preview deployments; the `test` job runs `wrangler deploy --dry-run` to check the deploy configuration.

Before pushing, run the type check, the unit tests and the e2e tests. When `worker/`, `container/`, `src/cloud/` or `wrangler.jsonc` change, also run `npm run test:container`.

## Architecture

- `src/dsp`, `src/io`, `src/model` and `src/engine` are framework-free and tested in Node. Keep them free of DOM APIs; browser-only code lives in `src/io/decode.ts`, `src/engine/browser.ts`, `src/cloud/client.ts`, `src/audio`, `src/workers`, `src/storage` and `src/ui`. `src/cloud/params.ts` is shared with the Worker, so it must not use DOM APIs either.
- **Export path:** `engine/render.ts` (arrangement → resampler → `PostChain` → limiter → meter), driven by `engine/export.ts`. Loudness normalisation runs a measure pass and then a corrected pass.
- **Preview path:** `audio/player.ts` must mirror the export path. It uses the same `seamExtent` crossfades, the same `eqToBiquads` filters (the W3C formulas in `dsp/biquad.ts`), the same fades and the same limiter class (in the AudioWorklet). When you change one path, change the other.
- **Timeline model:** clips play back to back. A seam between non-contiguous clips gets a centred equal-power crossfade that uses audio just outside the clips, so the timeline length is always the sum of the clip lengths. Sources hold sample-aligned layers (stems).
- **State:** `ui/editorStore.ts` is the single place that mutates the project, via `commit()` (undoable; slider drags merge using a key) or `set()` (UI-only state).
- **Cloud tempo/pitch:** `engine/cloudInput.ts` renders the arrangement only (no speed, EQ, width, gain, fades or limiter) as 16-bit WAV scaled to a −6 dBFS peak (at most −12 dB). `EditorStore.runCloudStretch` uploads it (`cloud/client.ts`), imports the result as a new project with the source project's settings, and sets the new layer's level to undo the scaling. `worker/index.ts` validates, applies the per-IP rate limit and the daily `Quota` Durable Object, then gives each job its own `Stretcher` Durable Object and container. `prepare()` starts the container before the upload is forwarded, unknown ids answer 404 without starting one, DELETE destroys it, an alarm ends every job after 30 minutes, and the container stops 5 minutes after the last request. `container/server.py` runs `rubberband --fine --ignore-clipping` and reports the progress of the processing pass only.
- **Service worker** (`build/sw-template.js`, emitted by `build/sw-plugin.ts`): precaches every built and public file except host config files (names starting with `_` or `.`). Navigations are network-first with `cache: 'no-cache'`. HTML responses are never cached under non-HTML URLs. `/api/` requests bypass it.
- **Generated file:** `src/dsp/interp.generated.ts` is generated from the BS.1770-5 true-peak table. A test checks it against `TP_PHASES`.

## Conventions

- Claims in UI copy and docs about Suno, standards or platforms need a primary source, or must be labelled unverified where they appear. Loudness presets cite their source in `model/presets.ts`.
- DSP changes need a test that checks against a standard's test case or an independent reference (ffmpeg), not only self-consistency.
- Keep touch targets ≥ 44 px, support both colour schemes via the CSS variables in `ui/styles.css`, and check layouts at 390 px width.
