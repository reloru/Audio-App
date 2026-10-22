/** State and actions of the editor screen. */
import { Player } from '../audio/player';
import type { LoudnessResult } from '../dsp/loudness';
import { ArrangementReader, type LayerAudio } from '../engine/render';
import { exportProject, analyzeProject, exportRange, type ExportResult, type ExportStage } from '../engine/export';
import { createMp3Sink, withWakeLock, yieldToUi } from '../engine/browser';
import { History, editState, newProject, uid, type EditState } from '../model/project';
import { DEFAULT_XFADE_MS } from '../model/presets';
import {
  clipStarts,
  deleteRange,
  insertClips,
  keepRange,
  repeatRange,
  snap,
  splitAt,
  timelineBeats,
  timelineLength,
  type TimelineBeat,
} from '../model/timeline';
import type { FadeSpec, Id, Layer, Project, Selection, Source } from '../model/types';
import { putProject } from '../storage/db';
import { decodeIntoProject, decodeStems, loadCover, type LoadedLayer, type ProgressFn } from './importer';
import { toast, errorText } from './toast';

export type SnapMode = 'off' | 'beat' | 'bar';
export type Tab = 'edit' | 'mix' | 'sound' | 'loudness' | 'export';

export interface ExportState {
  stage: ExportStage | 'encode' | 'done' | 'error';
  progress: number;
  result?: ExportResult;
  error?: string;
}

export class EditorStore {
  project: Project;
  readonly layers: Map<Id, LoadedLayer>;
  readonly history = new History();
  readonly player = new Player();

  selection: Selection | null = null;
  playhead = 0;
  snapMode: SnapMode = 'beat';
  loop = false;
  view = { start: 0, fpp: 100 };
  viewWidth = 360;
  selectedSeam: number | null = null;
  tab: Tab = 'edit';
  analysis: { result: LoudnessResult | null; key: string; running: boolean; progress: number } = {
    result: null,
    key: '',
    running: false,
    progress: 0,
  };
  exportState: ExportState | null = null;
  busy: { text: string; progress: number } | null = null;

  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private mergeKey = '';
  private mergeAt = 0;
  private beatsCache: { key: string; beats: TimelineBeat[] } = { key: '', beats: [] };
  private exportAbort: AbortController | null = null;
  version = 0;

  constructor(project: Project, layers: Map<Id, LoadedLayer>) {
    this.project = project;
    this.layers = layers;
    this.player.onEnded = () => {
      this.playhead = this.length;
      this.emit();
    };
    this.syncPlayer();
  }

  // ------------------------------------------------------------ basics
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  get sr(): number {
    return this.project.sampleRate;
  }

  get length(): number {
    return timelineLength(this.project.clips);
  }

  /** Seconds of output time for a number of timeline frames. */
  sec(frames: number): number {
    return frames / (this.sr * this.project.speed);
  }

  get audio(): LayerAudio {
    return new Map([...this.layers].map(([id, l]) => [id, l.pcm]));
  }

  get buffers(): Map<Id, AudioBuffer> {
    return new Map([...this.layers].map(([id, l]) => [id, l.buffer]));
  }

  sourceById(id: Id): Source | undefined {
    return this.project.sources.find((s) => s.id === id);
  }

