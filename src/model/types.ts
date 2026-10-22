import type { FadeCurve } from '../dsp/fades';
import type { WavSampleFormat } from '../io/wav';
import type { Mp3Bitrate } from '../io/mp3encoder';

export type Id = string;

/** One audio file inside a source (a full mix, or one stem of a stem set). */
export interface Layer {
  id: Id;
  fileId: Id;
  name: string;
  /** Length in frames at the project sample rate. */
  frames: number;
  channels: number;
  gainDb: number;
  /** -1 (left) .. +1 (right); linear stereo balance. */
  balance: number;
  mute: boolean;
  solo: boolean;
}

/** A song: one or more sample-aligned layers that are edited together. */
export interface Source {
  id: Id;
  name: string;
  layers: Layer[];
  /** Longest layer, frames at project rate. */
  frames: number;
}

/** A region of a source placed on the timeline. Clips play back to back. */
export interface Clip {
  id: Id;
  sourceId: Id;
  /** Source frame range [start, end) at project rate. */
  start: number;
  end: number;
  /** Requested crossfade length (frames) with the previous clip. */
  xfade: number;
}

export interface FadeSpec {
  seconds: number;
  curve: FadeCurve;
}

export interface EqSettings {
  /** High-pass cut-off in Hz, 0 = off. */
  hpf: number;
  lowShelf: { freq: number; gain: number };
  mid: { freq: number; gain: number; q: number };
  highShelf: { freq: number; gain: number };
  /** Low-pass cut-off in Hz, 0 = off. */
  lpf: number;
}

export interface MasterSettings {
  presetId: string;
  normalize: boolean;
  targetLufs: number;
  limiter: boolean;
  ceilingDb: number;
}

export interface ExportSettings {
  format: 'mp3' | 'wav';
  mp3Bitrate: Mp3Bitrate;
  wavFormat: WavSampleFormat;
  sampleRate: 'source' | 44100 | 48000;
  range: 'all' | 'selection';
}

export interface BeatGrid {
  /** Beat times in seconds of source time. */
  beats: number[];
  bpm: number;
  /** Beat index (0..beatsPerBar-1) that starts a bar. */
  barOffset: number;
  beatsPerBar: number;
}

export interface ProjectMeta {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  track: string;
  comment: string;
  lyrics: string;
  /** File id of the cover image, if any. */
  coverFileId?: Id;
}

export interface Project {
  id: Id;
  version: 1;
  name: string;
  createdAt: number;
  updatedAt: number;
  sampleRate: number;
  sources: Source[];
  clips: Clip[];
  fadeIn: FadeSpec;
  fadeOut: FadeSpec;
  eq: EqSettings;
  /** Stereo width: 0 = mono, 1 = unchanged, 2 = wide. */
  width: number;
  /** Varispeed ratio (tempo and pitch together). */
  speed: number;
  gainDb: number;
  master: MasterSettings;
  grids: Record<Id, BeatGrid>;
  meta: ProjectMeta;
  exportSettings: ExportSettings;
}

export interface Selection {
  /** Timeline frames [start, end). */
  start: number;
  end: number;
}
