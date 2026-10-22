import type { BiquadParams } from '../dsp/biquad';
import type { EqSettings } from '../model/types';

/** Web Audio lowpass/highpass Q is in dB; this is a Butterworth (Q = 1/sqrt 2) response. */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2);

/**
 * The active filters of an EQ setting, in processing order. Neutral bands are
 * omitted. Shared by the offline renderer and the live preview so that both
 * use identical filters.
 */
export function eqToBiquads(eq: EqSettings, sampleRate: number): BiquadParams[] {
  const nyq = sampleRate / 2;
  const out: BiquadParams[] = [];
  if (eq.hpf > 0 && eq.hpf < nyq) out.push({ type: 'highpass', frequency: eq.hpf, Q: BUTTERWORTH_Q_DB, gain: 0 });
  if (eq.lowShelf.gain !== 0) out.push({ type: 'lowshelf', frequency: eq.lowShelf.freq, Q: 1, gain: eq.lowShelf.gain });
  if (eq.mid.gain !== 0) out.push({ type: 'peaking', frequency: eq.mid.freq, Q: eq.mid.q, gain: eq.mid.gain });
  if (eq.highShelf.gain !== 0 && eq.highShelf.freq < nyq)
    out.push({ type: 'highshelf', frequency: eq.highShelf.freq, Q: 1, gain: eq.highShelf.gain });
  if (eq.lpf > 0 && eq.lpf < nyq) out.push({ type: 'lowpass', frequency: eq.lpf, Q: BUTTERWORTH_Q_DB, gain: 0 });
  return out;
}

export function isFlat(eq: EqSettings, sampleRate: number): boolean {
  return eqToBiquads(eq, sampleRate).length === 0;
}
