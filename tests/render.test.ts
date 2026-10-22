import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { render, ArrangementReader, type LayerAudio } from '../src/engine/render';
import { exportProject, analyzeProject, chooseOutputRate, safeFileName, type Mp3SinkFactory } from '../src/engine/export';
import { newLayer, newProject, newSource } from '../src/model/project';
import { deleteRange } from '../src/model/timeline';
import { parseWav } from '../src/io/wav';
import { openMp3Stream } from '../src/io/mp3encoder';
import { measureLoudness } from '../src/dsp/loudness';
import type { Project } from '../src/model/types';
import { ffprobe, musicLike, sine, tmp } from './helpers';

const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('wasm-media-encoders/wasm/mp3'));

const mp3Factory: Mp3SinkFactory = async (rate, ch, br) => {
  const s = await openMp3Stream(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer, rate, ch, br);
  const parts: Uint8Array[] = [];
  return {
    encode: (c, n) => {
      parts.push(s.encode(c.map((x) => x.subarray(0, n))));
    },
    finish: async () => [...parts, s.finish()],
  };
};

function makeProject(fs: number, layers: Float32Array[][], names = layers.map((_, i) => `layer${i}`)) {
  const ls = layers.map((ch, i) => newLayer(`f${i}`, names[i], ch[0].length, ch.length));
  const source = newSource('Song', ls);
  const project = newProject('Song', fs, [source]);
  const audio: LayerAudio = new Map(ls.map((l, i) => [l.id, { sampleRate: fs, channels: layers[i] }]));
  return { project, audio, source };
}

async function collect(project: Project, audio: LayerAudio, extra: Partial<Parameters<typeof render>[0]> = {}) {
  const out: Float32Array[][] = [];
  const r = await render({ project, audio, outputRate: project.sampleRate, onBlock: (c, n) => void out.push(c.map((x) => x.slice(0, n))), ...extra });
  const len = out.reduce((s, b) => s + b[0].length, 0);
  const res = [new Float32Array(len), new Float32Array(len)];
  let o = 0;
  for (const b of out) {
    res[0].set(b[0], o);
    res[1].set(b[1], o);
    o += b[0].length;
  }
  return { ch: res, r };
}

describe('renderer', () => {
  const fs = 48000;

  it('is bit-exact for an untouched song (no effects, limiter off)', async () => {
    const x = musicLike(fs, 3, 120, 1, 0.5);
    const { project, audio } = makeProject(fs, [x]);
    project.master.limiter = false;
    const { ch } = await collect(project, audio);
    expect(ch[0]).toEqual(x[0]);
    expect(ch[1]).toEqual(x[1]);
  });

  it('mixes stem layers with gain, balance, mute and solo', async () => {
    const a = sine(fs, 1, 440, -12);
    const b = sine(fs, 1, 660, -12);
    const { project, audio, source } = makeProject(fs, [a, b], ['Vocals', 'Instrumental']);
    const reader = () => new ArrangementReader(project, audio).read(1000, 1);
    expect(reader()[0][0]).toBeCloseTo(a[0][1000] + b[0][1000], 6);
    source.layers[1].mute = true;
    expect(reader()[0][0]).toBeCloseTo(a[0][1000], 6);
    source.layers[1].mute = false;
    source.layers[1].solo = true;
    expect(reader()[0][0]).toBeCloseTo(b[0][1000], 6);
    source.layers[1].solo = false;
    source.layers[0].gainDb = -6;
    source.layers[1].mute = true;
    expect(reader()[0][0]).toBeCloseTo(a[0][1000] * Math.pow(10, -6 / 20), 6);
    source.layers[0].balance = 1;
    const [l, r] = reader();
    expect(l[0]).toBe(0);
    expect(r[0]).toBeCloseTo(a[1][1000] * Math.pow(10, -6 / 20), 6);
  });

  it('a cut keeps total length and joins without a click', async () => {
    const x = sine(fs, 4, 220, -6);
    const { project, audio } = makeProject(fs, [x]);
    project.master.limiter = false;
    project.clips = deleteRange(project.clips, 50_000, 87_777, Math.round(0.015 * fs), () => 'n' + Math.random());
    const { ch } = await collect(project, audio);
    expect(ch[0].length).toBe(x[0].length - 37_777);
    // A 220 Hz sine at -6 dBFS changes by at most 2*pi*220/48000*0.5 per sample.
    const bound = ((2 * Math.PI * 220) / fs) * 0.5;
    let maxStep = 0;
    for (let i = 49_000; i < 51_000; i++) maxStep = Math.max(maxStep, Math.abs(ch[0][i] - ch[0][i - 1]));
    expect(maxStep).toBeLessThan(bound * 1.6);
  });

  it('applies speed, fades and selection ranges', async () => {
    const x = sine(fs, 2, 1000, -6);
    const { project, audio } = makeProject(fs, [x]);
    project.master.limiter = false;
    project.speed = 2;
    let { ch } = await collect(project, audio);
    expect(ch[0].length).toBe(Math.floor((96000 - 1) / 2) + 1);
    project.speed = 1;
    project.fadeIn = { seconds: 0.5, curve: 'linear' };
    project.fadeOut = { seconds: 0.5, curve: 'linear' };
    ({ ch } = await collect(project, audio));
    let early = 0,
      mid = 0,
      late = 0;
    for (let i = 0; i < 240; i++) early = Math.max(early, Math.abs(ch[0][i]));
    for (let i = 47_000; i < 49_000; i++) mid = Math.max(mid, Math.abs(ch[0][i]));
    for (let i = 96000 - 240; i < 96000; i++) late = Math.max(late, Math.abs(ch[0][i]));
    // Linear 0.5 s fades: after 240 samples the gain is at most 240.5 / 24000.
    const edge = 0.5 * (240.5 / 24000) + 1e-6;
    expect(early).toBeLessThan(edge);
    expect(mid).toBeGreaterThan(0.49);
    expect(late).toBeLessThan(edge);
    ({ ch } = await collect(project, audio, { range: { start: 10_000, end: 34_000 } }));
    expect(ch[0].length).toBe(24_000);
  });
});

