/**
 * Export: optional loudness normalisation (measure, then render with gain and
 * the true-peak limiter), encoding to MP3 or WAV, and metadata.
 */
import { writeId3v23, type TrackMeta } from '../io/id3';
import { WavEncoder, type WavInfoTags } from '../io/wav';
import { MP3_RATES, type Mp3Bitrate } from '../io/mp3encoder';
import type { LoudnessResult } from '../dsp/loudness';
import type { Project, Selection } from '../model/types';
import { render, type LayerAudio, type FrameRange } from './render';

export interface Mp3Sink {
  encode(channels: Float32Array[], frames: number): void | Promise<void>;
  /** Returns all encoded MP3 frames. */
  finish(): Promise<Uint8Array[]>;
}

export type Mp3SinkFactory = (sampleRate: number, channels: 2, bitrate: Mp3Bitrate) => Promise<Mp3Sink>;

export type ExportStage = 'analyze' | 'adjust' | 'render';

export interface ExportRequest {
  project: Project;
  audio: LayerAudio;
  selection?: Selection | null;
  cover?: { mime: string; data: Uint8Array } | null;
  mp3?: Mp3SinkFactory;
  onStage?: (stage: ExportStage, fraction: number) => void;
  signal?: AbortSignal;
  yieldFn?: () => Promise<void>;
}

export interface ExportStats {
  durationSec: number;
  sampleRate: number;
  integratedLufs: number;
  truePeakDb: number;
  lra: number;
  shortTermMax: number;
  /** Gain added for loudness normalisation (dB). */
  normalizeGainDb: number;
  /** Deepest limiter gain reduction (dB, <= 0). */
  limiterReductionDb: number;
  /** Fraction of samples where the limiter reduced gain. */
  limiterActiveFraction: number;
  /** Loudness before normalisation (dB), when normalising. */
  sourceLufs?: number;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  mime: string;
  stats: ExportStats;
}

export function chooseOutputRate(project: Project): number {
  const s = project.exportSettings;
  const want = s.sampleRate === 'source' ? project.sampleRate : s.sampleRate;
  if (s.format === 'mp3' && !(MP3_RATES as readonly number[]).includes(want)) return want % 11025 === 0 ? 44100 : 48000;
  return want;
}

export function exportRange(project: Project, selection?: Selection | null): FrameRange | undefined {
  if (project.exportSettings.range === 'selection' && selection && selection.end > selection.start) {
    return { start: selection.start, end: selection.end };
  }
  return undefined;
}

export function safeFileName(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return s || 'export';
}

/** Tempo of the first clip's source after the speed change, rounded. */
function exportBpm(project: Project): string | undefined {
  const first = project.clips[0];
  const g = first && project.grids[first.sourceId];
  return g && g.bpm > 0 ? String(Math.round(g.bpm * project.speed)) : undefined;
}

export function trackMeta(project: Project, cover?: { mime: string; data: Uint8Array } | null): TrackMeta {
  const m = project.meta;
  return {
    title: m.title || project.name,
    artist: m.artist || undefined,
    album: m.album || undefined,
    year: m.year || undefined,
    genre: m.genre || undefined,
    track: m.track || undefined,
    comment: m.comment || undefined,
    lyrics: m.lyrics || undefined,
    bpm: exportBpm(project),
    cover: cover ?? undefined,
  };
}

function wavInfo(meta: TrackMeta): WavInfoTags {
  return {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    date: meta.year,
    genre: meta.genre,
    track: meta.track,
    comment: meta.comment,
    software: 'Bounce',
  };
}

/** Loudness of the processed audio before any normalisation gain or limiting. */
export async function analyzeProject(req: ExportRequest, onProgress?: (f: number) => void): Promise<LoudnessResult> {
  const r = await render({
    project: req.project,
    audio: req.audio,
    range: exportRange(req.project, req.selection),
    outputRate: chooseOutputRate(req.project),
    meter: true,
    onProgress,
    signal: req.signal,
    yieldFn: req.yieldFn,
  });
  return r.loudness!;
}

