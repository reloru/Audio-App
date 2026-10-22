import { describe, expect, it } from 'vitest';
import { kWeightingCoeffs, measureLoudness, loudnessRange } from '../src/dsp/loudness';
import { truePeak, linToDb } from '../src/dsp/truepeak';
import { concat, ffmpegEbur128, musicLike, repeat, silence, sine, writeTempWav } from './helpers';

const RATES = [48000, 44100];

describe('K-weighting coefficients (ITU-R BS.1770-5 Tables 1 and 2)', () => {
  it('reproduce the tabulated 48 kHz coefficients', () => {
    const [s1, s2] = kWeightingCoeffs(48000);
    expect(s1.b0).toBeCloseTo(1.53512485958697, 12);
    expect(s1.b1).toBeCloseTo(-2.69169618940638, 12);
    expect(s1.b2).toBeCloseTo(1.19839281085285, 12);
    expect(s1.a1).toBeCloseTo(-1.69065929318241, 12);
    expect(s1.a2).toBeCloseTo(0.73248077421585, 12);
    expect(s2.b0).toBeCloseTo(1.0, 12);
    expect(s2.b1).toBeCloseTo(-2.0, 12);
    expect(s2.b2).toBeCloseTo(1.0, 12);
    expect(s2.a1).toBeCloseTo(-1.99004745483398, 12);
    expect(s2.a2).toBeCloseTo(0.99007225036621, 12);
  });

  it('first stage has unity DC gain at every rate (shelf prototype is exact)', () => {
    for (const fs of [32000, 44100, 48000, 88200, 96000]) {
      const [s1] = kWeightingCoeffs(fs);
      expect((s1.b0 + s1.b1 + s1.b2) / (1 + s1.a1 + s1.a2)).toBeCloseTo(1, 10);
    }
  });
});

