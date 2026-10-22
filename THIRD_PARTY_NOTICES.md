# Third-party software

The built app includes the following packages.

| Package | Used for | Licence |
|---|---|---|
| [preact](https://github.com/preactjs/preact) | UI rendering | MIT |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper | ISC |
| [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) | JavaScript wrapper around a WebAssembly build of LAME | MIT (wrapper) |
| [LAME](https://lame.sourceforge.io/) (inside `mp3-*.wasm`) | MP3 encoding | GNU LGPL |

LAME is shipped as a separate, unmodified WebAssembly file (`assets/mp3-*.wasm`), loaded at runtime by the MP3 worker. Anyone can replace it with another build of the same encoder. LAME's source code is available from the LAME project. The build used here comes from the `wasm-media-encoders` package.

Standards and publications implemented (no code copied):
- ITU-R BS.1770-5
- EBU R 128, EBU Tech 3341 and Tech 3342
- W3C Web Audio API, BiquadFilterNode formulas
- D. P. W. Ellis, “Beat Tracking by Dynamic Programming” (2007)
- J. O. Smith, “Digital Audio Resampling”
- id3.org ID3v2.3/2.4
