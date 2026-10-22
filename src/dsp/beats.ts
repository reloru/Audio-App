/**
 * Beat tracking by dynamic programming, after D. P. W. Ellis, "Beat Tracking
 * by Dynamic Programming", J. New Music Research 36(1), 2007.
 *
 * Front end (paper §3.1): resample to 8 kHz, STFT with 32 ms windows and 4 ms
 * hop, 40 Mel bands, dB, first-order difference, half-wave rectification,
 * sum over bands, ~0.4 Hz high-pass, ~20 ms Gaussian smoothing, unit
 * standard deviation.
 * Tempo (§3.2): autocorrelation weighted by a log-Gaussian centred on 0.5 s
 * with 1.4 octaves spread, refined with the duple/triple sums of eqs. 7-8.
 * Beats (§2): maximise sum O(t_i) + alpha * sum F(t_i - t_{i-1}, tau_p) with
 * F = -(log(dt / tau))^2 over predecessors in [t - 2 tau, t - tau / 2].
 */
import { FFT } from './fft';
import { Resampler, zeroPaddedReader } from './resample';

const SR = 8000;
const WIN = 256; // 32 ms at 8 kHz
const HOP = 32; // 4 ms at 8 kHz
const MELS = 40;
const FRAME_RATE = SR / HOP; // 250 Hz
const TAU0 = 0.5; // s, tempo-period bias (paper: 120 BPM)
const SIGMA_OCT = 1.4;
const ALPHA = 680; // best-scoring value reported in the paper

export interface BeatAnalysis {
  /** Beat times in seconds. */
  beats: number[];
  /** Tempo from a least-squares fit to the beat times. */
  bpm: number;
  /** Index (0..3) of the beat guessed to start a bar (heuristic, see below). */
  barOffset: number;
}

function hz2mel(f: number): number {
  return 2595 * Math.log10(1 + f / 700);
}
function mel2hz(m: number): number {
  return 700 * (Math.pow(10, m / 2595) - 1);
}

interface MelBand {
  lo: number;
  w: Float64Array;
}

/** Triangular Mel filters (HTK Mel formula) stored as sparse bin ranges. */
function melBands(): MelBand[] {
  const bins = WIN / 2 + 1;
  const lo = hz2mel(0);
  const hi = hz2mel(SR / 2);
  const edges = Array.from({ length: MELS + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (MELS + 1)));
  return Array.from({ length: MELS }, (_, b) => {
    const [f0, f1, f2] = [edges[b], edges[b + 1], edges[b + 2]];
    const ws: number[] = [];
    let first = -1;
    for (let k = 0; k < bins; k++) {
      const f = (k * SR) / WIN;
      if (f > f0 && f < f2) {
        if (first < 0) first = k;
        ws.push(f <= f1 ? (f - f0) / (f1 - f0) : (f2 - f) / (f2 - f1));
      }
    }
    return { lo: Math.max(0, first), w: Float64Array.from(ws) };
  });
}