describe.each(RATES)('EBU Tech 3341 minimum requirements @ %i Hz', (fs) => {
  const tol = 0.1;
  it('case 1: 1 kHz stereo sine at -23 dBFS -> M, S, I = -23.0', () => {
    const r = measureLoudness(sine(fs, 20, 1000, -23), fs);
    expect(Math.abs(r.integrated + 23)).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.momentaryMax + 23)).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.shortTermMax + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 2: -33 dBFS -> -33.0', () => {
    const r = measureLoudness(sine(fs, 20, 1000, -33), fs);
    expect(Math.abs(r.integrated + 33)).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.momentaryMax + 33)).toBeLessThanOrEqual(tol);
    expect(Math.abs(r.shortTermMax + 33)).toBeLessThanOrEqual(tol);
  });
  it('case 3: relative gate (10 s -36, 60 s -23, 10 s -36) -> I = -23.0', () => {
    const x = concat(sine(fs, 10, 1000, -36), sine(fs, 60, 1000, -23), sine(fs, 10, 1000, -36));
    expect(Math.abs(measureLoudness(x, fs).integrated + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 4: absolute gate (-72/-36/-23/-36/-72) -> I = -23.0', () => {
    const x = concat(
      sine(fs, 10, 1000, -72),
      sine(fs, 10, 1000, -36),
      sine(fs, 60, 1000, -23),
      sine(fs, 10, 1000, -36),
      sine(fs, 10, 1000, -72),
    );
    expect(Math.abs(measureLoudness(x, fs).integrated + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 5: 20 s -26, 20.1 s -20, 20 s -26 -> I = -23.0', () => {
    const x = concat(sine(fs, 20, 1000, -26), sine(fs, 20.1, 1000, -20), sine(fs, 20, 1000, -26));
    expect(Math.abs(measureLoudness(x, fs).integrated + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 6: 5.0 channels with surround weighting -> I = -23.0', () => {
    const n = Math.round(fs * 20);
    const mk = (db: number) => sine(fs, 20, 1000, db, 1)[0];
    const chans = [mk(-28), mk(-28), mk(-24), mk(-30), mk(-30)];
    expect(chans[0].length).toBe(n);
    const r = measureLoudness(chans, fs, { weights: [1, 1, 1, 1.41, 1.41] });
    expect(Math.abs(r.integrated + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 9: short-term constant -23.0 after 3 s', () => {
    const period = concat(sine(fs, 1.34, 1000, -20), sine(fs, 1.66, 1000, -30));
    const r = measureLoudness(repeat(period, 5), fs);
    expect(r.shortTerm.length).toBeGreaterThan(50);
    for (const v of r.shortTerm) expect(Math.abs(v + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 10: max short-term -23.0 for every segment offset', () => {
    for (let i = 0; i < 20; i++) {
      const x = concat(silence(fs, i * 0.15), sine(fs, 3, 1000, -23), silence(fs, 1));
      expect(Math.abs(measureLoudness(x, fs).shortTermMax + 23)).toBeLessThanOrEqual(tol);
    }
  });
  it('case 12: momentary constant -23.0 after 1 s', () => {
    const period = concat(sine(fs, 0.18, 1000, -20), sine(fs, 0.22, 1000, -30));
    const r = measureLoudness(repeat(period, 25), fs);
    // Momentary series starts at 0.4 s; skip values before 1 s.
    const after1s = Array.from(r.momentary).slice(6);
    expect(after1s.length).toBeGreaterThan(50);
    for (const v of after1s) expect(Math.abs(v + 23)).toBeLessThanOrEqual(tol);
  });
  it('case 13: max momentary -23.0 for every segment offset', () => {
    for (let i = 0; i < 20; i++) {
      const x = concat(silence(fs, i * 0.02), sine(fs, 0.4, 1000, -23), silence(fs, 1));
      expect(Math.abs(measureLoudness(x, fs).momentaryMax + 23)).toBeLessThanOrEqual(tol);
    }
  });
});

function taperedSine(fs: number, freq: number, amp: number, phaseDeg: number, seconds = 1): Float32Array[] {
  const n = Math.round(fs * seconds);
  const fade = Math.round(fs * 0.01);
  const ph = (phaseDeg * Math.PI) / 180;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let g = 1;
    if (i < fade) g = i / fade;
    else if (i > n - fade) g = (n - i) / fade;
    x[i] = g * amp * Math.sin((2 * Math.PI * freq * i) / fs + ph);
  }
  return [x, x.slice()];
}

describe.each(RATES)('True peak, EBU Tech 3341 cases 15-19 @ %i Hz (+0.2/-0.4 dB)', (fs) => {
  const cases: [number, number, number, number, number][] = [
    // [case, freq divisor, amplitude, phase deg, expected dBTP]
    [15, 4, 0.5, 0, -6.0],
    [16, 4, 0.5, 45, -6.0],
    [17, 6, 0.5, 60, -6.0],
    [18, 8, 0.5, 67.5, -6.0],
    [19, 4, 1.41, 45, 3.0],
  ];
  it.each(cases)('case %i', (_c, div, amp, ph, expected) => {
    const tp = linToDb(truePeak(taperedSine(fs, fs / div, amp, ph)));
    expect(tp).toBeLessThanOrEqual(expected + 0.2);
    expect(tp).toBeGreaterThanOrEqual(expected - 0.4);
  });
});

describe('EBU Tech 3342 loudness range minimum requirements (±1 LU)', () => {
  const fs = 48000;
  it('case 1: -20 then -30 dBFS -> LRA 10', () => {
    const r = measureLoudness(concat(sine(fs, 20, 1000, -20), sine(fs, 20, 1000, -30)), fs);
    expect(Math.abs(r.lra - 10)).toBeLessThanOrEqual(1);
  });
  it('case 2: -20 then -15 dBFS -> LRA 5', () => {
    const r = measureLoudness(concat(sine(fs, 20, 1000, -20), sine(fs, 20, 1000, -15)), fs);
    expect(Math.abs(r.lra - 5)).toBeLessThanOrEqual(1);
  });
  it('case 3: -40 then -20 dBFS -> LRA 20', () => {
    const r = measureLoudness(concat(sine(fs, 20, 1000, -40), sine(fs, 20, 1000, -20)), fs);
    expect(Math.abs(r.lra - 20)).toBeLessThanOrEqual(1);
  });
  it('case 4: -50/-35/-20/-35/-50 dBFS -> LRA 15', () => {
    const x = concat(
      sine(fs, 20, 1000, -50),
      sine(fs, 20, 1000, -35),
      sine(fs, 20, 1000, -20),
      sine(fs, 20, 1000, -35),
      sine(fs, 20, 1000, -50),
    );
    expect(Math.abs(measureLoudness(x, fs).lra - 15)).toBeLessThanOrEqual(1);
  });
  it('returns 0 for an empty distribution', () => {
    expect(loudnessRange([])).toBe(0);
    expect(loudnessRange([-80, -90])).toBe(0);
  });
});

describe.each(RATES)('Cross-check against ffmpeg ebur128 @ %i Hz', (fs) => {
  it('integrated loudness agrees within 0.1 LU and true peak within 0.3 dB', () => {
    for (const [bpm, seed, level] of [
      [92, 1, 0.3],
      [128, 2, 0.8],
      [174, 3, 0.15],
    ] as const) {
      const x = musicLike(fs, 30, bpm, seed, level);
      const ours = measureLoudness(x, fs);
      const ref = ffmpegEbur128(writeTempWav(fs, x));
      expect(Math.abs(ours.integrated - ref.I)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(ours.truePeakDb - ref.TP)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(ours.lra - ref.LRA)).toBeLessThanOrEqual(1);
    }
  });
});