describe('export', () => {
  const fs = 44100;

  it('normalises a quiet track to -14 LUFS with true peak at or below -1 dBTP (WAV 24-bit)', async () => {
    const { project, audio } = makeProject(fs, [musicLike(fs, 20, 128, 3, 0.15)]);
    project.master = { presetId: 'spotify', normalize: true, targetLufs: -14, limiter: true, ceilingDb: -1 };
    project.exportSettings = { ...project.exportSettings, format: 'wav', wavFormat: 'pcm24' };
    project.meta.title = 'My: Song?';
    const res = await exportProject({ project, audio });
    expect(res.fileName).toBe('My Song.wav');
    expect(Math.abs(res.stats.integratedLufs + 14)).toBeLessThan(0.15);
    expect(res.stats.truePeakDb).toBeLessThanOrEqual(-1);
    expect(res.stats.limiterReductionDb).toBeLessThan(0);
    const wav = parseWav(await res.blob.arrayBuffer());
    expect(wav.sampleRate).toBe(fs);
    expect(wav.bitsPerSample).toBe(24);
    expect(wav.info.title).toBe('My: Song?');
    const m = measureLoudness(wav.channels, fs);
    expect(Math.abs(m.integrated - res.stats.integratedLufs)).toBeLessThan(0.02);
    expect(m.truePeakDb).toBeLessThanOrEqual(-0.99);
  });

  it('turns a loud track down without engaging the limiter', async () => {
    const { project, audio } = makeProject(fs, [musicLike(fs, 15, 100, 4, 0.9)]);
    const before = await analyzeProject({ project, audio });
    expect(before.integrated).toBeGreaterThan(-12);
    project.master = { presetId: 'aes', normalize: true, targetLufs: -16, limiter: true, ceilingDb: -1 };
    project.exportSettings.format = 'wav';
    const res = await exportProject({ project, audio });
    expect(Math.abs(res.stats.integratedLufs + 16)).toBeLessThan(0.05);
    expect(res.stats.normalizeGainDb).toBeLessThan(0);
  });

  it('exports MP3 with tags and the requested bitrate, resampling 96 kHz projects to an MP3 rate', async () => {
    const x = musicLike(96000, 5, 120, 5, 0.3);
    const { project, audio } = makeProject(96000, [x]);
    project.exportSettings = { ...project.exportSettings, format: 'mp3', mp3Bitrate: 256 };
    project.meta = { ...project.meta, title: 'Hi-res', artist: 'A', album: 'B', year: '2026', genre: 'House', comment: 'c' };
    expect(chooseOutputRate(project)).toBe(48000);
    const res = await exportProject({ project, audio, mp3: mp3Factory });
    const f = join(tmp(), res.fileName);
    writeFileSync(f, Buffer.from(await res.blob.arrayBuffer()));
    const probe = ffprobe(f) as { format: { tags: Record<string, string>; duration: string }; streams: { sample_rate: string; bit_rate: string }[] };
    expect(probe.streams[0].sample_rate).toBe('48000');
    expect(Number(probe.streams[0].bit_rate)).toBe(256000);
    expect(probe.format.tags.title).toBe('Hi-res');
    expect(probe.format.tags.genre).toBe('House');
    expect(Number(probe.format.duration)).toBeGreaterThan(4.95);
    expect(Number(probe.format.duration)).toBeLessThan(5.15);
    expect(res.stats.sampleRate).toBe(48000);
    expect(res.stats.durationSec).toBeCloseTo(5, 3);
  });

  it('file names are sanitised', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeFileName('   ')).toBe('export');
  });
});
