import type { EqSettings, MasterSettings, ExportSettings, FadeSpec } from './types';

export interface LoudnessPreset {
  id: string;
  label: string;
  normalize: boolean;
  targetLufs: number;
  ceilingDb: number;
  /** Where the numbers come from (shown in the UI). */
  source: string;
}

export const LOUDNESS_PRESETS: LoudnessPreset[] = [
  {
    id: 'original',
    label: 'Keep original level',
    normalize: false,
    targetLufs: -14,
    ceilingDb: -1,
    source: 'No loudness change. The peak limiter (if on) only catches peaks above the ceiling.',
  },
  {
    id: 'spotify',
    label: 'Spotify (−14 LUFS)',
    normalize: true,
    targetLufs: -14,
    ceilingDb: -1,
    source:
      'Spotify for Artists, “Loudness normalization”: target −14 LUFS integrated, true peak below −1 dBTP (−2 dBTP for masters louder than −14 LUFS).',
  },
  {
    id: 'aes',
    label: 'AES streaming (−16 LUFS)',
    normalize: true,
    targetLufs: -16,
    ceilingDb: -1,
    source:
      'AES TD1008 recommends music be normalised to no more than −16 LUFS (as reported by AES; the −1 dBTP ceiling here is this app’s default, not taken from TD1008).',
  },
  {
    id: 'ebu',
    label: 'Broadcast EBU R 128 (−23 LUFS)',
    normalize: true,
    targetLufs: -23,
    ceilingDb: -1,
    source: 'EBU R 128-2023: programme loudness −23.0 LUFS, maximum true peak −1 dBTP.',
  },
  {
    id: 'custom',
    label: 'Custom',
    normalize: true,
    targetLufs: -14,
    ceilingDb: -1,
    source: 'Your own target and ceiling.',
  },
];

export interface EqPreset {
  id: string;
  label: string;
  eq: EqSettings;
}

export const FLAT_EQ: EqSettings = {
  hpf: 0,
  lowShelf: { freq: 120, gain: 0 },
  mid: { freq: 1000, gain: 0, q: 1 },
  highShelf: { freq: 8000, gain: 0 },
  lpf: 0,
};

const eq = (patch: Partial<{ hpf: number; lpf: number; ls: [number, number]; mid: [number, number, number]; hs: [number, number] }>): EqSettings => ({
  hpf: patch.hpf ?? 0,
  lowShelf: patch.ls ? { freq: patch.ls[0], gain: patch.ls[1] } : { ...FLAT_EQ.lowShelf },
  mid: patch.mid ? { freq: patch.mid[0], gain: patch.mid[1], q: patch.mid[2] } : { ...FLAT_EQ.mid },
  highShelf: patch.hs ? { freq: patch.hs[0], gain: patch.hs[1] } : { ...FLAT_EQ.highShelf },
  lpf: patch.lpf ?? 0,
});

/** Starting points only; every value is shown and editable. */
export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', label: 'Flat', eq: FLAT_EQ },
  { id: 'tame-highs', label: 'Tame harsh highs', eq: eq({ hs: [7000, -3] }) },
  { id: 'rumble', label: 'Remove rumble', eq: eq({ hpf: 30 }) },
  { id: 'less-mud', label: 'Less mud', eq: eq({ hpf: 25, mid: [300, -3, 1] }) },
  { id: 'presence', label: 'Vocal presence', eq: eq({ mid: [3000, 2, 1] }) },
  { id: 'brighter', label: 'Brighter', eq: eq({ hs: [10000, 2] }) },
  { id: 'warmer', label: 'Warmer', eq: eq({ ls: [150, 2], hs: [9000, -1.5] }) },
  { id: 'lofi', label: 'Lo-fi radio', eq: eq({ hpf: 300, lpf: 4000, mid: [1500, 3, 0.7] }) },
];

export const DEFAULT_MASTER: MasterSettings = {
  presetId: 'original',
  normalize: false,
  targetLufs: -14,
  limiter: true,
  ceilingDb: -1,
};

export const DEFAULT_EXPORT: ExportSettings = {
  format: 'mp3',
  mp3Bitrate: 320,
  wavFormat: 'pcm16',
  sampleRate: 'source',
  range: 'all',
};

export const NO_FADE: FadeSpec = { seconds: 0, curve: 'sCurve' };

/** Default crossfade at edit seams. */
export const DEFAULT_XFADE_MS = 15;

export const SPEED_PRESETS = [0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.25];

export const CLIP_LENGTHS = [15, 30, 60];
