# Bounce — pocket editor for Suno songs

Bounce is a free, mobile-first web app for editing the MP3 and WAV files you download from [Suno](https://suno.com). You can trim, cut, loop, fix endings, join takes, remix stems, EQ, change speed and master to streaming loudness, then export a tagged MP3 or WAV. It runs entirely on your phone or computer, works offline once loaded, and never uploads your audio.

> Not affiliated with Suno. “Suno” is a trademark of its owner.

## Use it

Once the Cloudflare Worker is connected (see [Deploy](#deploy)), open **https://bounce.&lt;your-subdomain&gt;.workers.dev** on your phone. Cloudflare shows the exact address after the first build.

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
| **Sound** | 5-band EQ (high-pass, bass shelf, mid, treble shelf, low-pass) with presets and a response curve. Stereo width with a mono check. Speed (slowed or sped up) showing pitch and BPM. Output gain. |
| **Loudness** | Integrated loudness, true peak, loudness range and short-term graph (ITU-R BS.1770-5 / EBU R 128). Targets: Spotify −14 LUFS, AES −16 LUFS, EBU R 128 −23 LUFS, or custom. True-peak limiter, and an estimate of what Spotify will do on playback. |
| **Export** | MP3 (128–320 kbps CBR) or WAV (16-bit dithered, 24-bit, 32-bit float), at the source rate, 44.1 kHz or 48 kHz. Whole song or just the selection. Title, artist, album, year, genre, track, comment, lyrics and cover art; tags already in the Suno file are kept. Share to Files, AirDrop or other apps, or download. |

Undo and redo cover everything. Projects save automatically on the device. On a computer, keyboard shortcuts are: Space play/pause, ⌘/Ctrl+Z undo, Delete cut, ←/→ nudge the playhead, `[` and `]` set the selection at the playhead, L loop.

Why each feature exists, with sources, is documented in **[docs/PRODUCT.md](docs/PRODUCT.md)**.

## How it is verified

The audio engine is pure TypeScript and covered by automated tests:
- **Loudness meter:** the EBU Tech 3341 and 3342 test cases at 44.1 and 48 kHz, the BS.1770-5 coefficient tables, and a cross-check against ffmpeg's `ebur128` filter.
- **Limiter:** true-peak ceiling checked on very hot material.
- **Resampler:** SNR and aliasing measured.
- **Beat tracker:** tempo and beat timing on synthetic grooves.
- **WAV, ID3 and MP3:** validated with ffprobe.
- **Timeline edits:** fuzz-tested against a reference model.

Playwright drives the built app on a phone-sized touch viewport: import, editing, loudness normalisation, MP3 and WAV export (with the exported files measured by ffmpeg), persistence, offline use, and a check that the browser's own filters match the export filters.

Not yet tested: real Suno downloads (none were available while building) and real iOS or Android devices (Chromium emulation only). See the limitations in [docs/PRODUCT.md](docs/PRODUCT.md#6-known-limitations-and-open-questions).

## Develop

Requires Node 22+. The tests also need `ffmpeg`/`ffprobe` on the PATH.

```sh
npm install
npm run dev          # http://localhost:5173 (also on your LAN, so you can try it on a phone)
npm test             # unit tests (Vitest)
npm run test:e2e     # build + Playwright end-to-end tests (Chromium)
npm run build        # production build in dist/
```

Project layout:

```
src/dsp/        loudness (BS.1770-5), true peak, limiter, biquads (W3C formulas), resampler, beats (Ellis 2007), fades, FFT
src/io/         WAV read/write, ID3v2 read/write, MP3 frame parsing, MP3 encoder wrapper, browser decoding
src/model/      project types, timeline operations, presets, undo history
src/engine/     offline renderer and export (two-pass loudness normalisation)
src/audio/      Web Audio preview player + AudioWorklet limiter
src/workers/    MP3 encoding and beat analysis workers
src/storage/    IndexedDB persistence
src/ui/         Preact UI (library, editor, waveform, panels)
build/          service-worker generator (Vite plugin + template)
tests/          Vitest unit tests      e2e/  Playwright tests
```

## Deploy

Bounce is hosted on **Cloudflare Workers** as a static-assets-only Worker (`wrangler.jsonc`, no Worker script). Requests for static assets are free and unlimited ([Cloudflare docs](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)), as long as the opt-in Workers Caching feature stays off ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). The response headers are set in `public/_headers`.

**One-time setup:** in the Cloudflare dashboard, create a Worker from the GitHub repository using Workers Builds ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)). Use these settings:

- Build command: `npm run build`.
- Deploy command: `npx wrangler deploy` (the default).
- Production branch: `main`.
- Turn on preview builds for non-production branches, and leave the Preview command at its default, `npx wrangler preview`. Every branch, including Claude's `claude-code/…` branches, then gets its own preview URL ([docs](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)), and Cloudflare posts the URL as a comment on the branch's pull request.

Each preview URL is a separate origin, so it starts with an empty project library.

**Local check of the production setup:** `npm run preview:cf` builds the app and serves it with `wrangler dev`, the same asset server and headers as production. `npm run test:e2e:cf` runs the end-to-end tests against it, and CI does the same.

`.github/workflows/ci.yml` runs the type check, the unit tests and the end-to-end tests (on the Cloudflare runtime) for pushes and pull requests. The build uses relative URLs, so `dist/` also works on any other static host.

## Licence

MIT, see [LICENSE](LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Note that MP3 encoding uses LAME, which is LGPL.
