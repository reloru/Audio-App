# CLAUDE.md

Bounce is a mobile-first PWA for editing Suno MP3/WAV files entirely on the device. Product rationale and sources are in `docs/PRODUCT.md`; read it before changing features.

## Commands

- `npm run dev` starts the dev server. `npm run build` runs the type check and produces the production build in `dist/`.
- `npm test` runs the Vitest unit tests. They need `ffmpeg`/`ffprobe` on the PATH, because exports are checked with them.
- `npm run test:e2e` runs Playwright against a fresh build. `@playwright/test` is pinned to 1.56.1 to match the preinstalled Chromium 1194 in Claude cloud sessions. Do not run `playwright install` there.
- `npm run typecheck` runs TypeScript 7 (`tsc`), with no emit.
- `npm run test:e2e:cf` runs the same e2e tests against `wrangler dev`: Cloudflare's asset server, with `public/_headers` applied. CI uses this target. `npm run preview:cf` serves the build the same way for manual checks.
- Hosting is a static-assets-only Cloudflare Worker (`wrangler.jsonc`), deployed by Workers Builds from `main`. Non-production branches get preview URLs. There is no deploy workflow in GitHub Actions.

Before pushing, run the type check, the unit tests and the e2e tests.

## Architecture

- `src/dsp`, `src/io`, `src/model` and `src/engine` are framework-free and tested in Node. Keep them free of DOM APIs; browser-only code lives in `src/io/decode.ts`, `src/engine/browser.ts`, `src/audio`, `src/workers`, `src/storage` and `src/ui`.
- **Export path:** `engine/render.ts` (arrangement → resampler → `PostChain` → limiter → meter), driven by `engine/export.ts`. Loudness normalisation runs a measure pass and then a corrected pass.
- **Preview path:** `audio/player.ts` must mirror the export path. It uses the same `seamExtent` crossfades, the same `eqToBiquads` filters (the W3C formulas in `dsp/biquad.ts`), the same fades and the same limiter class (in the AudioWorklet). When you change one path, change the other.
- **Timeline model:** clips play back to back. A seam between non-contiguous clips gets a centred equal-power crossfade that uses audio just outside the clips, so the timeline length is always the sum of the clip lengths. Sources hold sample-aligned layers (stems).
- **State:** `ui/editorStore.ts` is the single place that mutates the project, via `commit()` (undoable; slider drags merge using a key) or `set()` (UI-only state).
- **Service worker** (`build/sw-template.js`, emitted by `build/sw-plugin.ts`): precaches every built and public file except host config files (names starting with `_` or `.`). Navigations are network-first with `cache: 'no-cache'`. HTML responses are never cached under non-HTML URLs.
- **Generated file:** `src/dsp/interp.generated.ts` is generated from the BS.1770-5 true-peak table. A test checks it against `TP_PHASES`.

## Conventions

- Claims in UI copy and docs about Suno, standards or platforms need a primary source, or must be labelled unverified where they appear. Loudness presets cite their source in `model/presets.ts`.
- DSP changes need a test that checks against a standard's test case or an independent reference (ffmpeg), not only self-consistency.
- Keep touch targets ≥ 44 px, support both colour schemes via the CSS variables in `ui/styles.css`, and check layouts at 390 px width.
