/**
 * Band-limited resampling by Kaiser-windowed sinc interpolation with an
 * arbitrary step, following the table-lookup approach described by
 * J. O. Smith ("Digital Audio Resampling", CCRMA). Used for speed changes
 * (varispeed) and sample-rate conversion.
 *
 * The kernel is precomputed as a polyphase bank: one row of taps per
 * fractional position. For rational steps p/q with small q (e.g. 44.1 <-> 48
 * kHz, 147/160) the rows are exact; otherwise 512 rows are linearly
 * interpolated. Processing is random-access: an output block only needs a
 * read() of the input frames it depends on.
 */

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

export type FrameReader = (start: number, length: number) => Float32Array[];

export interface ResamplerOptions {
  /** Cut-off as a fraction of the lower of the two Nyquist frequencies. */
  cutoff?: number;
  /** Zero crossings on each side of the kernel centre. */
  halfWidth?: number;
  /** Kaiser window shape. */
  beta?: number;
}

/** Finds p/q == x with q <= maxQ (exact to 1e-12), or null. */
export function rationalApprox(x: number, maxQ: number): [number, number] | null {
  let h0 = 0,
    h1 = 1,
    k0 = 1,
    k1 = 0;
  let v = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(v);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxQ) return null;
    if (Math.abs(h2 / k2 - x) < 1e-12 * Math.max(1, x)) return [h2, k2];
    h0 = h1;
    h1 = h2;
    k0 = k1;
    k1 = k2;
    const f = v - a;
    if (f < 1e-15) return null;
    v = 1 / f;
  }
  return null;
}

export class Resampler {
  readonly step: number;
  readonly taps: number;
  /** Offset of the first tap relative to floor(position). */
  readonly firstTap: number;
  private readonly phases: number;
  private readonly exact: boolean;
  private readonly table: Float32Array;