/** Onset strength envelope at 250 Hz from mono audio. */
export function onsetEnvelope(mono: Float32Array, sampleRate: number): Float64Array {
  // Resample to 8 kHz (a shorter kernel is plenty for onset detection).
  const rs = new Resampler(sampleRate / SR, { halfWidth: 8, beta: 6, cutoff: 0.9 });
  const read = zeroPaddedReader([mono]);
  const n8 = rs.outputLength(mono.length);
  const x = new Float32Array(n8);
  for (let s = 0; s < n8; s += 16384) x.set(rs.process(read, 1, s, Math.min(16384, n8 - s))[0], s);

  const frames = Math.max(0, Math.floor((n8 - WIN) / HOP) + 1);
  if (frames < 3) return new Float64Array(0);
  const fft = new FFT(WIN);
  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
  const mel = melBands();
  const bins = WIN / 2 + 1;
  const melDb = new Float64Array(frames * MELS);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const mag = new Float64Array(bins);
  let maxDb = -Infinity;
  const magB = new Float64Array(bins);
  const melRow = (m: Float64Array, f: number) => {
    for (let b = 0; b < MELS; b++) {
      const { lo, w } = mel[b];
      let s = 0;
      for (let k = 0; k < w.length; k++) s += w[k] * m[lo + k];
      const db = 20 * Math.log10(s + 1e-10);
      melDb[f * MELS + b] = db;
      if (db > maxDb) maxDb = db;
    }
  };
  // Two real frames per complex FFT: frame f in the real part, f+1 in the
  // imaginary part; X_f[k] = (Z[k] + conj Z[N-k]) / 2, X_f+1[k] = (Z[k] - conj Z[N-k]) / 2i.
  for (let f = 0; f < frames; f += 2) {
    const o = f * HOP;
    const two = f + 1 < frames;
    for (let i = 0; i < WIN; i++) {
      re[i] = x[o + i] * hann[i];
      im[i] = two ? x[o + HOP + i] * hann[i] : 0;
    }
    fft.transform(re, im);
    for (let k = 0; k < bins; k++) {
      const nk = (WIN - k) & (WIN - 1);
      const ar = 0.5 * (re[k] + re[nk]);
      const ai = 0.5 * (im[k] - im[nk]);
      const br = 0.5 * (im[k] + im[nk]);
      const bi = -0.5 * (re[k] - re[nk]);
      mag[k] = Math.sqrt(ar * ar + ai * ai);
      magB[k] = Math.sqrt(br * br + bi * bi);
    }
    melRow(mag, f);
    if (two) melRow(magB, f + 1);
  }
  const floor = maxDb - 80;
  for (let i = 0; i < melDb.length; i++) if (melDb[i] < floor) melDb[i] = floor;

  // Rectified first difference summed over bands.
  const raw = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    let s = 0;
    for (let b = 0; b < MELS; b++) {
      const d = melDb[f * MELS + b] - melDb[(f - 1) * MELS + b];
      if (d > 0) s += d;
    }
    raw[f] = s;
  }
  // High-pass (pole at 0.99 -> ~0.4 Hz at 250 Hz frame rate).
  const hp = new Float64Array(frames);
  let prevX = 0;
  let prevY = 0;
  for (let f = 0; f < frames; f++) {
    const y = raw[f] - prevX + 0.99 * prevY;
    prevX = raw[f];
    prevY = y;
    hp[f] = y;
  }
  // Gaussian smoothing, ~20 ms full width at half maximum.
  const sigma = (0.02 * FRAME_RATE) / 2.3548;
  const radius = Math.ceil(3 * sigma);
  const g = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const gs = g.reduce((a, b) => a + b, 0);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = f + j;
      if (idx >= 0 && idx < frames) s += hp[idx] * g[j + radius];
    }
    env[f] = s / gs;
  }
  // Unit standard deviation.
  let mean = 0;
  for (const v of env) mean += v;
  mean /= frames;
  let varr = 0;
  for (const v of env) varr += (v - mean) ** 2;
  const sd = Math.sqrt(varr / frames) || 1;
  for (let f = 0; f < frames; f++) env[f] /= sd;
  return env;
}

/** Tempo period in frames (paper §3.2 with the eq. 7/8 refinement). */
export function estimateTempoPeriod(env: Float64Array): number {
  const maxLag = Math.min(Math.floor(4 * FRAME_RATE), env.length - 1);
  // Use at most ~90 s from the middle to bound the cost.
  const span = Math.min(env.length, Math.floor(90 * FRAME_RATE));
  const off = Math.floor((env.length - span) / 2);
  const tps = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let t = off + lag; t < off + span; t++) s += env[t] * env[t - lag];
    const w = Math.exp(-0.5 * (Math.log2(lag / FRAME_RATE / TAU0) / SIGMA_OCT) ** 2);
    tps[lag] = w * s;
  }
  const at = (i: number) => (i >= 1 && i <= maxLag ? tps[i] : 0);
  let best2 = -Infinity,
    arg2 = 1,
    best3 = -Infinity,
    arg3 = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    const t2 = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(2 * lag - 1) + 0.25 * at(2 * lag + 1);
    const t3 = at(lag) + 0.33 * at(3 * lag) + 0.33 * at(3 * lag - 1) + 0.33 * at(3 * lag + 1);
    if (t2 > best2) {
      best2 = t2;
      arg2 = lag;
    }
    if (t3 > best3) {
      best3 = t3;
      arg3 = lag;
    }
  }
  const duple = best2 >= best3;
  const fast = duple ? arg2 : arg3;
  const slow = fast * (duple ? 2 : 3);
  // The level with the larger raw TPS value is used as the beat level.
  const period = slow <= maxLag && at(slow) > at(fast) ? slow : fast;
  return refinePeak(tps, period);
}

