import { describe, expect, it } from 'vitest';
import { Biquad, biquadCoeffs, biquadMagnitude } from '../src/dsp/biquad';
import { resampleBuffer } from '../src/dsp/resample';
import { limitBuffer, TruePeakLimiter } from '../src/dsp/limiter';
import { truePeak, linToDb, TP_PHASES } from '../src/dsp/truepeak';
import { interpMax } from '../src/dsp/interp.generated';
import { fadeGain, crossfadeGains } from '../src/dsp/fades';
import { analyzeBeats, doubleBeats, halveBeats, bpmFromBeats } from '../src/dsp/beats';
import { detectSilence, buildPeaks, peakRange } from '../src/dsp/analysis';
import { concat, musicLike, rng, silence, sine } from './helpers';

const db = (x: number) => 20 * Math.log10(x);

describe('Biquad (W3C Web Audio formulas)', () => {
  const fs = 48000;
  it('lowpass/highpass with Q in dB: -3.01 dB at f0 for Q = 20log10(1/sqrt2)', () => {
    const q = 20 * Math.log10(Math.SQRT1_2);
    for (const type of ['lowpass', 'highpass'] as const) {
      const c = biquadCoeffs({ type, frequency: 1000, Q: q, gain: 0 }, fs);
      expect(db(biquadMagnitude(c, 1000, fs))).toBeCloseTo(-3.0103, 3);
    }
  });
  it('peaking reaches its gain at f0; shelves reach full gain at the band edge and half at f0', () => {
    const pk = biquadCoeffs({ type: 'peaking', frequency: 2000, Q: 1, gain: 6 }, fs);
    expect(db(biquadMagnitude(pk, 2000, fs))).toBeCloseTo(6, 6);
    const hs = biquadCoeffs({ type: 'highshelf', frequency: 4000, Q: 1, gain: -6 }, fs);
    expect(db(biquadMagnitude(hs, fs / 2 - 1e-6, fs))).toBeCloseTo(-6, 4);
    expect(db(biquadMagnitude(hs, 1e-3, fs))).toBeCloseTo(0, 4);
    expect(db(biquadMagnitude(hs, 4000, fs))).toBeCloseTo(-3, 4);
    const ls = biquadCoeffs({ type: 'lowshelf', frequency: 200, Q: 1, gain: 4 }, fs);
    expect(db(biquadMagnitude(ls, 1e-3, fs))).toBeCloseTo(4, 4);
    expect(db(biquadMagnitude(ls, 200, fs))).toBeCloseTo(2, 4);
  });
  it('time-domain processing matches the analytic magnitude', () => {
    const c = biquadCoeffs({ type: 'peaking', frequency: 3000, Q: 2, gain: 9 }, fs);
    for (const f of [500, 3000, 9000]) {
      const [x] = sine(fs, 1, f, -6, 1);
      const ref = x.slice();
      const bq = new Biquad(c);
      bq.process(x);
      // RMS over the steady-state half (sample peaks of high tones under-read).
      let ey = 0,
        ex = 0;
      for (let i = fs / 2; i < x.length; i++) {
        ey += x[i] * x[i];
        ex += ref[i] * ref[i];
      }
      expect(db(Math.sqrt(ey / ex))).toBeCloseTo(db(biquadMagnitude(c, f, fs)), 2);
    }
  });
});