  constructor(step: number, opts: ResamplerOptions = {}) {
    if (!(step > 0)) throw new Error('Resample step must be positive');
    this.step = step;
    const W = opts.halfWidth ?? 32;
    const beta = opts.beta ?? 9;
    const c = Math.min(1, 1 / step) * (opts.cutoff ?? 0.94);
    const reach = W / c;
    this.taps = 2 * Math.ceil(reach) + 1;
    this.firstTap = -Math.ceil(reach);
    const rat = rationalApprox(step, 2048);
    this.exact = rat !== null;
    this.phases = rat ? rat[1] : 512;
    const P = this.phases;
    const T = this.taps;
    const i0b = besselI0(beta);
    this.table = new Float32Array((P + 1) * T);
    for (let ph = 0; ph <= P; ph++) {
      const frac = ph / P;
      for (let j = 0; j < T; j++) {
        // distance (in input samples) from the output position to this tap
        const d = frac - (j + this.firstTap);
        const x = d * c;
        const r = Math.abs(x) / W;
        let v = 0;
        if (r < 1) {
          const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
          v = sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0b) * c;
        }
        this.table[ph * T + j] = v;
      }
    }
  }

  /** Number of output frames produced from inputFrames input frames. */
  outputLength(inputFrames: number): number {
    return Math.max(0, Math.floor((inputFrames - 1) / this.step) + 1);
  }

  /** Input frame range [start, end) required for output frames [outStart, outStart+outLen). */
  inputRange(outStart: number, outLen: number): [number, number] {
    const a = Math.floor(outStart * this.step) + this.firstTap;
    // +1: exact-phase rounding may advance the base index by one.
    const b = Math.floor((outStart + outLen - 1) * this.step) + this.firstTap + this.taps + 1;
    return [a, b];
  }

  /**
   * Output frame n is the input evaluated at position n * step. The reader
   * must return zeros outside the valid input range.
   */
  process(read: FrameReader, channelCount: number, outStart: number, outLen: number): Float32Array[] {
    const [inStart, inEnd] = this.inputRange(outStart, outLen);
    const src = read(inStart, inEnd - inStart);
    const out = Array.from({ length: channelCount }, () => new Float32Array(outLen));
    const T = this.taps;
    const P = this.phases;
    const tab = this.table;
    const w = new Float32Array(T);
    const stereo = channelCount === 2;
    const s0 = src[0];
    const s1 = stereo ? src[1] : s0;
    const o0 = out[0];
    const o1 = stereo ? out[1] : o0;
    for (let n = 0; n < outLen; n++) {
      const p = (outStart + n) * this.step;
      const ip = Math.floor(p);
      const frac = p - ip;
      const base = ip + this.firstTap - inStart;
      let row: number;
      if (this.exact) {
        let ph = Math.round(frac * P);
        let b = base;
        if (ph === P) {
          ph = 0;
          b += 1;
        }
        row = ph * T;
        if (stereo) {
          let a0 = 0,
            a1 = 0,
            c0 = 0,
            c1 = 0;
          let j = 0;
          for (; j + 1 < T; j += 2) {
            const wa = tab[row + j];
            const wb = tab[row + j + 1];
            a0 += wa * s0[b + j];
            a1 += wa * s1[b + j];
            c0 += wb * s0[b + j + 1];
            c1 += wb * s1[b + j + 1];
          }
          if (j < T) {
            const wa = tab[row + j];
            a0 += wa * s0[b + j];
            a1 += wa * s1[b + j];
          }
          o0[n] = a0 + c0;
          o1[n] = a1 + c1;
        } else {
          for (let ch = 0; ch < channelCount; ch++) {
            const s = src[ch];
            let a = 0;
            for (let j = 0; j < T; j++) a += tab[row + j] * s[b + j];
            out[ch][n] = a;
          }
        }
        continue;
      }
      const fp = frac * P;
      const ph = Math.min(P - 1, Math.floor(fp));
      const t = fp - ph;
      row = ph * T;
      const row2 = row + T;
      for (let j = 0; j < T; j++) {
        const a = tab[row + j];
        w[j] = a + t * (tab[row2 + j] - a);
      }
      if (stereo) {
        let a0 = 0,
          a1 = 0,
          c0 = 0,
          c1 = 0;
        let j = 0;
        for (; j + 1 < T; j += 2) {
          const wa = w[j];
          const wb = w[j + 1];
          a0 += wa * s0[base + j];
          a1 += wa * s1[base + j];
          c0 += wb * s0[base + j + 1];
          c1 += wb * s1[base + j + 1];
        }
        if (j < T) {
          a0 += w[j] * s0[base + j];
          a1 += w[j] * s1[base + j];
        }
        o0[n] = a0 + c0;
        o1[n] = a1 + c1;
      } else {
        for (let ch = 0; ch < channelCount; ch++) {
          const s = src[ch];
          let a = 0;
          for (let j = 0; j < T; j++) a += w[j] * s[base + j];
          out[ch][n] = a;
        }
      }
    }
    return out;
  }
}

/** Number of output frames for a given input length. */
export function resampledLength(inputFrames: number, step: number): number {
  return Math.max(0, Math.floor((inputFrames - 1) / step) + 1);
}

export function zeroPaddedReader(channels: Float32Array[]): FrameReader {
  const len = channels[0].length;
  return (start, length) =>
    channels.map((ch) => {
      if (start >= 0 && start + length <= len) return ch.subarray(start, start + length);
      const o = new Float32Array(length);
      const a = Math.max(0, start);
      const b = Math.min(len, start + length);
      if (b > a) o.set(ch.subarray(a, b), a - start);
      return o;
    });
}

/** Whole-buffer convenience wrapper. */
export function resampleBuffer(
  channels: Float32Array[],
  inRate: number,
  outRate: number,
  speed = 1,
  opts?: ResamplerOptions,
): Float32Array[] {
  const step = (speed * inRate) / outRate;
  if (step === 1) return channels.map((c) => c.slice());
  const rs = new Resampler(step, opts);
  const read = zeroPaddedReader(channels);
  const outLen = rs.outputLength(channels[0].length);
  const out = channels.map(() => new Float32Array(outLen));
  const BLOCK = 16384;
  for (let s = 0; s < outLen; s += BLOCK) {
    const n = Math.min(BLOCK, outLen - s);
    const blk = rs.process(read, channels.length, s, n);
    blk.forEach((b, i) => out[i].set(b, s));
  }
  return out;
}
