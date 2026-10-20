# Bounce: what it does and why

This document records the research behind the feature set, the decisions that follow from it, what was deliberately left out, and what is still unverified. Claims are sourced inline. Anything that rests on a secondary source or on reasoning rather than a source says so where it appears.

## 1. Facts about Suno files that shape the app

| Fact | Consequence for the app | Source |
|---|---|---|
| MP3 download is available on every plan, on web and mobile. WAV needs Pro or Premier and is offered only on suno.com; "mobile downloads default to MP3". | MP3 handling (decode, re-encode at 320 kbps, keep the ID3 tags) has to be excellent, because phone users will mostly have MP3s. WAV is fully supported for paid users. | Suno Help Center, ["What types of files can I download?"](https://help.suno.com/en/articles/13926081) and ["Why can't I download wav files?"](https://help.suno.com/en/articles/2479873) |
| Free accounts get 7 lifetime trial downloads, Pro 20 a month, Premier 60 a month. One song counts as one download "regardless of format"; downloading it again costs nothing; stems are part of that song's download. | Download a song once and do every edit and version locally. The app never needs anything from Suno beyond files you already have. | Suno Help Center, ["Upcoming Changes FAQ"](https://help.suno.com/en/articles/13614785) and ["What counts as one download?"](https://help.suno.com/en/articles/13926145) |
| Stem downloads exist (two-way vocals/instrumental, or more parts). Studio exports are WAV. | A stem mixer is a core feature: load sample-aligned stems as layers of one song and rebalance them. | Suno Help Center, [Song Editor](https://help.suno.com/en/articles/6141505), [Exporting from Studio](https://help.suno.com/en/articles/8128193); the 12-stem list comes from a third-party API page (unverified) |
| Suno's own Song Editor offers crop/remove, fades, moving sections, replace section and extend. | Bounce does not compete on generative editing. It covers what happens after download: offline editing, stems, loudness, tags and export formats. | Suno Help Center, [How to Use: Song Editor](https://help.suno.com/en/articles/6141505) |
| WAV sample rate: third-party write-ups disagree (44.1 kHz/16-bit vs 48 kHz/16-bit). The MP3 bitrate is not documented anywhere found. **Unverified.** | Never assume a rate. Read each file's native rate (WAV header or MP3 frame header), keep it as the project rate, and offer 44.1/48 kHz conversion on export. | [musicmake.ai](https://musicmake.ai/blog/suno-v5-audio-quality-khz-2026) and [veena.studio](https://www.veena.studio/blog/suno-download-limits) (secondary) |
| Song length: up to 8 minutes per generation is reported by third parties. **Unverified.** | The renderer streams in fixed blocks, so memory does not grow with length; see §6 for decoded-audio memory. | [apiframe.ai](https://apiframe.ai/models/suno) (secondary) |
| "Shimmer" artifacts in roughly 4–12 kHz are described by a community de-shimmer tool. **Unverified.** | Offer a "Tame harsh highs" EQ preset (a high-shelf cut), described as softening rather than removing. | [TheApeMachine/deshimmer](https://github.com/TheApeMachine/deshimmer) README (third-party) |

## 2. Jobs and the features that answer them

| Job a Suno user has | Feature |
|---|---|
| The song ends abruptly or has junk after the ending | **End song here** (trims at the playhead and adds a 3 s fade), **Fade out** with four curve shapes |
| Dead air at the start or end | **Trim silence** (−55 dBFS threshold, 10 ms pre-roll, 100 ms post-roll) |
| A bad verse, a garbled line or a repeated chorus | **Cut out** the selection. The join gets a 15 ms equal-power crossfade, adjustable per seam up to 2 s. Selections **snap to beats or bars**. |
| Shorter radio edit, or a longer version | Repeated **Cut out**; **Repeat it**; **Loop ×4** |
| 15/30/60 s clip for Reels/TikTok/Shorts, or a ringtone | **Short clip**: selects from the bar before the playhead and loops it. Then **Save selection as a new project** (with fades) or **Export this part**. |
| Combine the best parts of two generations, or join an extension | Import several files with **Join**, or **Insert at playhead** / **Add at end**, then cut and crossfade |
| Louder vocals, an instrumental or a cappella version, mute one harsh part | **Mix** tab: per-stem level, balance, mute and solo; **Instrumental** and **A cappella** shortcuts |
| Harsh or muddy tone, low rumble | **Sound** tab: high-pass, low shelf, mid peak, high shelf and low-pass, with presets and a live response curve |
| Check mono compatibility, or widen/narrow the image | **Stereo width**, including **Mono check** |
| "Slowed" or "sped up" versions | **Speed** (varispeed: tempo and pitch together), showing the resulting semitones and BPM |
| Release-ready loudness for streaming | **Loudness** tab: BS.1770-5 measurement, target presets, true-peak limiter, and a preview of what Spotify will do on playback |
| Correct tags and cover art | ID3v2.3 tags (title, artist, album, year, genre, track, BPM, comment, lyrics, cover) in MP3; RIFF INFO plus an `id3 ` chunk in WAV. Existing Suno tags and cover art are read and kept. |
| Get the file out of the phone | Web Share (save to Files, AirDrop, messaging apps) or a download link. A player on the result card lets you check the file first. |
| Work without signal; keep songs private | Installable offline web app. All processing runs on the device and files are stored in IndexedDB. |

On the question "why not just use Suno's editor": Suno's help pages do not say whether an edited copy counts as a separate song for download limits, so this document does not claim it does. What is certain is that local edits cost no credits and no downloads, work offline, and add things Suno's download does not: loudness normalisation with true-peak limiting, stem remixing, MP3/WAV format choice, and tags.

## 3. Deliberate non-goals

- **Generative edits** (replace a section, extend with AI): Suno does these on its servers.
- **On-device AI stem separation**: Suno already provides stems. Running a separation model inside a phone browser is a heavy undertaking (a design judgement, not measured here).
- **Fetching audio from Suno share links**: this would bypass Suno's download quota. Bounce only opens files you downloaded yourself.
- **De-noising or "de-shimmer"**: EQ can soften harsh bands but cannot remove artifacts. Regenerating in Suno is often the better fix.
- **Changing tempo without pitch, or pitch without tempo**: good results need a phase vocoder or similar. It is on the roadmap, not shipped half-done.
- **AAC/M4R** (iPhone ringtone format): browsers cannot reliably encode AAC across platforms, so export is MP3 or WAV.
- **Overlapping multitrack timeline**: the arrangement is a sequence of clips. Stems are layers of a clip, not free-floating tracks.

## 4. Technical decisions and their basis

- **Installable web app (PWA), no app store.** It runs on iOS and Android from one codebase, works offline through a service worker, and keeps files in IndexedDB. WebKit deletes script-writable storage, IndexedDB included, after 7 days of Safari use without interaction with the site; Home Screen web apps are exempt ([WebKit: Tracking Prevention](https://webkit.org/tracking-prevention/)). The library therefore asks iOS users to add the app to the Home Screen.
- **Decode at the file's native rate.** `decodeAudioData` resamples to the context's sample rate (W3C Web Audio API, decodeAudioData step 5). Bounce therefore parses WAV itself, and decodes MP3 on an `OfflineAudioContext` created at the rate read from the MP3 frame header.
- **One export pipeline, mirrored by the preview.** Export runs in TypeScript, so it is deterministic and unit-testable: arrangement → speed/SRC → EQ → width → gain → fades → limiter → meter → encoder. The live preview uses Web Audio nodes driven by the same parameters. The EQ uses the exact W3C BiquadFilterNode formulas (§1.13.5), and an end-to-end test checks that Chromium's native filter output matches the export filters to within 1e-4. The limiter in the preview is the same TypeScript class, running in an AudioWorklet.
- **Loudness: ITU-R BS.1770-5.** K-weighting coefficients for any sample rate are derived algebraically from the Recommendation's 48 kHz tables (Tables 1–2), which they reproduce exactly at 48 kHz. Gating uses 400 ms blocks with 75% overlap, a −70 LKFS absolute gate and a −10 LU relative gate. True peak uses the Annex 2 4× FIR interpolator. Loudness range follows EBU Tech 3342. Momentary (0.4 s) and short-term (3 s) windows follow EBU Tech 3341.
- **Loudness targets with primary sources only.** Spotify: −14 LUFS integrated, true peak below −1 dBTP, or −2 dBTP for masters louder than −14 LUFS ([Spotify for Artists](https://support.spotify.com/artists/article/loudness-normalization/)). EBU R 128-2023: −23.0 LUFS, maximum −1 dBTP (read directly). AES TD1008: music normalised to no more than −16 LUFS, as reported by AES-affiliated summaries; the PDF could not be retrieved from aes.org here, so that preset's −1 dBTP ceiling is the app's own default. Apple Music and YouTube targets are omitted because only third-party figures were found.
- **Normalisation.** Pass 1 measures the processed audio. Pass 2 applies `target − measured` gain through the limiter. If the limiter will engage (measured true peak + gain > ceiling), the result is re-measured and the gain corrected, up to three times.
- **True-peak limiter.** Look-ahead and stereo-linked. The required gain per sample is held over the look-ahead window and then box-filtered, so the applied gain is provably no higher than each sample requires (derivation in `src/dsp/limiter.ts`). The detector includes the Annex 2 interpolated values. In tests, output true peak stayed within 0.003 dB of the ceiling even with 20 dB of gain reduction, and a 0.02 dB internal margin absorbs that.
- **Beat grid: Ellis (2007), "Beat Tracking by Dynamic Programming", J. New Music Research 36(1).** Onset envelope: 8 kHz, 32 ms window and 4 ms hop, 40 Mel bands, rectified difference. Tempo prior: log-Gaussian with τ0 = 0.5 s and σ = 1.4 octaves, refined with eqs. 7–8. Dynamic programming with α = 680, the paper's best value. Bar phase is a heuristic guess (the beat phase with the strongest onsets), and the user can correct it.
- **Resampling.** Kaiser-windowed sinc with 32 zero crossings per side and β = 9, following the table-lookup method of J. O. Smith ("Digital Audio Resampling", CCRMA). Rational ratios such as 44.1↔48 kHz use exact polyphase rows.
- **16-bit WAV uses TPDF dither (±1 LSB).** Standard practice per Lipshitz, Wannamaker & Vanderkooy, "Quantization and Dither: A Theoretical Survey", JAES 40(5), 1992. *(Citation from memory; not re-checked in this session.)*
- **MP3 encoding.** LAME compiled to WebAssembly (`wasm-media-encoders`), constant bitrate, running in a Web Worker. Constant bitrate avoids relying on a Xing/LAME VBR header for duration.

## 5. Verification

These are automated and run in CI:

- **EBU Tech 3341 minimum-requirement cases at 44.1 and 48 kHz.** Cases 1–6, 9, 10, 12 and 13 pass within ±0.1 LU. True-peak cases 15–19 pass within +0.2/−0.4 dB.
- **EBU Tech 3342 LRA cases 1–4** pass within ±1 LU.
- **K-weighting coefficients** match BS.1770-5 Tables 1–2 to 1e-12.
- **Cross-check against ffmpeg's `ebur128` filter** on synthetic music: integrated loudness and LRA agree within ffmpeg's displayed 0.1 precision (for example −12.506 vs −12.5 LUFS). True peak differs by at most 0.071 dB (−13.071 vs ffmpeg's −13); ffmpeg prints one decimal and uses its own oversampler.
- **Limiter:** output true peak is at or below the ceiling on +4 to +20 dBTP material and on worst-case fs/4 tones.
- **Resampler:** SNR for 44.1→48 kHz measured at 118.5 dB (1 kHz tone) and 109.6 dB (15 kHz tone), with 90 dB as the test threshold. For 48→44.1 kHz, an 18 kHz tone is at −0.004 dB and a 23 kHz tone aliases at −93.5 dB, against thresholds of 0.05 dB and −85 dB.
- **Beat tracker:** tempo within 1 BPM and median beat error under 20 ms on synthetic 96/120/140 BPM grooves.
- **WAV, ID3 and MP3:** round trips, reading ffmpeg-written ID3v2.3/2.4 tags with cover art, and ffprobe validation of exported files (codec, bitrate, tags, cover, duration).
- **Timeline:** 200 random edit sequences checked against a frame-by-frame reference model.
- **End to end (Chromium, 390×844 touch viewport):**
  - Import of a tagged MP3 and of a pair of stems.
  - Select, cut, undo/redo, trim silence and fade.
  - Measure, normalise to −14 LUFS, and export MP3 320 and WAV 24-bit. ffmpeg independently measures the WAV at −14 ±0.15 LUFS with true peak ≤ −0.9 dBTP.
  - Persistence across reloads, and a full export while offline.

## 6. Known limitations and open questions

- **No real Suno files were available in this session.** All fixtures are synthetic, so behaviour on actual Suno MP3s and WAVs (encoder delay, tags, loudness) still needs a check with real downloads.
- **Only tested in Chromium with mobile emulation.** iOS Safari specifics are untested on a device: the silent-switch workaround `navigator.audioSession.type = 'playback'`, AudioWorklet, Web Share with files, and memory limits.
- **Memory.** Decoded audio is 32-bit float, so 8 minutes of 48 kHz stereo is 8·60·48000·2·4 B ≈ 184 MB per layer. Twelve such stems is about 2.2 GB, which may exceed a phone browser's limit. Two stems (vocals and instrumental) are about 370 MB.
- **The beat tracker has only been evaluated on synthetic grooves.** Songs with tempo drift or rubato may need the ×2/÷2 and bar-phase controls, or snapping turned off.
- **Waveform display of stems** sums per-layer peak envelopes, which is an upper bound and not the exact mixed waveform.

## 7. Roadmap candidates

Phase-vocoder time-stretch and pitch-shift; lossless MP3 trimming at frame boundaries for trim-only edits; key detection; a reverb for "slowed + reverb"; `file_handlers` for desktop "Open with".
