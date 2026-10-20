export type FadeCurve = 'linear' | 'equalPower' | 'sCurve' | 'exponential';

export const FADE_CURVES: { id: FadeCurve; label: string }[] = [
  { id: 'sCurve', label: 'Smooth' },
  { id: 'linear', label: 'Linear' },
  { id: 'equalPower', label: 'Equal power' },
  { id: 'exponential', label: 'Exponential (dB-linear)' },
];

/** Fade-in gain for progress t in [0, 1]; a fade-out uses fadeGain(curve, 1 - t). */
export function fadeGain(curve: FadeCurve, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (curve) {
    case 'linear':
      return t;
    case 'equalPower':
      return Math.sin((t * Math.PI) / 2);
    case 'sCurve':
      return 0.5 - 0.5 * Math.cos(Math.PI * t);
    case 'exponential':
      // 60 dB range, shifted so the curve reaches exactly 0 at t = 0.
      return (Math.pow(1000, t) - 1) / 999;
  }
}

/** Equal-power crossfade gains (for uncorrelated material) at progress t. */
export function crossfadeGains(t: number): [out: number, inn: number] {
  const c = Math.min(1, Math.max(0, t));
  return [Math.cos((c * Math.PI) / 2), Math.sin((c * Math.PI) / 2)];
}

/** Samples a fade curve for Web Audio setValueCurveAtTime. */
export function fadeCurveTable(curve: FadeCurve, fadeIn: boolean, points = 256): Float32Array {
  const out = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    out[i] = fadeGain(curve, fadeIn ? t : 1 - t);
  }
  return out;
}
