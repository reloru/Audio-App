# Third-party software

The built app includes the following packages.

| Package | Used for | Licence |
|---|---|---|
| [preact](https://github.com/preactjs/preact) | UI rendering | MIT |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper | ISC |
| [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) | JavaScript wrapper around a WebAssembly build of LAME | MIT (wrapper) |
| [LAME](https://lame.sourceforge.io/) (inside `mp3-*.wasm`) | MP3 encoding | GNU LGPL |

LAME is shipped as a separate, unmodified WebAssembly file (`assets/mp3-*.wasm`), loaded at runtime by the MP3 worker. Anyone can replace it with another build of the same encoder. LAME's source code is available from the LAME project. The build used here comes from the `wasm-media-encoders` package.

## Server-side container (cloud tempo/pitch)

The container image built from `container/Dockerfile` runs on Cloudflare and is not shipped to browsers. It installs these Debian 13 (trixie) packages unmodified. Licences are from each package's `/usr/share/doc/<package>/copyright` file in the image (main `Files: *` entry).

| Package | Used for | Licence |
|---|---|---|
| [Rubber Band](https://breakfastquay.com/rubberband/) 3.3.0 (`rubberband-cli`) | Time stretching and pitch shifting | GPL-2.0-or-later |
| libsndfile 1.2.2 | WAV reading and writing for Rubber Band | LGPL-2.1-or-later |
| libsamplerate 0.2.2 | Sample-rate conversion inside Rubber Band | BSD-2-Clause |
| FFTW 3.3.10 | FFTs inside Rubber Band | GPL-2.0-or-later |
| Python 3.13 | `container/server.py` | Python Software Foundation License Version 2 |

Source code for the Debian packages is available from the Debian archive (`apt-get source <package>`, or [sources.debian.org](https://sources.debian.org/)).

## Standards and publications implemented (no code copied)

- ITU-R BS.1770-5
- EBU R 128, EBU Tech 3341 and Tech 3342
- W3C Web Audio API, BiquadFilterNode formulas
- D. P. W. Ellis, “Beat Tracking by Dynamic Programming” (2007)
- J. O. Smith, “Digital Audio Resampling”
- id3.org ID3v2.3/2.4
