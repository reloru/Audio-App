import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { encodeWav, parseWav, wavHeader, WavEncoder, concatBytes } from '../src/io/wav';
import { readId3, writeId3v23, id3v2Length } from '../src/io/id3';
import { mp3Info } from '../src/io/mp3info';
import { openMp3Stream } from '../src/io/mp3encoder';
import { ffmpegDecode, ffprobe, musicLike, sine, tmp } from './helpers';

const require = createRequire(import.meta.url);
const mp3Wasm = () => readFileSync(require.resolve('wasm-media-encoders/wasm/mp3')).buffer as ArrayBuffer;

// A tiny valid PNG (1x1, red).
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('WAV', () => {
  const fs = 44100;
  const x = musicLike(fs, 2, 120, 1, 0.4);

  it('float32 round trip is exact', () => {
    const p = parseWav(encodeWav(fs, x, 'float32').buffer as ArrayBuffer);
    expect(p.sampleRate).toBe(fs);
    expect(p.channels.length).toBe(2);
    expect(p.formatCode).toBe(3);
    for (let c = 0; c < 2; c++) expect(p.channels[c]).toEqual(x[c]);
  });

  it('16- and 24-bit round trips are within one quantisation step (undithered)', () => {
    for (const [fmt, lsb] of [
      ['pcm16', 1 / 32768],
      ['pcm24', 1 / 8388608],
    ] as const) {
      const p = parseWav(encodeWav(fs, x, fmt, undefined, false).buffer as ArrayBuffer);
      let maxErr = 0;
      for (let c = 0; c < 2; c++) for (let i = 0; i < x[c].length; i++) maxErr = Math.max(maxErr, Math.abs(p.channels[c][i] - x[c][i]));
      expect(maxErr).toBeLessThanOrEqual(lsb / 2 + 1e-12);
    }
  });

  it('TPDF dither error is bounded by 1.5 LSB and has ~zero mean', () => {
    const p = parseWav(encodeWav(fs, x, 'pcm16', undefined, true).buffer as ArrayBuffer);
    let maxErr = 0,
      sum = 0,
      n = 0;
    for (let i = 0; i < x[0].length; i++) {
      const e = p.channels[0][i] - x[0][i];
      maxErr = Math.max(maxErr, Math.abs(e));
      sum += e;
      n++;
    }
    expect(maxErr).toBeLessThanOrEqual(1.5 / 32768 + 1e-9);
    expect(Math.abs(sum / n)).toBeLessThan(0.05 / 32768);
  });

  it('writes LIST/INFO and id3 chunks that read back and that ffprobe accepts', () => {
    const info = { title: 'Neon Ünicode', artist: 'Me', album: 'LP', date: '2026', genre: 'Synthwave', comment: 'hi' };
    const id3 = writeId3v23({ title: 'Neon Ünicode', artist: 'Me', cover: { mime: 'image/png', data: PNG } });
    const bytes = encodeWav(fs, x, 'pcm24', { info, id3 });
    const p = parseWav(bytes.buffer as ArrayBuffer);
    expect(p.info).toMatchObject(info);
    expect(readId3(p.id3!).cover?.data).toEqual(PNG);
    const dir = tmp();
    const f = join(dir, 'tagged.wav');
    writeFileSync(f, bytes);
    const probe = ffprobe(f) as { format: { tags?: Record<string, string>; duration: string }; streams: { sample_rate: string; bits_per_raw_sample?: string; codec_name: string }[] };
    expect(probe.streams[0].codec_name).toBe('pcm_s24le');
    expect(Number(probe.format.duration)).toBeCloseTo(2, 2);
    const tags = Object.fromEntries(Object.entries(probe.format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(tags.title).toBe('Neon Ünicode');
    expect(tags.artist).toBe('Me');
  });

  it('parses WAVs written by ffmpeg (s16, s24, s32, f64, extensible) and reads the header cheaply', () => {
    const dir = tmp();
    const src = join(dir, 'src.wav');
    writeFileSync(src, encodeWav(48000, sine(48000, 0.5, 440, -6), 'float32'));
    for (const [codec, extra] of [
      ['pcm_s16le', []],
      ['pcm_s24le', []],
      ['pcm_s32le', []],
      ['pcm_f64le', []],
      ['pcm_s16le', ['-rf64', 'never', '-write_bext', '0', '-ac', '2', '-channel_layout', 'stereo']],
    ] as const) {
      const out = join(dir, `${codec}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c:a', codec, ...extra, out]);
      const buf = readFileSync(out);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      const p = parseWav(ab);
      expect(p.sampleRate).toBe(48000);
      expect(p.channels[0].length).toBe(24000);
      expect(wavHeader(ab)?.sampleRate).toBe(48000);
      let pk = 0;
      for (const v of p.channels[0]) pk = Math.max(pk, Math.abs(v));
      expect(20 * Math.log10(pk)).toBeCloseTo(-6, 1);
    }
  });

  it('incremental encoder output equals one-shot output', () => {
    const enc = new WavEncoder(fs, 2, 'pcm16', false);
    const parts = [enc.encode(x.map((c) => c.subarray(0, 1000))), enc.encode(x.map((c) => c.subarray(1000)))];
    const inc = concatBytes([enc.header(), ...parts, enc.trailer()]);
    expect(inc).toEqual(encodeWav(fs, x, 'pcm16', undefined, false));
  });
});

describe('ID3', () => {
  const meta = {
    title: 'Café Ünder the Moon 🌙',
    artist: 'Suno user',
    album: 'Demos',
    year: '2026',
    genre: 'Lo-fi',
    track: '3',
    bpm: '92',
    comment: 'made with Suno',
    lyrics: '[Verse]\nla la la',
    cover: { mime: 'image/png', data: PNG },
  };

  it('v2.3 writer round-trips through the reader', () => {
    const tag = writeId3v23(meta);
    expect(id3v2Length(tag)).toBe(tag.length);
    expect(readId3(tag)).toEqual(meta);
  });

  it('reads tags and cover art written by ffmpeg as ID3v2.4 and v2.3', () => {
    const dir = tmp();
    const wav = join(dir, 'a.wav');
    const png = join(dir, 'c.png');
    writeFileSync(wav, encodeWav(44100, sine(44100, 1, 440, -12), 'pcm16'));
    writeFileSync(png, PNG);
    for (const v of ['4', '3']) {
      const out = join(dir, `t${v}.mp3`);
      execFileSync('ffmpeg', [
        '-v', 'error', '-y', '-i', wav, '-i', png, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '192k',
        '-c:v', 'copy', '-id3v2_version', v, '-metadata', 'title=Ünïcode Title', '-metadata', 'artist=Someone',
        '-metadata', 'album=Alb', '-metadata', 'date=2025', '-metadata', 'genre=Pop', '-metadata', 'comment=Nice',
        '-metadata:s:v', 'comment=Cover (front)', out,
      ]);
      const m = readId3(new Uint8Array(readFileSync(out)));
      expect(m.title).toBe('Ünïcode Title');
      expect(m.artist).toBe('Someone');
      expect(m.album).toBe('Alb');
      expect(m.year).toBe('2025');
      expect(m.genre).toBe('Pop');
      expect(m.comment).toBe('Nice');
      expect(m.cover?.mime).toBe('image/png');
      expect(m.cover?.data).toEqual(PNG);
      const info = mp3Info(new Uint8Array(readFileSync(out)));
      expect(info?.sampleRate).toBe(44100);
    }
  });
});

describe('MP3 encoding (LAME via wasm-media-encoders)', () => {
  it('produces a valid CBR stream that decodes back close to the input, with ID3 tags', async () => {
    const fs = 48000;
    const x = musicLike(fs, 6, 120, 2, 0.4);
    const s = await openMp3Stream(mp3Wasm(), fs, 2, 320);
    const parts: Uint8Array[] = [writeId3v23({ title: 'Test Song', artist: 'Bounce', cover: { mime: 'image/png', data: PNG } })];
    for (let off = 0; off < x[0].length; off += 4096) parts.push(s.encode(x.map((c) => c.subarray(off, Math.min(x[0].length, off + 4096)))));
    parts.push(s.finish());
    const bytes = concatBytes(parts);
    const dir = tmp();
    const f = join(dir, 'out.mp3');
    writeFileSync(f, bytes);
    const probe = ffprobe(f) as { format: { tags?: Record<string, string>; duration: string; bit_rate: string }; streams: { codec_name: string; sample_rate: string; bit_rate?: string; disposition?: Record<string, number> }[] };
    const audio = probe.streams.find((st) => st.codec_name === 'mp3')!;
    expect(audio.sample_rate).toBe('48000');
    expect(Number(audio.bit_rate)).toBe(320000);
    expect(probe.streams.some((st) => st.disposition?.attached_pic === 1)).toBe(true);
    expect(probe.format.tags?.title).toBe('Test Song');
    expect(Number(probe.format.duration)).toBeGreaterThan(5.95);
    expect(Number(probe.format.duration)).toBeLessThan(6.2);
    expect(mp3Info(bytes)?.sampleRate).toBe(48000);

    // Align decoded output to the input (encoder/decoder delay) and check SNR.
    const y = ffmpegDecode(f);
    let bestLag = 0,
      best = -Infinity;
    for (let lag = 0; lag < 3000; lag++) {
      let s2 = 0;
      for (let i = 10000; i < 30000; i++) s2 += x[0][i] * y[0][i + lag];
      if (s2 > best) {
        best = s2;
        bestLag = lag;
      }
    }
    let sig = 0,
      err = 0;
    for (let i = 10000; i < x[0].length - 10000; i++) {
      sig += x[0][i] ** 2;
      err += (x[0][i] - y[0][i + bestLag]) ** 2;
    }
    expect(10 * Math.log10(sig / err)).toBeGreaterThan(20);
  });

  it('rejects sample rates MP3 cannot carry', async () => {
    await expect(openMp3Stream(mp3Wasm(), 96000, 2, 320)).rejects.toThrow(/32, 44.1 or 48 kHz/);
  });
});
