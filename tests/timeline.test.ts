import { describe, expect, it } from 'vitest';
import {
  appendSource,
  clipStarts,
  deleteRange,
  insertClips,
  keepRange,
  copyRange,
  repeatRange,
  seamExtent,
  snap,
  splitAt,
  timelineBeats,
  timelineLength,
  timelineToSource,
} from '../src/model/timeline';
import type { Clip, Source } from '../src/model/types';
import { History, editState, newProject, newLayer, newSource } from '../src/model/project';
import { rng } from './helpers';

let n = 0;
const newId = () => `c${++n}`;
const src = (id: string, frames: number): Source => ({ id, name: id, frames, layers: [] });

/** Reference model: one [sourceId, frame] pair per timeline frame. */
type Ref = [string, number][];
const refOf = (clips: Clip[]): Ref => clips.flatMap((c) => Array.from({ length: c.end - c.start }, (_, k) => [c.sourceId, c.start + k] as [string, number]));

describe('timeline operations', () => {
  const A = src('A', 1000);
  const B = src('B', 500);
  const base: Clip[] = [{ id: 'x', sourceId: 'A', start: 0, end: 1000, xfade: 0 }];

  it('delete joins with a crossfade and shortens the timeline', () => {
    const out = deleteRange(base, 200, 300, 40, newId);
    expect(timelineLength(out)).toBe(900);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ start: 300, end: 1000, xfade: 40 });
    expect(seamExtent(out, [A], 1)).toEqual({ pre: 20, post: 20 });
  });

  it('delete at the very start leaves no seam', () => {
    const out = deleteRange(base, 0, 100, 40, newId);
    expect(out).toEqual([{ id: expect.any(String), sourceId: 'A', start: 100, end: 1000, xfade: 0 }]);
  });

  it('keep, duplicate, insert, append', () => {
    expect(keepRange(base, 100, 400, newId)).toEqual([{ id: expect.any(String), sourceId: 'A', start: 100, end: 400, xfade: 0 }]);
    const dup = repeatRange(base, 100, 200, 1, 30, newId);
    expect(timelineLength(dup)).toBe(1100);
    // [0,200) + copy [100,200) + [200,1000); the copy->rest seam is contiguous, so it merges.
    expect(dup.map((c) => [c.start, c.end, c.xfade])).toEqual([
      [0, 200, 0],
      [100, 1000, 30],
    ]);
    const ins = insertClips(base, 500, [{ id: 'b', sourceId: 'B', start: 0, end: 500, xfade: 0 }], 20, newId);
    expect(ins.map((c) => [c.sourceId, c.start, c.end, c.xfade])).toEqual([
      ['A', 0, 500, 0],
      ['B', 0, 500, 20],
      ['A', 500, 1000, 20],
    ]);
    const app = appendSource(base, B, 0, newId);
    expect(timelineLength(app)).toBe(1500);
  });

  it('seam extents are limited by available material and clip halves', () => {
    const clips: Clip[] = [
      { id: '1', sourceId: 'A', start: 900, end: 1000, xfade: 0 },
      { id: '2', sourceId: 'B', start: 10, end: 500, xfade: 400 },
    ];
    // outgoing clip ends at the end of its source: no material after the seam
    expect(seamExtent(clips, [A, B], 1)).toEqual({ pre: 10, post: 0 });
    const clips2: Clip[] = [
      { id: '1', sourceId: 'A', start: 0, end: 60, xfade: 0 },
      { id: '2', sourceId: 'B', start: 300, end: 500, xfade: 400 },
    ];
    expect(seamExtent(clips2, [A, B], 1)).toEqual({ pre: 30, post: 100 });
  });

  it('random edit sequences agree with a frame-by-frame reference model', () => {
    const r = rng(42);
    for (let trial = 0; trial < 200; trial++) {
      let clips: Clip[] = [
        { id: newId(), sourceId: 'A', start: 0, end: 1000, xfade: 0 },
        { id: newId(), sourceId: 'B', start: 0, end: 500, xfade: 0 },
      ];
      let ref = refOf(clips);
      for (let step = 0; step < 6; step++) {
        const len = ref.length;
        if (len < 4) break;
        const s = Math.floor(r() * (len - 1));
        const e = s + 1 + Math.floor(r() * (len - s - 1));
        const op = Math.floor(r() * 5);
        if (op === 0 && e - s < len) {
          clips = deleteRange(clips, s, e, 16, newId);
          ref = [...ref.slice(0, s), ...ref.slice(e)];
        } else if (op === 1) {
          clips = keepRange(clips, s, e, newId);
          ref = ref.slice(s, e);
        } else if (op === 2 && len < 4000) {
          clips = repeatRange(clips, s, e, 1, 16, newId);
          ref = [...ref.slice(0, e), ...ref.slice(s, e), ...ref.slice(e)];
        } else if (op === 3) {
          clips = splitAt(clips, s, newId);
        } else if (len < 4000) {
          const copy = copyRange(clips, s, e, newId);
          const at = Math.floor(r() * len);
          clips = insertClips(clips, at, copy, 16, newId);
          ref = [...ref.slice(0, at), ...ref.slice(s, e), ...ref.slice(at)];
        }
        expect(timelineLength(clips)).toBe(ref.length);
        for (let t = 0; t < ref.length; t += 7) {
          const m = timelineToSource(clips, t)!;
          expect([m.sourceId, m.frame]).toEqual(ref[t]);
        }
        // invariants
        expect(clips[0].xfade).toBe(0);
        for (const c of clips) expect(c.end).toBeGreaterThan(c.start);
      }
    }
  });

  it('maps beat grids onto the timeline and snaps', () => {
    const clips: Clip[] = [
      { id: '1', sourceId: 'A', start: 0, end: 48000, xfade: 0 },
      { id: '2', sourceId: 'A', start: 96000, end: 144000, xfade: 0 },
    ];
    const grids = { A: { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3], bpm: 120, barOffset: 0, beatsPerBar: 4 } };
    const tb = timelineBeats(clips, grids, 48000);
    expect(tb.map((b) => b.t)).toEqual([0, 24000, 48000, 72000]);
    expect(tb.map((b) => b.bar)).toEqual([true, false, true, false]);
    expect(snap(23000, [0, 24000, 48000], 2000)).toBe(24000);
    expect(snap(20000, [0, 24000, 48000], 2000)).toBe(20000);
    expect(clipStarts(clips)).toEqual([0, 48000]);
  });
});

describe('project & history', () => {
  it('creates a project with one clip over the first source and supports undo/redo', () => {
    const s = newSource('Song', [newLayer('f1', 'Song.mp3', 1000, 2)]);
    const p = newProject('Song', 48000, [s]);
    expect(p.clips).toHaveLength(1);
    expect(p.clips[0]).toMatchObject({ start: 0, end: 1000 });
    const h = new History();
    const before = editState(p);
    p.gainDb = -3;
    h.push(before);
    const undone = h.undo(editState(p))!;
    expect(undone.gainDb).toBe(0);
    const redone = h.redo(undone)!;
    expect(redone.gainDb).toBe(-3);
    expect(h.canRedo).toBe(false);
  });
});