  // ------------------------------------------------------------ persistence
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await putProject(this.project);
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error');
    }
  }

  // ------------------------------------------------------------ mutation
  /**
   * Applies an undoable change. Consecutive changes with the same `merge` key
   * (e.g. one slider drag) within 1.5 s become one undo step.
   */
  commit(fn: (draft: Project) => void, merge?: string): void {
    const now = Date.now();
    const before = editState(this.project);
    const draft = structuredClone(this.project);
    fn(draft);
    draft.updatedAt = now;
    if (!(merge && merge === this.mergeKey && now - this.mergeAt < 1500)) this.history.push(before);
    this.mergeKey = merge ?? '';
    this.mergeAt = now;
    this.project = draft;
    this.afterChange();
  }

  private restore(s: EditState): void {
    this.project = { ...this.project, ...structuredClone(s), updatedAt: Date.now() };
    this.mergeKey = '';
    this.afterChange();
  }

  undo(): void {
    const s = this.history.undo(editState(this.project));
    if (s) this.restore(s);
  }

  redo(): void {
    const s = this.history.redo(editState(this.project));
    if (s) this.restore(s);
  }

  private afterChange(): void {
    const len = this.length;
    if (this.selection) {
      const s = { start: Math.max(0, Math.min(len, this.selection.start)), end: Math.max(0, Math.min(len, this.selection.end)) };
      this.selection = s.end - s.start > 0 ? s : null;
    }
    this.playhead = Math.min(this.playhead, len);
    if (this.selectedSeam !== null && this.selectedSeam >= this.project.clips.length) this.selectedSeam = null;
    if (this.view.fpp > this.maxFpp()) this.view = { start: 0, fpp: Math.max(1, len) / Math.max(100, this.viewWidth) };
    else this.view.start = this.clampStart(this.view.start);
    this.syncPlayer();
    this.scheduleSave();
    this.emit();
  }

  /** UI-only state changes (not undoable, not saved). */
  set(patch: Partial<Pick<EditorStore, 'selection' | 'snapMode' | 'loop' | 'selectedSeam' | 'tab'>>): void {
    Object.assign(this, patch);
    if ('selection' in patch || 'loop' in patch) this.syncPlayer();
    if (('loop' in patch || 'selection' in patch) && this.player.playing) {
      void this.player.play(this.player.position(), this.loopRange());
    }
    this.emit();
  }

  // ------------------------------------------------------------ playback
  previewGainDb(): number {
    const m = this.project.master;
    const r = this.analysis.result;
    if (!m.normalize || !r || !Number.isFinite(r.integrated)) return 0;
    return m.targetLufs - r.integrated;
  }

  private fadeRange(): Selection | null {
    return exportRange(this.project, this.selection) ?? null;
  }

  syncPlayer(): void {
    this.player.setInput({ project: this.project, buffers: this.buffers, previewGainDb: this.previewGainDb(), fadeRange: this.fadeRange() });
  }

  loopRange(): Selection | null {
    return this.loop && this.selection ? this.selection : null;
  }

  async togglePlay(): Promise<void> {
    if (this.player.playing) {
      this.playhead = this.player.position();
      this.player.pause();
    } else {
      let from = this.playhead;
      if (from >= this.length - 1) from = 0;
      const loop = this.loopRange();
      if (!loop && this.selection && (from < this.selection.start || from >= this.selection.end)) from = this.selection.start;
      await this.player.play(from, loop);
      this.startTicker();
    }
    this.emit();
  }

  private frameCbs = new Set<() => void>();
  private raf = 0;

  /** Per-animation-frame callbacks while playing (playhead, time display). */
  onFrame(cb: () => void): () => void {
    this.frameCbs.add(cb);
    return () => void this.frameCbs.delete(cb);
  }

  private startTicker(): void {
    if (this.raf) return;
    const loop = () => {
      for (const cb of this.frameCbs) cb();
      if (this.player.playing) this.raf = requestAnimationFrame(loop);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  setPlayhead(frame: number): void {
    this.playhead = Math.max(0, Math.min(this.length, Math.round(frame)));
    this.player.seek(this.playhead);
    this.emit();
  }

  currentPosition(): number {
    return this.player.playing ? this.player.position() : this.playhead;
  }

  // ------------------------------------------------------------ snapping
  beats(): TimelineBeat[] {
    const key = JSON.stringify([this.project.clips, this.project.grids]);
    if (key !== this.beatsCache.key) this.beatsCache = { key, beats: timelineBeats(this.project.clips, this.project.grids, this.sr) };
    return this.beatsCache.beats;
  }

  snapTargets(): number[] {
    const t: number[] = [0, this.length, ...clipStarts(this.project.clips)];
    if (this.snapMode === 'off') return t;
    for (const b of this.beats()) if (this.snapMode === 'beat' || b.bar) t.push(b.t);
    return t;
  }

  snapFrame(t: number, px = 16): number {
    if (this.snapMode === 'off') return Math.round(t);
    return Math.round(snap(t, this.snapTargets(), px * this.view.fpp));
  }

  /** Moves a frame by one snap unit (beat/bar) or 10 ms. */
  nudge(t: number, dir: -1 | 1): number {
    if (this.snapMode !== 'off') {
      const targets = this.snapTargets().sort((a, b) => a - b);
      if (dir > 0) return targets.find((x) => x > t + 1) ?? this.length;
      for (let i = targets.length - 1; i >= 0; i--) if (targets[i] < t - 1) return targets[i];
      return 0;
    }
    return Math.max(0, Math.min(this.length, t + dir * Math.round(0.01 * this.sr)));
  }

  // ------------------------------------------------------------ view
  fit(): void {
    const len = Math.max(1, this.length);
    this.view = { start: 0, fpp: len / Math.max(100, this.viewWidth) };
    this.emit();
  }

  maxFpp(): number {
    return Math.max(1, this.length / Math.max(100, this.viewWidth)) * 1.02;
  }

  minFpp(): number {
    return 0.5;
  }

  zoomAt(factor: number, x: number): void {
    const at = this.view.start + x * this.view.fpp;
    const fpp = Math.max(this.minFpp(), Math.min(this.maxFpp(), this.view.fpp / factor));
    this.view = { fpp, start: this.clampStart(at - x * fpp, fpp) };
    this.emit();
  }

  clampStart(start: number, fpp = this.view.fpp): number {
    const visible = this.viewWidth * fpp;
    return Math.max(0, Math.min(Math.max(0, this.length - visible), start));
  }

  scrollTo(start: number): void {
    this.view = { ...this.view, start: this.clampStart(start) };
    this.emit();
  }

  /** Keeps frame t visible (used while following the playhead). */
  follow(t: number): boolean {
    const visible = this.viewWidth * this.view.fpp;
    if (t < this.view.start || t > this.view.start + visible * 0.92) {
      this.view = { ...this.view, start: this.clampStart(t - visible * 0.08) };
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ edits
  xfadeFrames(): number {
    return Math.round((DEFAULT_XFADE_MS / 1000) * this.sr);
  }

  private needSelection(): Selection | null {
    if (!this.selection || this.selection.end - this.selection.start < 1) {
      toast('Select a part of the song first (drag across the waveform).');
      return null;
    }
    return this.selection;
  }

  deleteSelection(): void {
    const s = this.needSelection();
    if (!s) return;
    if (s.start <= 0 && s.end >= this.length) {
      toast('That would remove the whole song.');
      return;
    }
    this.commit((d) => {
      d.clips = deleteRange(d.clips, s.start, s.end, this.xfadeFrames(), uid);
    });
    this.selection = null;
    this.setPlayhead(s.start);
    toast(`Cut ${this.sec(s.end - s.start).toFixed(1)} s`);
  }

  keepSelection(): void {
    const s = this.needSelection();
    if (!s) return;
    this.commit((d) => {
      d.clips = keepRange(d.clips, s.start, s.end, uid);
    });
    this.selection = null;
    this.setPlayhead(0);
    this.fit();
  }

  repeatSelection(times = 1): void {
    const s = this.needSelection();
    if (!s) return;
    this.commit((d) => {
      d.clips = repeatRange(d.clips, s.start, s.end, times, this.xfadeFrames(), uid);
    });
    toast(times === 1 ? 'Section repeated' : `Section repeated ${times}×`);
  }

  splitAtPlayhead(): void {
    const t = this.currentPosition();
    this.commit((d) => {
      d.clips = splitAt(d.clips, t, uid);
    });
  }

  /** Ends the song at the playhead with a fade-out of `fadeSec`. */
  endHere(fadeSec = 3): void {
    const t = this.currentPosition();
    if (t < this.sr * 0.5) return void toast('Move the playhead to where the song should end.');
    this.commit((d) => {
      d.clips = keepRange(d.clips, 0, t, uid);
      d.fadeOut = { ...d.fadeOut, seconds: Math.min(fadeSec, (t / this.sr) * 0.5) };
    });
    this.player.pause();
    this.setPlayhead(Math.max(0, t - Math.round(this.sr * (fadeSec + 2))));
    toast(`Song now ends at ${(t / this.sr).toFixed(1)} s with a ${fadeSec} s fade`);
  }

  startHere(): void {
    const t = this.currentPosition();
    if (t <= 0 || t >= this.length - this.sr * 0.5) return;
    this.commit((d) => {
      d.clips = keepRange(d.clips, t, timelineLength(d.clips), uid);
    });
    this.setPlayhead(0);
  }

  /** Removes leading and trailing near-silence (below -55 dBFS). */
  trimSilence(): void {
    const reader = new ArrangementReader(this.project, this.audio);
    const len = reader.length;
    const thr = Math.pow(10, -55 / 20);
    const BLOCK = 65536;
    let first = -1;
    for (let s = 0; s < len && first < 0; s += BLOCK) {
      const [L, R] = reader.read(s, Math.min(BLOCK, len - s));
      for (let i = 0; i < L.length; i++)
        if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) {
          first = s + i;
          break;
        }
    }
    if (first < 0) return void toast('The song is silent.');
    let last = first;
    for (let e = len; e > first && last === first; e -= BLOCK) {
      const s = Math.max(first, e - BLOCK);
      const [L, R] = reader.read(s, e - s);
      for (let i = L.length - 1; i >= 0; i--)
        if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) {
          last = s + i;
          break;
        }
    }
    const start = Math.max(0, first - Math.round(0.01 * this.sr));
    const end = Math.min(len, last + Math.round(0.1 * this.sr));
    if (start === 0 && end === len) return void toast('No silence to trim.');
    this.commit((d) => {
      d.clips = keepRange(d.clips, start, end, uid);
    });
    this.fit();
    toast(`Trimmed ${(start / this.sr).toFixed(2)} s at the start and ${((len - end) / this.sr).toFixed(2)} s at the end`);
  }

  setFade(which: 'fadeIn' | 'fadeOut', patch: Partial<FadeSpec>, merge = true): void {
    this.commit((d) => {
      d[which] = { ...d[which], ...patch };
    }, merge ? which : undefined);
  }

  setSeamXfade(index: number, ms: number): void {
    this.commit((d) => {
      if (d.clips[index]) d.clips[index].xfade = Math.round((ms / 1000) * this.sr);
    }, `seam${index}`);
  }

  /** Selects `seconds` starting at the bar at/before the playhead and loops it. */
  makeClipSelection(seconds: number): void {
    const len = this.length;
    const want = Math.round(seconds * this.sr * this.project.speed);
    let start = this.currentPosition();
    if (this.selection) start = this.selection.start;
    const bars = this.beats().filter((b) => b.bar);
    if (bars.length) {
      const prev = [...bars].reverse().find((b) => b.t <= start + 1);
      if (prev) start = prev.t;
    }
    if (start + want > len) start = Math.max(0, len - want);
    this.selection = { start, end: Math.min(len, start + want) };
    this.loop = true;
    this.syncPlayer();
    this.ensureVisible(this.selection.start, this.selection.end);
    if (this.player.playing) void this.player.play(start, this.loopRange());
    this.emit();
  }

  ensureVisible(a: number, b: number): void {
    const visible = this.viewWidth * this.view.fpp;
    if (b - a > visible) this.view = { start: 0, fpp: this.view.fpp };
    if (a < this.view.start || b > this.view.start + visible) {
      const fpp = Math.min(this.maxFpp(), Math.max(this.view.fpp, ((b - a) * 1.2) / this.viewWidth));
      this.view = { fpp, start: this.clampStart(a - (this.viewWidth * fpp - (b - a)) / 2, fpp) };
    }
  }

  /** Saves the selection as a new project with fades (for social clips, ringtones). */
  async saveSelectionAsProject(fadeInSec: number, fadeOutSec: number, label: string): Promise<Project | null> {
    const s = this.needSelection();
    if (!s) return null;
    const src = this.project;
    const p = newProject(`${src.name} – ${label}`, src.sampleRate, structuredClone(src.sources), keepRange(src.clips, s.start, s.end, uid));
    Object.assign(p, {
      eq: structuredClone(src.eq),
      width: src.width,
      speed: src.speed,
      gainDb: src.gainDb,
      master: { ...src.master },
      grids: structuredClone(src.grids),
      meta: { ...src.meta, title: `${src.meta.title || src.name} (${label})` },
      exportSettings: { ...src.exportSettings, range: 'all' as const },
      fadeIn: { seconds: fadeInSec, curve: 'sCurve' as const },
      fadeOut: { seconds: fadeOutSec, curve: 'sCurve' as const },
    });
    await putProject(p);
    return p;
  }

  async insertFiles(files: File[], where: 'playhead' | 'end', progress: ProgressFn): Promise<void> {
    const { sources, layers, grids } = await decodeIntoProject(files, this.project, progress);
    for (const [id, l] of layers) this.layers.set(id, l);
    const at = where === 'end' ? this.length : this.currentPosition();
    this.commit((d) => {
      d.sources.push(...sources);
      Object.assign(d.grids, grids);
      d.clips = insertClips(
        d.clips,
        at,
        sources.map((s) => ({ id: uid(), sourceId: s.id, start: 0, end: s.frames, xfade: 0 })),
        this.xfadeFrames(),
        uid,
      );
    });
    toast(files.length > 1 ? `Added ${files.length} files` : `Added ${files[0].name}`);
  }

  async addStems(files: File[], sourceId: Id, progress: ProgressFn): Promise<void> {
    const { added, layers } = await decodeStems(files, this.project, progress);
    for (const [id, l] of layers) this.layers.set(id, l);
    const src = this.sourceById(sourceId);
    const mismatch = src && added.some((l) => Math.abs(l.frames - src.frames) > 0.05 * this.sr);
    const muteMix = src?.layers.length === 1 && added.length > 1;
    this.commit((d) => {
      const s = d.sources.find((x) => x.id === sourceId)!;
      if (muteMix) s.layers[0].mute = true;
      s.layers.push(...added);
      s.frames = Math.max(s.frames, ...added.map((l) => l.frames));
    });
    if (mismatch) toast('Heads up: a stem has a different length than the song, so it may not line up.', 'error', 6000);
    else if (muteMix) toast('Muted the original full mix so it does not double the stems. Unmute it any time.', 'info', 5000);
  }

  setLayer(sourceId: Id, layerId: Id, patch: Partial<Layer>, merge?: string): void {
    this.commit((d) => {
      const l = d.sources.find((s) => s.id === sourceId)?.layers.find((x) => x.id === layerId);
      if (l) Object.assign(l, patch);
    }, merge);
  }

  removeLayer(sourceId: Id, layerId: Id): void {
    const src = this.sourceById(sourceId);
    if (!src || src.layers.length < 2) return void toast('A song needs at least one layer.');
    this.commit((d) => {
      const s = d.sources.find((x) => x.id === sourceId)!;
      s.layers = s.layers.filter((l) => l.id !== layerId);
      s.frames = Math.max(...s.layers.map((l) => l.frames));
    });
  }

  // ------------------------------------------------------------ loudness
  analysisKey(): string {
    const p = this.project;
    return JSON.stringify([p.clips, p.sources, p.eq, p.width, p.speed, p.gainDb, p.fadeIn, p.fadeOut, exportRange(p, this.selection), p.exportSettings.sampleRate, p.exportSettings.format]);
  }

  get analysisStale(): boolean {
    return this.analysis.key !== this.analysisKey();
  }

  async analyze(): Promise<void> {
    if (this.analysis.running) return;
    this.analysis = { ...this.analysis, running: true, progress: 0 };
    this.emit();
    try {
      const key = this.analysisKey();
      const result = await analyzeProject(
        { project: this.project, audio: this.audio, selection: this.selection, yieldFn: yieldToUi },
        (f) => {
          this.analysis.progress = f;
          this.emit();
        },
      );
      this.analysis = { result, key, running: false, progress: 1 };
      this.syncPlayer();
    } catch (e) {
      this.analysis = { ...this.analysis, running: false };
      toast(`Analysis failed: ${errorText(e)}`, 'error');
    }
    this.emit();
  }

  // ------------------------------------------------------------ export
  async runExport(): Promise<void> {
    if (this.exportState && !['done', 'error'].includes(this.exportState.stage)) return;
    this.player.pause();
    this.exportAbort = new AbortController();
    this.exportState = { stage: 'render', progress: 0 };
    this.emit();
    try {
      const cover = await loadCover(this.project.meta.coverFileId);
      const result = await withWakeLock(() =>
        exportProject({
          project: this.project,
          audio: this.audio,
          selection: this.selection,
          cover: cover ? { mime: cover.mime, data: cover.data } : null,
          mp3: createMp3Sink,
          signal: this.exportAbort!.signal,
          yieldFn: yieldToUi,
          onStage: (stage, progress) => {
            this.exportState = { stage, progress };
            this.emit();
          },
        }),
      );
      if (cover) URL.revokeObjectURL(cover.url);
      this.exportState = { stage: 'done', progress: 1, result };
    } catch (e) {
      this.exportState = { stage: 'error', progress: 0, error: errorText(e) };
    }
    this.exportAbort = null;
    this.emit();
  }

  cancelExport(): void {
    this.exportAbort?.abort();
  }

  dismissExport(): void {
    this.exportState = null;
    this.emit();
  }

  dispose(): void {
    this.player.stop();
    void this.flush();
  }
}
