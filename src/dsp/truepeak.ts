/**
 * True-peak estimation per Rec. ITU-R BS.1770-5, Annex 2: 4x oversampling with
 * the 48-tap, 4-phase FIR interpolator whose coefficients the Recommendation
 * lists (phase k holds taps h[4m + k], m = 0..11). Computation is in floating
 * point, so the 12.04 dB pre-attenuation step of the Annex is not needed.
 */
import { interpMax } from './interp.generated';


export const TP_PHASES: readonly (readonly number[])[] = [
  [
    0.001708984375, 0.010986328125, -0.0196533203125, 0.033203125, -0.0594482421875, 0.1373291015625,
    0.97216796875, -0.102294921875, 0.047607421875, -0.0266113281250, 0.014892578125, -0.00830078125,
  ],
  [
    -0.0291748046875, 0.029296875, -0.0517578125, 0.0891113281250, -0.166503906250, 0.465087890625,
    0.77978515625, -0.2003173828125, 0.1015625, -0.0582275390625, 0.0330810546875, -0.0189208984375,
  ],
  [
    -0.0189208984375, 0.0330810546875, -0.0582275390625, 0.1015625, -0.2003173828125, 0.77978515625,
    0.465087890625, -0.166503906250, 0.0891113281250, -0.0517578125, 0.029296875, -0.0291748046875,
  ],
  [
    -0.00830078125, 0.014892578125, -0.0266113281250, 0.047607421875, -0.102294921875, 0.97216796875,
    0.1373291015625, -0.0594482421875, 0.033203125, -0.0196533203125, 0.010986328125, 0.001708984375,
  ],
];

export const TP_TAPS = 12;

/** Largest per-phase sum of |h|; bounds |interpolated| <= L1 * max|x| over the window. */
export const TP_L1: number = Math.max(...TP_PHASES.map((p) => p.reduce((s, v) => s + Math.abs(v), 0)));

/**
 * Streaming true-peak detector for one channel. Feed consecutive blocks; the
 * running maximum covers sample values and all interpolated values.
 */
const TP_CHUNK = 8192;

export class TruePeakDetector {
  private hist = new Float32Array(TP_TAPS - 1);
  private work = new Float32Array(TP_TAPS - 1 + TP_CHUNK);
  peak = 0;

  reset(): void {
    this.hist.fill(0);
    this.peak = 0;
  }

  push(x: Float32Array, n = x.length): void {
    for (let off = 0; off < n; off += TP_CHUNK) {
      this.pushChunk(x.subarray(off, Math.min(n, off + TP_CHUNK)));
    }
  }

  private pushChunk(x: Float32Array): void {
    const n = x.length;
    const H = TP_TAPS - 1;
    const w = this.work;
    w.set(this.hist, 0);
    for (let i = 0; i < n; i++) w[H + i] = x[i];

    let peak = this.peak;
    const BLOCK = 64;
    for (let b = 0; b < n; b += BLOCK) {
      const e = Math.min(n, b + BLOCK);
      // Exact pruning: if even the worst-case interpolation of this window
      // cannot exceed the running peak, skip it.
      let m = 0;
      for (let i = b; i < e + H; i++) {
        const a = Math.abs(w[i]);
        if (a > m) m = a;
      }
      if (m * TP_L1 <= peak) continue;
      for (let i = b; i < e; i++) {
        const base = i + H; // index of newest sample in w
        const s = Math.abs(w[base]);
        if (s > peak) peak = s;
        const ip = interpMax(w, base);
        if (ip > peak) peak = ip;
      }
    }
    this.peak = peak;
    // Keep the last H samples as history.
    if (n >= H) {
      for (let i = 0; i < H; i++) this.hist[i] = x[n - H + i];
    } else {
      this.hist.copyWithin(0, n);
      for (let i = 0; i < n; i++) this.hist[H - n + i] = x[i];
    }
  }
}

export function linToDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

/** True peak (linear) across all channels of a buffer. */
export function truePeak(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels) {
    const d = new TruePeakDetector();
    d.push(ch);
    if (d.peak > p) p = d.peak;
  }
  return p;
}