function refinePeak(a: Float64Array, i: number): number {
  if (i <= 1 || i >= a.length - 1) return i;
  const y0 = a[i - 1],
    y1 = a[i],
    y2 = a[i + 1];
  const den = y0 - 2 * y1 + y2;
  if (den >= 0) return i;
  const d = (0.5 * (y0 - y2)) / den;
  return Math.abs(d) < 1 ? i + d : i;
}

/** Core dynamic-programming search (paper Fig. 1). Returns frame indices. */
export function trackBeats(env: Float64Array, period: number, alpha = ALPHA): number[] {
  const n = env.length;
  if (n === 0) return [];
  const lo = Math.round(-2 * period);
  const hi = -Math.round(period / 2);
  const prange: number[] = [];
  for (let d = lo; d <= hi; d++) prange.push(d);
  const txcost = prange.map((d) => -alpha * Math.log(-d / period) ** 2);
  const backlink = new Int32Array(n).fill(-1);
  const cum = Float64Array.from(env);
  const startIdx = Math.max(0, -lo);
  for (let i = startIdx; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let j = 0; j < prange.length; j++) {
      const t = i + prange[j];
      const v = txcost[j] + cum[t];
      if (v > best) {
        best = v;
        arg = t;
      }
    }
    cum[i] = best + env[i];
    backlink[i] = arg;
  }
  // Start the backtrace from the best score within one period of the end.
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) {
    if (cum[i] > bestEnd) {
      bestEnd = cum[i];
      end = i;
    }
  }
  const beats = [end];
  while (backlink[beats[0]] >= 0) beats.unshift(backlink[beats[0]]);
  return beats;
}

/** Least-squares tempo (BPM) from beat times. */
export function bpmFromBeats(beats: number[]): number {
  const n = beats.length;
  if (n < 2) return 0;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += beats[i];
    sxx += i * i;
    sxy += i * beats[i];
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope > 0 ? 60 / slope : 0;
}

/**
 * Time of frame f. Frame f's spectrum covers [f*HOP, f*HOP + WIN) at 8 kHz; the
 * difference is attributed to the frame centre.
 */
function frameTime(f: number): number {
  return (f * HOP + WIN / 2) / SR;
}

export function analyzeBeats(channels: Float32Array[], sampleRate: number): BeatAnalysis {
  const len = channels[0]?.length ?? 0;
  if (len < sampleRate * 4) return { beats: [], bpm: 0, barOffset: 0 };
  const mono = new Float32Array(len);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < len; i++) mono[i] += ch[i] * g;
  const env = onsetEnvelope(mono, sampleRate);
  if (env.length < FRAME_RATE * 2) return { beats: [], bpm: 0, barOffset: 0 };
  const period = estimateTempoPeriod(env);
  const frames = trackBeats(env, period);
  const beats = frames.map(frameTime).filter((t) => t >= 0 && t <= len / sampleRate);
  // Heuristic (not from the paper): guess the bar phase as the 4-beat phase
  // with the strongest mean onset strength. Users can override it.
  let barOffset = 0;
  let bestMean = -Infinity;
  for (let k = 0; k < 4; k++) {
    let s = 0,
      c = 0;
    for (let i = k; i < frames.length; i += 4) {
      s += env[frames[i]];
      c++;
    }
    if (c && s / c > bestMean) {
      bestMean = s / c;
      barOffset = k;
    }
  }
  return { beats, bpm: bpmFromBeats(beats), barOffset };
}

/** Doubles the beat density (inserting midpoints) — fixes half-tempo detections. */
export function doubleBeats(beats: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    out.push(beats[i]);
    if (i + 1 < beats.length) out.push((beats[i] + beats[i + 1]) / 2);
  }
  return out;
}

/** Keeps every other beat — fixes double-tempo detections. */
export function halveBeats(beats: number[], phase = 0): number[] {
  return beats.filter((_, i) => i % 2 === phase);
}
