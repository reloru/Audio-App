/** Cloud tempo/pitch job parameters, shared by the app and the Worker. */

export const TEMPO_MIN = 0.5;
export const TEMPO_MAX = 2;
export const PITCH_MIN = -12;
export const PITCH_MAX = 12;
/** Longest audio accepted (s). 500 s of 48 kHz 16-bit stereo is 96 MB, under the 100 MB request limit. */
export const MAX_SECONDS = 500;
export const MAX_UPLOAD_BYTES = 100_000_000;

export interface StretchParams {
  /** Tempo multiplier; 1.1 = 10 % faster, same pitch. */
  tempo: number;
  /** Pitch shift in semitones, same tempo. */
  pitch: number;
  /** Preserve formants (vocal character) when shifting pitch. */
  formant: boolean;
}

export function validateParams(p: StretchParams): string | null {
  if (!Number.isFinite(p.tempo) || p.tempo < TEMPO_MIN || p.tempo > TEMPO_MAX) return `Tempo must be between ${TEMPO_MIN * 100}% and ${TEMPO_MAX * 100}%.`;
  if (!Number.isFinite(p.pitch) || p.pitch < PITCH_MIN || p.pitch > PITCH_MAX) return `Pitch must be between ${PITCH_MIN} and +${PITCH_MAX} semitones.`;
  if (Math.abs(p.tempo - 1) < 1e-6 && Math.abs(p.pitch) < 1e-6) return 'Change the tempo or the pitch first.';
  return null;
}

export function toQuery(p: StretchParams): string {
  const q = new URLSearchParams({ tempo: String(p.tempo), pitch: String(p.pitch), formant: p.formant ? '1' : '0' });
  return q.toString();
}

export function fromQuery(search: URLSearchParams): StretchParams {
  return {
    tempo: Number(search.get('tempo') ?? '1'),
    pitch: Number(search.get('pitch') ?? '0'),
    formant: search.get('formant') === '1' || search.get('formant') === 'true',
  };
}

/** Short label for file and project names, e.g. "105% tempo, −2 st". */
export function describeParams(p: StretchParams): string {
  const parts: string[] = [];
  if (Math.abs(p.tempo - 1) >= 1e-6) parts.push(`${Math.round(p.tempo * 1000) / 10}% tempo`);
  if (Math.abs(p.pitch) >= 1e-6) parts.push(`${p.pitch > 0 ? '+' : '−'}${Math.abs(p.pitch)} st`);
  return parts.join(', ');
}
