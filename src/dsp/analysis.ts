/** Silence detection and waveform peak summaries. */

export interface SilenceBounds {
  /** First frame of audible content. */
  start: number;
  /** Frame after the last audible content. */
  end: number;
}

/**
 * Finds leading/trailing audio below `thresholdDb` (sample peak, any channel)
 * using 10 ms windows. Keeps `prerollMs` before the first audible window and
 * `postrollMs` after the last.
 */
export function detectSilence(
  channels: Float32Array[],
  sampleRate: number,
  thresholdDb = -55,
  prerollMs = 10,
  postrollMs = 100,
): SilenceBounds {
  const len = channels[0].length;
  const win = Math.max(1, Math.round(sampleRate / 100));
  const thr = Math.pow(10, thresholdDb / 20);
  const loud = (w: number) => {
    const a = w * win;
    const b = Math.min(len, a + win);
    for (const ch of channels) for (let i = a; i < b; i++) if (Math.abs(ch[i]) > thr) return true;
    return false;
  };
  const nWin = Math.ceil(len / win);
  let first = -1;
  for (let w = 0; w < nWin; w++)
    if (loud(w)) {
      first = w;
      break;
    }
  if (first < 0) return { start: 0, end: 0 };
  let last = first;
  for (let w = nWin - 1; w >= first; w--)
    if (loud(w)) {
      last = w;
      break;
    }
  const start = Math.max(0, first * win - Math.round((prerollMs / 1000) * sampleRate));
  const end = Math.min(len, (last + 1) * win + Math.round((postrollMs / 1000) * sampleRate));
  return { start, end };
}

/**
 * Min/max envelope pyramid for drawing waveforms. Level 0 has one (min, max)
 * pair per BASE frames (across all channels); each next level halves it.
 */
export const PEAK_BASE = 128;

export interface PeakPyramid {
  frames: number;
  levels: { bucket: number; min: Float32Array; max: Float32Array }[];
}

export function buildPeaks(channels: Float32Array[]): PeakPyramid {
  const len = channels[0].length;
  const nb = Math.ceil(len / PEAK_BASE);
  const min = new Float32Array(nb);
  const max = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let lo = Infinity,
      hi = -Infinity;
    const a = b * PEAK_BASE;
    const e = Math.min(len, a + PEAK_BASE);
    for (const ch of channels) {
      for (let i = a; i < e; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  const levels = [{ bucket: PEAK_BASE, min, max }];
  while (levels[levels.length - 1].min.length > 64) {
    const prev = levels[levels.length - 1];
    const n = Math.ceil(prev.min.length / 2);
    const mn = new Float32Array(n);
    const mx = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = 2 * i;
      mn[i] = j + 1 < prev.min.length ? Math.min(prev.min[j], prev.min[j + 1]) : prev.min[j];
      mx[i] = j + 1 < prev.max.length ? Math.max(prev.max[j], prev.max[j + 1]) : prev.max[j];
    }
    levels.push({ bucket: prev.bucket * 2, min: mn, max: mx });
  }
  return { frames: len, levels };
}

/** Min/max over frames [a, b) using the coarsest level that still resolves the span. */
export function peakRange(p: PeakPyramid, a: number, b: number): [number, number] {
  if (b <= a) return [0, 0];
  const span = b - a;
  let lvl = p.levels[0];
  for (const l of p.levels) {
    if (l.bucket * 2 <= span) lvl = l;
    else break;
  }
  const i0 = Math.max(0, Math.floor(a / lvl.bucket));
  const i1 = Math.min(lvl.min.length, Math.ceil(b / lvl.bucket));
  let lo = Infinity,
    hi = -Infinity;
  for (let i = i0; i < i1; i++) {
    if (lvl.min[i] < lo) lo = lvl.min[i];
    if (lvl.max[i] > hi) hi = lvl.max[i];
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}
