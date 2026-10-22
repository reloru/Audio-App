import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADROOM_PEAK, MAX_HEADROOM_DB, renderCloudInput } from '../src/engine/cloudInput';
import { ArrangementReader, type LayerAudio } from '../src/engine/render';
import { describeParams, fromQuery, toQuery, validateParams } from '../src/cloud/params';
import { newLayer, newProject, newSource, uid } from '../src/model/project';
import { deleteRange } from '../src/model/timeline';
import { parseWav } from '../src/io/wav';
import { concat, ffprobe, musicLike, silence, sine, tmp } from './helpers';

function makeProject(fs: number, layers: Float32Array[][]) {
  const ls = layers.map((ch, i) => newLayer(`f${i}`, `layer${i}`, ch[0].length, ch.length));
  const project = newProject('Song', fs, [newSource('Song', ls)]);
  const audio: LayerAudio = new Map(ls.map((l, i) => [l.id, { sampleRate: fs, channels: layers[i] }]));
  return { project, audio, layers: ls };
}

async function writeInput(project: Parameters<typeof renderCloudInput>[0], audio: LayerAudio) {
  const input = await renderCloudInput(project, audio);
  const bytes = new Uint8Array(input.bytes);
  let o = 0;
  for (const p of input.parts) {
    bytes.set(p, o);
    o += p.length;
  }
  const path = join(tmp(), 'upload.wav');
  writeFileSync(path, bytes);
  return { input, bytes, path };
}

/** Overall sample peak in dBFS according to ffmpeg's astats filter. */
function ffmpegPeakDb(path: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'astats=measure_perchannel=none:measure_overall=Peak_level', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return Number(/Peak level dB:\s*(-?[\d.]+)/.exec(r.stderr)?.[1]);
}

describe('cloud upload rendering', () => {
  it('sends the arrangement (stem mix and cuts) as 16-bit stereo WAV with its peak at −6 dBFS', async () => {
    const fs = 48000;
    const { project, audio, layers } = makeProject(fs, [musicLike(fs, 8, 120, 3, 0.6), sine(fs, 8, 330, -10)]);
    layers[1].gainDb = 3;
    layers[1].balance = -0.4;
    project.clips = deleteRange(project.clips, 2 * fs, 3 * fs, Math.round(0.015 * fs), uid);
    const { input, bytes, path } = await writeInput(project, audio);

    const reader = new ArrangementReader(project, audio);
    const expected = reader.read(0, reader.length);
    let peak = 0;
    for (const ch of expected) for (const v of ch) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(HEADROOM_PEAK);
    expect(input.gainDb).toBeCloseTo(20 * Math.log10(HEADROOM_PEAK / peak), 9);
    expect(input.seconds).toBeCloseTo(reader.length / fs, 9);

    const probe = ffprobe(path) as { streams: { codec_name: string; channels: number; sample_rate: string; duration_ts: number }[] };
    expect(probe.streams[0].codec_name).toBe('pcm_s16le');
    expect(probe.streams[0].channels).toBe(2);
    expect(probe.streams[0].sample_rate).toBe('48000');
    expect(probe.streams[0].duration_ts).toBe(reader.length);
    // TPDF dither adds at most 1 LSB and rounding half an LSB: well under 0.01 dB at −6 dBFS.
    expect(Math.abs(ffmpegPeakDb(path) - 20 * Math.log10(HEADROOM_PEAK))).toBeLessThan(0.01);

    // Undoing input.gainDb restores the arrangement to within the quantisation error.
    const w = parseWav(bytes.buffer);
    const undo = Math.pow(10, -input.gainDb / 20);
    let err = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < reader.length; i++) err = Math.max(err, Math.abs(w.channels[c][i] * undo - expected[c][i]));
    expect(err).toBeLessThan((2 / 32768) * undo);
  });

  it('never boosts a quiet song and limits the attenuation of a very hot mix to 12 dB', async () => {
    const fs = 44100;
    const quiet = makeProject(fs, [sine(fs, 2, 1000, -20)]);
    expect((await renderCloudInput(quiet.project, quiet.audio)).gainDb).toBe(0);

    const hot = makeProject(fs, [sine(fs, 2, 100, -1), sine(fs, 2, 100, -1)]);
    hot.layers[0].gainDb = 12;
    hot.layers[1].gainDb = 12;
    const { input, path } = await writeInput(hot.project, hot.audio);
    expect(input.gainDb).toBe(-MAX_HEADROOM_DB);
    // 2 × (−1 + 12) dBFS = +17 dBFS, minus 12 dB, still clips at 16-bit full scale.
    expect(ffmpegPeakDb(path)).toBeGreaterThan(-0.01);
  });

  it('rejects a silent song and stops when cancelled', async () => {
    const fs = 48000;
    const silent = makeProject(fs, [silence(fs, 1)]);
    await expect(renderCloudInput(silent.project, silent.audio)).rejects.toThrow(/silent/);
    const song = makeProject(fs, [concat(silence(fs, 1), sine(fs, 3, 440, -6))]);
    const abort = new AbortController();
    abort.abort();
    await expect(renderCloudInput(song.project, song.audio, { signal: abort.signal })).rejects.toThrow(/Cancelled/);
  });
});

describe('cloud parameters', () => {
  it('validates ranges and refuses a no-op', () => {
    expect(validateParams({ tempo: 1.05, pitch: -2, formant: true })).toBeNull();
    expect(validateParams({ tempo: 0.5, pitch: 12, formant: false })).toBeNull();
    expect(validateParams({ tempo: 1, pitch: 0, formant: true })).toMatch(/Change the tempo or the pitch/);
    expect(validateParams({ tempo: 2.01, pitch: 0, formant: false })).toMatch(/Tempo/);
    expect(validateParams({ tempo: 1, pitch: -12.5, formant: false })).toMatch(/Pitch/);
    expect(validateParams({ tempo: Number.NaN, pitch: 1, formant: false })).toMatch(/Tempo/);
  });

  it('round-trips through the query string and labels file names', () => {
    const p = { tempo: 0.85, pitch: 3, formant: true };
    expect(fromQuery(new URLSearchParams(toQuery(p)))).toEqual(p);
    expect(fromQuery(new URLSearchParams('tempo=1.2'))).toEqual({ tempo: 1.2, pitch: 0, formant: false });
    expect(describeParams({ tempo: 1.05, pitch: -2, formant: true })).toBe('105% tempo, −2 st');
    expect(describeParams({ tempo: 1, pitch: 1, formant: false })).toBe('+1 st');
  });
});