export async function exportProject(req: ExportRequest): Promise<ExportResult> {
  const { project } = req;
  const settings = project.exportSettings;
  const master = project.master;
  const outputRate = chooseOutputRate(project);
  const range = exportRange(project, req.selection);
  const limiter = master.limiter ? { ceilingDb: master.ceilingDb } : null;

  let gain = 0;
  let sourceLufs: number | undefined;
  if (master.normalize) {
    const a = await render({
      project,
      audio: req.audio,
      range,
      outputRate,
      meter: true,
      onProgress: (f) => req.onStage?.('analyze', f),
      signal: req.signal,
      yieldFn: req.yieldFn,
    });
    const L0 = a.loudness!.integrated;
    sourceLufs = L0;
    if (Number.isFinite(L0)) {
      gain = master.targetLufs - L0;
      const tp = a.loudness!.truePeakDb;
      // Only when the limiter will engage does the result fall short of the
      // target; then correct iteratively (bounded) using measured results.
      if (limiter && tp + gain > limiter.ceilingDb) {
        const maxGain = gain + 6;
        for (let iter = 0; iter < 3; iter++) {
          const b = await render({
            project,
            audio: req.audio,
            range,
            outputRate,
            extraGainDb: gain,
            limiter,
            meter: true,
            onProgress: (f) => req.onStage?.('adjust', (iter + f) / 3),
            signal: req.signal,
            yieldFn: req.yieldFn,
          });
          const diff = master.targetLufs - b.loudness!.integrated;
          if (Math.abs(diff) < 0.1) break;
          gain = Math.min(maxGain, gain + diff);
        }
      }
    }
  }

  const meta = trackMeta(project, req.cover);
  const parts: BlobPart[] = [];
  let mime: string;
  let ext: string;
  let wav: WavEncoder | null = null;
  let mp3: Mp3Sink | null = null;
  if (settings.format === 'wav') {
    wav = new WavEncoder(outputRate, 2, settings.wavFormat, settings.wavFormat !== 'float32');
    mime = 'audio/wav';
    ext = 'wav';
  } else {
    if (!req.mp3) throw new Error('MP3 encoder unavailable');
    mp3 = await req.mp3(outputRate, 2, settings.mp3Bitrate);
    mime = 'audio/mpeg';
    ext = 'mp3';
  }

  const final = await render({
    project,
    audio: req.audio,
    range,
    outputRate,
    extraGainDb: gain,
    limiter,
    meter: true,
    onBlock: async (ch, n) => {
      if (wav) parts.push(wav.encode(ch, n) as BlobPart);
      else await mp3!.encode(ch, n);
    },
    onProgress: (f) => req.onStage?.('render', f),
    signal: req.signal,
    yieldFn: req.yieldFn,
  });

  let blob: Blob;
  if (wav) {
    const id3 = writeId3v23(meta);
    blob = new Blob([wav.header({ info: wavInfo(meta), id3 }) as BlobPart, ...parts, wav.trailer() as BlobPart], { type: mime });
  } else {
    const frames = await mp3!.finish();
    blob = new Blob([writeId3v23(meta) as BlobPart, ...(frames as BlobPart[])], { type: mime });
  }

  const L = final.loudness!;
  const suffix = range ? ' (excerpt)' : '';
  return {
    blob,
    mime,
    fileName: `${safeFileName(meta.title ?? project.name)}${suffix}.${ext}`,
    stats: {
      durationSec: final.frames / outputRate,
      sampleRate: outputRate,
      integratedLufs: L.integrated,
      truePeakDb: L.truePeakDb,
      lra: L.lra,
      shortTermMax: L.shortTermMax,
      normalizeGainDb: gain,
      limiterReductionDb: 20 * Math.log10(final.limiterMinGain),
      limiterActiveFraction: final.limiterReducedFraction,
      sourceLufs,
    },
  };
}