describe('Windowed-sinc resampler', () => {
  function snr(y: Float32Array, ref: (i: number) => number, skip: number): number {
    let s = 0,
      e = 0;
    for (let i = skip; i < y.length - skip; i++) {
      const r = ref(i);
      s += r * r;
      e += (y[i] - r) ** 2;
    }
    return 10 * Math.log10(s / e);
  }
  it('44.1 kHz -> 48 kHz: SNR > 90 dB for 1 kHz and 15 kHz tones', () => {
    for (const f of [1000, 15000]) {
      const x = sine(44100, 1, f, -1, 1);
      const [y] = resampleBuffer(x, 44100, 48000);
      const a = Math.pow(10, -1 / 20);
      expect(snr(y, (i) => a * Math.sin((2 * Math.PI * f * i) / 48000), 2000)).toBeGreaterThan(90);
    }
  });
  it('48 kHz -> 44.1 kHz: passband flat at 18 kHz, aliasing of a 23 kHz tone below -85 dB', () => {
    const [y] = resampleBuffer(sine(48000, 1, 18000, 0, 1), 48000, 44100);
    let pk = 0;
    for (let i = 2000; i < y.length - 2000; i++) pk = Math.max(pk, Math.abs(y[i]));
    expect(Math.abs(db(pk))).toBeLessThan(0.05);
    const [z] = resampleBuffer(sine(48000, 1, 23000, 0, 1), 48000, 44100);
    let rms = 0;
    for (let i = 2000; i < z.length - 2000; i++) rms += z[i] * z[i];
    expect(db(Math.sqrt(rms / (z.length - 4000)))).toBeLessThan(-85);
  });
  it('speed 1.25 raises a 1 kHz tone to 1.25 kHz and shortens the signal', () => {
    const x = sine(48000, 2, 1000, -6, 1);
    const [y] = resampleBuffer(x, 48000, 48000, 1.25);
    expect(y.length).toBe(Math.floor((96000 - 1) / 1.25) + 1);
    // zero crossings per second
    let zc = 0;
    for (let i = 2001; i < y.length - 2000; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    const seconds = (y.length - 4001) / 48000;
    expect(zc / seconds).toBeGreaterThan(1245);
    expect(zc / seconds).toBeLessThan(1255);
  });
});

describe('Generated interpolation helper', () => {
  it('matches the BS.1770-5 phase table', () => {
    const r = rng(11);
    const w = new Float32Array(64).map(() => r() * 2 - 1);
    for (let j = 11; j < 64; j++) {
      let ref = 0;
      for (const ph of TP_PHASES) {
        let y = 0;
        for (let k = 0; k < 12; k++) y += ph[k] * w[j - k];
        ref = Math.max(ref, Math.abs(y));
      }
      expect(interpMax(w, j)).toBeCloseTo(ref, 12);
    }
  });
});

describe('True-peak limiter', () => {
  const fs = 48000;
  it('keeps the true peak of very hot material at or below the ceiling', () => {
    for (const [seed, level] of [
      [1, 2.0],
      [2, 4.0],
      [3, 1.2],
    ] as const) {
      const x = musicLike(fs, 12, 128, seed, level);
      const inTp = linToDb(truePeak(x));
      expect(inTp).toBeGreaterThan(0);
      const y = limitBuffer(x, { sampleRate: fs, ceilingDb: -1 });
      const tp = linToDb(truePeak(y));
      expect(tp).toBeLessThanOrEqual(-1.0);
      expect(tp).toBeGreaterThan(-1.6);
    }
  });
  it('limits worst-case inter-sample peaks (fs/4 tone at 45 degrees)', () => {
    const n = fs;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.999 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    const y = limitBuffer([x, x.slice()], { sampleRate: fs, ceilingDb: -1 });
    expect(linToDb(truePeak(y))).toBeLessThanOrEqual(-1.0);
  });
  it('is transparent below the ceiling (only delayed, compensated by limitBuffer)', () => {
    const x = musicLike(fs, 5, 100, 4, 0.2);
    expect(linToDb(truePeak(x))).toBeLessThan(-3);
    const y = limitBuffer(x, { sampleRate: fs, ceilingDb: -1 });
    let maxDiff = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < x[c].length; i++) maxDiff = Math.max(maxDiff, Math.abs(x[c][i] - y[c][i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });
  it('reports gain reduction and latency', () => {
    const lim = new TruePeakLimiter({ sampleRate: fs, channels: 2, ceilingDb: -1, lookaheadMs: 5 });
    expect(lim.latency).toBe(240 - 1 + 6);
    const x = musicLike(fs, 3, 120, 9, 3);
    lim.process(x, x.map((c) => new Float32Array(c.length)));
    expect(lim.minGain).toBeLessThan(0.5);
    expect(lim.reducedSamples).toBeGreaterThan(0);
  });
});

describe('Fades', () => {
  it('curves start at 0, end at 1 and are monotonic', () => {
    for (const c of ['linear', 'equalPower', 'sCurve', 'exponential'] as const) {
      expect(fadeGain(c, 0)).toBe(0);
      expect(fadeGain(c, 1)).toBe(1);
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const g = fadeGain(c, i / 100);
        expect(g).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
    }
  });
  it('equal-power crossfade keeps constant power', () => {
    for (let i = 0; i <= 10; i++) {
      const [a, b] = crossfadeGains(i / 10);
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });
});

describe('Beat tracking (Ellis 2007)', () => {
  it.each([
    [44100, 120],
    [48000, 96],
    [48000, 140],
  ])('finds tempo and beat phase of a synthetic groove @ %i Hz, %i BPM', (fs, bpm) => {
    const x = musicLike(fs, 40, bpm, 5, 0.5);
    const r = analyzeBeats(x, fs);
    expect(Math.abs(r.bpm - bpm)).toBeLessThan(1);
    const period = 60 / bpm;
    // Beats should fall on the synthetic beat grid (kick/snare onsets at k * period).
    const errs = r.beats.slice(2, -2).map((t) => {
      const k = Math.round(t / period);
      return Math.abs(t - k * period);
    });
    const med = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)];
    expect(med).toBeLessThan(0.02);
  });
  it('beat-density helpers', () => {
    expect(doubleBeats([0, 1, 2])).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(halveBeats([0, 1, 2, 3, 4])).toEqual([0, 2, 4]);
    expect(bpmFromBeats([0, 0.5, 1, 1.5])).toBeCloseTo(120, 9);
  });
  it('returns no beats for short or silent input', () => {
    expect(analyzeBeats(silence(48000, 2), 48000).beats).toEqual([]);
  });
});

describe('Silence detection and peaks', () => {
  it('finds leading and trailing silence', () => {
    const fs = 48000;
    const x = concat(silence(fs, 1.5), sine(fs, 2, 440, -12), silence(fs, 3));
    const b = detectSilence(x, fs, -55, 10, 100);
    expect(Math.abs(b.start - (1.5 * fs - 0.01 * fs))).toBeLessThanOrEqual(fs / 100);
    expect(Math.abs(b.end - (3.5 * fs + 0.1 * fs))).toBeLessThanOrEqual(fs / 100);
  });
  it('peak pyramid ranges contain the true extrema', () => {
    const r = rng(3);
    const x = new Float32Array(100000).map(() => r() * 2 - 1);
    x[54321] = 1.5;
    const p = buildPeaks([x]);
    const [, hi] = peakRange(p, 50000, 60000);
    expect(hi).toBe(1.5);
    const [lo2, hi2] = peakRange(p, 0, 100000);
    expect(hi2).toBe(1.5);
    expect(lo2).toBeLessThan(-0.99);
  });
});
