/**
 * Timeline operations. The timeline is a list of clips played back to back;
 * its length is the sum of clip lengths. A seam between two clips that are
 * not contiguous in the same source gets a crossfade centred on the seam,
 * using material just outside each clip, so crossfades never change length.
 */
import type { BeatGrid, Clip, Id, Source } from './types';

export type NewId = () => Id;

export const clipLength = (c: Clip) => c.end - c.start;

export function clipStarts(clips: Clip[]): number[] {
  const out: number[] = new Array(clips.length);
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    out[i] = t;
    t += clipLength(clips[i]);
  }
  return out;
}

export function timelineLength(clips: Clip[]): number {
  let t = 0;
  for (const c of clips) t += clipLength(c);
  return t;
}

export function isContiguous(a: Clip, b: Clip): boolean {
  return a.sourceId === b.sourceId && a.end === b.start;
}

/** Index of the clip containing timeline frame t, and the offset into it. */
export function locate(clips: Clip[], t: number): { index: number; offset: number } | null {
  let pos = 0;
  for (let i = 0; i < clips.length; i++) {
    const len = clipLength(clips[i]);
    if (t >= pos && t < pos + len) return { index: i, offset: t - pos };
    pos += len;
  }
  return null;
}

export function timelineToSource(clips: Clip[], t: number): { sourceId: Id; frame: number } | null {
  const l = locate(clips, t);
  if (!l) return null;
  const c = clips[l.index];
  return { sourceId: c.sourceId, frame: c.start + l.offset };
}

/** Splits the clip containing t (if t is strictly inside it). */
export function splitAt(clips: Clip[], t: number, newId: NewId): Clip[] {
  const l = locate(clips, t);
  if (!l || l.offset === 0) return clips.slice();
  const c = clips[l.index];
  const left: Clip = { ...c, end: c.start + l.offset };
  const right: Clip = { id: newId(), sourceId: c.sourceId, start: c.start + l.offset, end: c.end, xfade: 0 };
  return [...clips.slice(0, l.index), left, right, ...clips.slice(l.index + 1)];
}

/** Merges neighbours that are contiguous in the same source. */
export function mergeContiguous(clips: Clip[]): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const prev = out[out.length - 1];
    if (prev && isContiguous(prev, c)) out[out.length - 1] = { ...prev, end: c.end };
    else out.push({ ...c });
  }
  if (out.length) out[0] = { ...out[0], xfade: 0 };
  return out;
}

function fixSeam(clips: Clip[], i: number, xfade: number): void {
  if (i <= 0 || i >= clips.length) {
    if (i === 0 && clips.length) clips[0] = { ...clips[0], xfade: 0 };
    return;
  }
  clips[i] = { ...clips[i], xfade: isContiguous(clips[i - 1], clips[i]) ? 0 : xfade };
}

/** Removes timeline range [s, e) and joins the remaining parts with a crossfade. */
export function deleteRange(clips: Clip[], s: number, e: number, xfade: number, newId: NewId): Clip[] {
  if (e <= s) return clips.slice();
  const cl = splitAt(splitAt(clips, s, newId), e, newId);
  const starts = clipStarts(cl);
  const out: Clip[] = [];
  let seam = -1;
  for (let i = 0; i < cl.length; i++) {
    const t = starts[i];
    if (t >= s && t + clipLength(cl[i]) <= e) {
      seam = out.length;
      continue;
    }
    out.push(cl[i]);
  }
  if (seam >= 0) fixSeam(out, seam, xfade);
  return mergeContiguous(out);
}

/** Keeps only timeline range [s, e). */
export function keepRange(clips: Clip[], s: number, e: number, newId: NewId): Clip[] {
  if (e <= s) return clips.slice();
  const cl = splitAt(splitAt(clips, s, newId), e, newId);
  const starts = clipStarts(cl);
  const out = cl.filter((c, i) => starts[i] >= s && starts[i] + clipLength(c) <= e);
  return mergeContiguous(out);
}

