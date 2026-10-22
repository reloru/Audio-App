# Bounce — pocket editor for Suno songs

Bounce is a free, mobile-first web app for editing the MP3 and WAV files you download from [Suno](https://suno.com). You can trim, cut, loop, fix endings, join takes, remix stems, EQ, change speed and master to streaming loudness, then export a tagged MP3 or WAV. Editing runs entirely on your phone or computer and works offline once loaded. Your audio leaves the device only if you use the optional cloud tempo/pitch tool, and only after you confirm the upload.

> Not affiliated with Suno. “Suno” is a trademark of its owner.

## Use it

After the first deploy (see [Deploy](#deploy)), open **https://bounce.&lt;your-subdomain&gt;.workers.dev** on your phone. The `wrangler deploy` step of the deploy job prints the exact address in its log.

- **iPhone / iPad (Safari):** Share → **Add to Home Screen**. This runs it full-screen like an app. It also keeps your projects safe: Safari clears website storage after 7 days without use, but Home Screen apps are exempt.
- **Android (Chrome):** menu → **Install app**. Once installed, Bounce registers as a share target for audio files (the Web Share Target API), so you can share a file from another app straight into it. This hasn't been tested on a device yet.
- **Desktop:** any current Chrome, Edge, Safari or Firefox. Drag and drop files onto the page.

### Getting your songs out of Suno

Open the song's **⋯** menu → **Download**. MP3 works on every plan. WAV needs Pro or Premier and is only offered on suno.com. For stems, get them in Suno, download them, and open them together in Bounce. Suno counts one download per song whatever the format, and re-downloading the same song costs nothing ([Suno Help Center](https://help.suno.com/en/articles/13926145)). Editing in Bounce uses no Suno credits or downloads.

## What you can do

| Tab | What you can do |
|---|---|
| **Edit** | Drag to select, snapping to the detected beats or bars. **Cut out** a section (crossfaded), **Keep only** a section, **Repeat** or **Loop ×4** it, **Split**. **End song here** (3 s fade), **Start song here**, **Trim silence**. Fade in/out with four curve shapes. **Short clip** for 15/30/60 s, which you can save as a new project. Join other takes or extensions with adjustable crossfades at every seam. Correct the beat grid (×2, ÷2, bar start). |
| **Mix** | Load Suno stems as layers of one song. Each has level, balance, mute and solo, plus **Instrumental** and **A cappella** shortcuts. |
| **Sound** | 5-band EQ (high-pass, bass shelf, mid, treble shelf, low-pass) with presets and a response curve. Stereo width with a mono check. Speed (slowed or sped up) showing pitch and BPM. **Tempo & pitch (cloud)**: tempo from 50 % to 200 % without changing the key, or ±12 semitones without changing the tempo, with optional formant preservation; the result opens as a new project. Output gain. |
| **Loudness** | Integrated loudness, true peak, loudness range and short-term graph (ITU-R BS.1770-5 / EBU R 128). Targets: Spotify −14 LUFS, AES −16 LUFS, EBU R 128 −23 LUFS, or custom. True-peak limiter, and an estimate of what Spotify will do on playback. |
| **Export** | MP3 (128–320 kbps CBR) or WAV (16-bit dithered, 24-bit, 32-bit float), at the source rate, 44.1 kHz or 48 kHz. Whole song or just the selection. Title, artist, album, year, genre, track, comment, lyrics and cover art; tags already in the Suno file are kept. Share to Files, AirDrop or other apps, or download. |

Undo and redo cover everything. Projects save automatically on the device. On a computer, keyboard shortcuts are: Space play/pause, ⌘/Ctrl+Z undo, Delete cut, ←/→ nudge the playhead, `[` and `]` set the selection at the playhead, L loop.

Why each feature exists, with sources, is documented in **[docs/PRODUCT.md](docs/PRODUCT.md)**.

### Privacy: what the cloud tempo/pitch tool uploads

Everything except **Tempo & pitch (cloud)** runs on the device. That tool asks before every upload unless you tick “Don’t ask again on this device”. When you confirm:

- The arranged song (clips, crossfades and the stem mix) is sent as one 16-bit WAV file to this app's Worker on Cloudflare. Tags, cover art and the rest of the project are not sent.
- A container started for that job alone runs [Rubber Band](https://breakfastquay.com/rubberband/) on it, and the app downloads the result and opens it as a new project. The original project is not changed.
- The app deletes the job, and its audio, as soon as the result has downloaded or when you cancel. If neither happens, the container stops about 5 minutes after the last request. Cloudflare discards a container's disk when it stops ([Containers FAQ](https://developers.cloudflare.com/containers/faq/#is-disk-persistent-what-happens-to-my-disk-when-my-container-sleeps)). Every job is also stopped 30 minutes after it starts.
- Limits: songs up to 8 min 20 s and 100 MB, 4 new jobs per minute per IP address (counted separately in each Cloudflare location, so approximate: [rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), and 100 jobs per day across all users. A job counts toward the daily limit once it passes the checks, even if the server is too busy to start it.

## How it is verified

The audio engine is pure TypeScript and covered by automated tests:
- **Loudness meter:** the EBU Tech 3341 and 3342 test cases at 44.1 and 48 kHz, the BS.1770-5 coefficient tables, and a cross-check against ffmpeg's `ebur128` filter.
- **Limiter:** true-peak ceiling checked on very hot material.
- **Resampler:** SNR and aliasing measured.
- **Beat tracker:** tempo and beat timing on synthetic grooves.
- **WAV, ID3 and MP3:** validated with ffprobe.
- **Timeline edits:** fuzz-tested against a reference model.
- **Cloud upload:** format checked with ffprobe and peak level with ffmpeg's `astats`.

The cloud server has integration tests that need Docker (`npm run test:container`). They build `container/` and check, with ffprobe and a zero-crossing pitch measurement of the ffmpeg-decoded output, that +2 and −3 semitone shifts land within 0.5 Hz of the expected frequency and that a ×1.25 tempo change gives the expected length. They also run the Worker and Durable Objects under `wrangler dev`: request validation, a job end to end, removal of the container on delete, the daily limit and the per-IP rate limit.

Playwright drives the built app on a phone-sized touch viewport: import, editing, loudness normalisation, MP3 and WAV export (with the exported files measured by ffmpeg), persistence, offline use, a check that the browser's own filters match the export filters, and the cloud tempo/pitch flow against a mocked API.

Not yet tested: real Suno downloads (none were available while building), real iOS or Android devices (Chromium emulation only), and the cloud tool on Cloudflare itself. See the limitations in [docs/PRODUCT.md](docs/PRODUCT.md#6-known-limitations-and-open-questions).

## Develop

Requires Node 22+. The tests also need `ffmpeg`/`ffprobe` on the PATH, and the container tests need Docker.

```sh
npm install
npm run dev             # http://localhost:5173 (also on your LAN, so you can try it on a phone)
npm run typecheck       # app and Worker
npm test                # unit tests (Vitest)
npm run test:container  # Rubber Band container and /api Worker (Docker)
npm run test:e2e        # build + Playwright end-to-end tests (Chromium)
npm run build           # production build in dist/
```

`npm run dev` serves the app only. To try the cloud tool locally, run `npm run preview:cf` with Docker running: `wrangler dev` builds the container image and runs it.

Project layout:

```
src/dsp/        loudness (BS.1770-5), true peak, limiter, biquads (W3C formulas), resampler, beats (Ellis 2007), fades, FFT
src/io/         WAV read/write, ID3v2 read/write, MP3 frame parsing, MP3 encoder wrapper, browser decoding
src/model/      project types, timeline operations, presets, undo history
src/engine/     offline renderer, export (two-pass loudness normalisation), cloud upload rendering
src/cloud/      cloud tempo/pitch parameters (shared with the Worker) and browser API client
src/audio/      Web Audio preview player + AudioWorklet limiter
src/workers/    MP3 encoding and beat analysis workers
src/storage/    IndexedDB persistence
src/ui/         Preact UI (library, editor, waveform, panels)
worker/         Cloudflare Worker for /api/* and its Durable Objects (one per job, plus a daily quota)
container/      Rubber Band container: Dockerfile and a small HTTP server
build/          service-worker generator (Vite plugin + template)
tests/          Vitest unit tests (tests/container: Docker integration tests)      e2e/  Playwright tests
```

## Deploy

Bounce runs on **Cloudflare Workers** (`wrangler.jsonc`). Static files are served from `dist/` by the asset server. Requests for static assets are free and unlimited ([Cloudflare docs](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), as long as the opt-in Workers Caching feature stays off ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Only `/api/*` runs the Worker (`worker/index.ts`), which drives a [Container](https://developers.cloudflare.com/containers/) built from `container/Dockerfile`. Containers need the Workers Paid plan. Response headers for static files are set in `public/_headers`.

**Deploys run from GitHub Actions.** The `deploy` job in `.github/workflows/ci.yml` runs on every push to `main` after the `test` job passes. It builds the app and runs `npx wrangler deploy`, which uploads the Worker and assets and builds and pushes the container image with the runner's Docker. Pull requests run the tests and `wrangler deploy --dry-run`, but deploy nothing. There are no preview URLs: Cloudflare does not generate Version URLs for Workers with Durable Objects, which includes Containers ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)).

**One-time setup:**

1. In the Cloudflare dashboard, go to **Workers & Pages** → `bounce` → **Settings** → **Builds** → **Disconnect** ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/#disconnecting-builds)), so that Workers Builds no longer deploys `main` as well. Do this before merging, or both will deploy.
2. Create an API token from the **Edit Cloudflare Workers** template, limited to your account ([docs](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)). The docs don't say whether pushing container images needs a further permission (unverified). If the first deploy fails with an authorisation error at the image push, add the Containers edit permission to the token.
3. In GitHub → **Settings** → **Secrets and variables** → **Actions**, add the repository secrets `CLOUDFLARE_API_TOKEN` (the token) and `CLOUDFLARE_ACCOUNT_ID` ([where to find it](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)).

After the first deploy, container requests can fail for several minutes while Cloudflare provisions the container ([docs](https://developers.cloudflare.com/containers/get-started/)).

**Cost controls** are in `wrangler.jsonc`: at most 3 containers at once (`max_instances`), the `basic` instance type (¼ vCPU, 1 GiB memory, 4 GB disk), 4 new jobs per minute per IP address, and 100 jobs per day (`DAILY_JOB_LIMIT`). Containers are billed for provisioned memory and disk while awake and for CPU while busy, with a monthly allowance on Workers Paid ([pricing](https://developers.cloudflare.com/containers/platform/pricing/)).

**Local check of the production setup:** `npm run preview:cf` builds the app and serves it with `wrangler dev`, the same asset server and headers as production, with the container running in Docker. `npm run test:e2e:cf` runs the end-to-end tests against `wrangler dev` with containers disabled, and CI does the same.

The build uses relative URLs, so `dist/` also works on any other static host, without the cloud tool.

## Licence

MIT, see [LICENSE](LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Note that MP3 encoding uses LAME, which is LGPL. The cloud container runs Rubber Band (GPL-2.0-or-later) on the server; it is not shipped to browsers.
