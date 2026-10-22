import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '../src/io/wav';

export const dbfs = (db: number) => Math.pow(10, db / 20);

/** Sine with the given per-channel peak level (dBFS) on all channels. */
export function sine(
  fs: number,
  seconds: number,
  freq: number,
  peakDb: number,
  channels = 2,
  phaseDeg = 0,
): Float32Array[] {
  const n = Math.round(fs * seconds);
  const a = dbfs(peakDb);
  const ph = (phaseDeg * Math.PI) / 180;
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = a * Math.sin((2 * Math.PI * freq * i) / fs + ph);
  return Array.from({ length: channels }, () => ch.slice());
}

export function silence(fs: number, seconds: number, channels = 2): Float32Array[] {
  const n = Math.round(fs * seconds);
  return Array.from({ length: channels }, () => new Float32Array(n));
}

export function concat(...parts: Float32Array[][]): Float32Array[] {
  const nch = parts[0].length;
  return Array.from({ length: nch }, (_, c) => {
    const len = parts.reduce((s, p) => s + p[c].length, 0);
    const out = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p[c], o);
      o += p[c].length;
    }
    return out;
  });
}

export function repeat(part: Float32Array[], times: number): Float32Array[] {
  return concat(...Array.from({ length: times }, () => part));
}

/** Deterministic pseudo-random generator for test signals. */
export function rng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** A crude "music-like" test signal: drums + bass + chords with dynamics. */
export function musicLike(fs: number, seconds: number, bpm = 120, seed = 7, level = 0.5): Float32Array[] {
  const n = Math.round(fs * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const r = rng(seed);
  const beat = (60 / bpm) * fs;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const posInBeat = i % beat;
    const beatIdx = Math.floor(i / beat);
    const tb = posInBeat / fs;
    let kick = 0;
    if (beatIdx % 2 === 0) kick = Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-tb * 30)) * tb) * Math.exp(-tb * 8);
    let snare = 0;
    if (beatIdx % 2 === 1) snare = (r() * 2 - 1) * Math.exp(-tb * 18) * 0.6;
    const half = posInBeat % (beat / 2);
    const hat = (r() * 2 - 1) * Math.exp(-(half / fs) * 60) * 0.15;
    const bass = 0.3 * Math.sin(2 * Math.PI * 55 * (1 + (Math.floor(beatIdx / 4) % 2) * 0.122) * t);
    const pad = 0.12 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t));
    const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 16);
    const m = (kick * 0.9 + snare + bass) * level;
    L[i] = m + (pad * env + hat * 0.8) * level;
    R[i] = m + (pad * env * 0.8 + hat) * level;
  }
  return [L, R];
}

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'bounce-test-'));
}

export function writeTempWav(fs: number, channels: Float32Array[], name = 'in.wav'): string {
  const dir = tmp();
  const p = join(dir, name);
  writeFileSync(p, encodeWav(fs, channels, 'float32'));
  return p;
}

/** Integrated loudness, LRA and true peak according to ffmpeg's ebur128 filter. */
export function ffmpegEbur128(path: string): { I: number; LRA: number; TP: number } {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  return parseEbur(r.stderr);
}

function parseEbur(stderr: string): { I: number; LRA: number; TP: number } {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = Number(/I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary)?.[1]);
  const LRA = Number(/LRA:\s+(-?[\d.]+)\s+LU/.exec(summary)?.[1]);
  const TP = Number(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary)?.[1]);
  return { I, LRA, TP };
}

export function ffprobe(path: string): Record<string, unknown> {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

/** Decode any file with ffmpeg to float32 interleaved stereo at its native rate. */
export function ffmpegDecode(path: string, channels = 2): Float32Array[] {
  const dir = tmp();
  const out = join(dir, 'dec.f32');
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', String(channels), out]);
  const buf = readFileSync(out);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = all.length / channels;
  return Array.from({ length: channels }, (_, c) => {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = all[i * channels + c];
    return ch;
  });
}