/** Inserts clips at timeline frame t (splitting if needed). */
export function insertClips(clips: Clip[], t: number, add: Clip[], xfade: number, newId: NewId): Clip[] {
  if (!add.length) return clips.slice();
  const cl = splitAt(clips, t, newId);
  const starts = clipStarts(cl);
  let idx = cl.length;
  for (let i = 0; i < cl.length; i++)
    if (starts[i] >= t) {
      idx = i;
      break;
    }
  const out = [...cl.slice(0, idx), ...add.map((c) => ({ ...c })), ...cl.slice(idx)];
  fixSeam(out, idx, xfade);
  fixSeam(out, idx + add.length, xfade);
  return mergeContiguous(out);
}

/** Copies of the clips covering [s, e), with fresh ids. */
export function copyRange(clips: Clip[], s: number, e: number, newId: NewId): Clip[] {
  const cl = splitAt(splitAt(clips, s, newId), e, newId);
  const starts = clipStarts(cl);
  return cl
    .filter((c, i) => starts[i] >= s && starts[i] + clipLength(c) <= e)
    .map((c, i) => ({ ...c, id: newId(), xfade: i === 0 ? 0 : c.xfade }));
}

/** Repeats [s, e) `times` extra times directly after itself. */
export function repeatRange(clips: Clip[], s: number, e: number, times: number, xfade: number, newId: NewId): Clip[] {
  let out = clips.slice();
  for (let k = 0; k < times; k++) {
    const copy = copyRange(clips, s, e, newId);
    out = insertClips(out, e + k * (e - s), copy, xfade, newId);
  }
  return out;
}

/** Appends a whole source at the end of the timeline. */
export function appendSource(clips: Clip[], source: Source, xfade: number, newId: NewId): Clip[] {
  return insertClips(clips, timelineLength(clips), [{ id: newId(), sourceId: source.id, start: 0, end: source.frames, xfade: 0 }], xfade, newId);
}

export interface SeamExtent {
  /** Frames before the seam covered by the crossfade. */
  pre: number;
  /** Frames after the seam covered by the crossfade. */
  post: number;
}

/**
 * Crossfade extent at the seam before clip i. The outgoing clip continues
 * past its end (needs source material there) and the incoming clip starts
 * early (needs material before its start); each side may use at most half of
 * the adjacent clip so neighbouring seams never overlap.
 */
export function seamExtent(clips: Clip[], sources: Map<Id, Source> | Source[], i: number): SeamExtent {
  if (i <= 0 || i >= clips.length) return { pre: 0, post: 0 };
  const a = clips[i - 1];
  const b = clips[i];
  if (isContiguous(a, b) || b.xfade <= 0) return { pre: 0, post: 0 };
  const srcA = sources instanceof Map ? sources.get(a.sourceId) : sources.find((s) => s.id === a.sourceId);
  const srcLenA = srcA?.frames ?? a.end;
  const half = Math.floor(b.xfade / 2);
  const pre = Math.max(0, Math.min(half, b.start, Math.floor(clipLength(a) / 2)));
  const post = Math.max(0, Math.min(b.xfade - half, srcLenA - a.end, Math.floor(clipLength(b) / 2)));
  return { pre, post };
}

export interface TimelineBeat {
  /** Timeline frame. */
  t: number;
  /** True for the first beat of a bar. */
  bar: boolean;
}

/** Maps each clip's source beats onto the timeline. */
export function timelineBeats(clips: Clip[], grids: Record<Id, BeatGrid>, sampleRate: number): TimelineBeat[] {
  const starts = clipStarts(clips);
  const out: TimelineBeat[] = [];
  clips.forEach((c, i) => {
    const g = grids[c.sourceId];
    if (!g || !g.beats.length) return;
    const per = g.beatsPerBar || 4;
    for (let k = 0; k < g.beats.length; k++) {
      const f = Math.round(g.beats[k] * sampleRate);
      if (f < c.start || f >= c.end) continue;
      const bar = (((k - g.barOffset) % per) + per) % per === 0;
      out.push({ t: starts[i] + (f - c.start), bar });
    }
  });
  return out;
}

/** Nearest snap target to t among candidates (within maxDist frames), else t. */
export function snap(t: number, candidates: number[], maxDist: number): number {
  let best = t;
  let bestD = maxDist;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
