/**
 * Biquad filters using the coefficient formulas of the W3C Web Audio API
 * BiquadFilterNode (§1.13.5 "Filters Characteristics"). Implementing the same
 * formulas lets the live preview (native BiquadFilterNode) and the offline
 * export (this code) produce the same response.
 *
 * Spec details that matter here:
 *  - lowpass/highpass interpret Q in dB (alpha = sin(w0) / (2 * 10^(Q/20))).
 *  - peaking interprets Q linearly.
 *  - lowshelf/highshelf ignore Q and use a fixed shelf slope S = 1.
 */

export type BiquadType = 'lowpass' | 'highpass' | 'lowshelf' | 'highshelf' | 'peaking';

export interface BiquadParams {
  type: BiquadType;
  frequency: number;
  /** dB for lowpass/highpass, linear for peaking, unused for shelves. */
  Q: number;
  /** dB; used by shelves and peaking. */
  gain: number;
}

/** Normalised coefficients (divided by a0). */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function biquadCoeffs(p: BiquadParams, sampleRate: number): BiquadCoeffs {
  const nyquist = sampleRate / 2;
  const f0 = Math.min(Math.max(p.frequency, 0), nyquist);
  const A = Math.pow(10, p.gain / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;

  switch (p.type) {
    case 'lowpass': {
      const alpha = sinw / (2 * Math.pow(10, p.Q / 20));
      b0 = (1 - cosw) / 2;
      b1 = 1 - cosw;
      b2 = (1 - cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    }
    case 'highpass': {
      const alpha = sinw / (2 * Math.pow(10, p.Q / 20));
      b0 = (1 + cosw) / 2;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
      break;
    }
    case 'peaking': {
      const alpha = sinw / (2 * p.Q);
      b0 = 1 + alpha * A;
      b1 = -2 * cosw;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw;
      a2 = 1 - alpha / A;
      break;
    }
    case 'lowshelf': {
      const S = 1;
      const alphaS = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      const k = 2 * alphaS * Math.sqrt(A);
      b0 = A * (A + 1 - (A - 1) * cosw + k);
      b1 = 2 * A * (A - 1 - (A + 1) * cosw);
      b2 = A * (A + 1 - (A - 1) * cosw - k);
      a0 = A + 1 + (A - 1) * cosw + k;
      a1 = -2 * (A - 1 + (A + 1) * cosw);
      a2 = A + 1 + (A - 1) * cosw - k;
      break;
    }
    case 'highshelf': {
      const S = 1;
      const alphaS = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
      const k = 2 * alphaS * Math.sqrt(A);
      b0 = A * (A + 1 + (A - 1) * cosw + k);
      b1 = -2 * A * (A - 1 + (A + 1) * cosw);
      b2 = A * (A + 1 + (A - 1) * cosw - k);
      a0 = A + 1 - (A - 1) * cosw + k;
      a1 = 2 * (A - 1 - (A + 1) * cosw);
      a2 = A + 1 - (A - 1) * cosw - k;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(e^{jw})| of a normalised biquad at frequency f (Hz). */
export function biquadMagnitude(c: BiquadCoeffs, f: number, sampleRate: number): number {
  const w = (2 * Math.PI * f) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const ni = -(c.b1 * sin1 + c.b2 * sin2);
  const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
  const di = -(c.a1 * sin1 + c.a2 * sin2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/**
 * Stateful biquad (transposed direct form II, double-precision state) for one
 * channel. Matches the difference equation in the Web Audio spec:
 * y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2].
 */
export class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(public c: BiquadCoeffs) {}

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(buf: Float32Array | Float64Array, start = 0, end = buf.length): void {
    const { b0, b1, b2, a1, a2 } = this.c;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    // Flush denormals that would otherwise slow down long silent tails.
    this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2;
  }

  processInto(input: Float32Array, output: Float32Array | Float64Array, n: number): void {
    const { b0, b1, b2, a1, a2 } = this.c;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = 0; i < n; i++) {
      const x = input[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      output[i] = y;
    }
    this.z1 = Math.abs(z1) < 1e-30 ? 0 : z1;
    this.z2 = Math.abs(z2) < 1e-30 ? 0 : z2;
  }
}
