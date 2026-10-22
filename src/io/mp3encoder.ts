/**
 * Thin wrapper over wasm-media-encoders' LAME build. Shared by the browser
 * worker and the Node tests (which pass the .wasm bytes directly).
 */
import { createEncoder } from 'wasm-media-encoders';

export type Mp3Bitrate = 128 | 160 | 192 | 224 | 256 | 320;
export const MP3_RATES = [32000, 44100, 48000] as const;

export interface Mp3Stream {
  encode(channels: Float32Array[]): Uint8Array;
  finish(): Uint8Array;
}

export async function openMp3Stream(
  wasm: string | ArrayBuffer | Uint8Array,
  sampleRate: number,
  channels: 1 | 2,
  bitrate: Mp3Bitrate,
): Promise<Mp3Stream> {
  if (!(MP3_RATES as readonly number[]).includes(sampleRate)) {
    throw new Error(`MP3 export needs 32, 44.1 or 48 kHz (got ${sampleRate} Hz)`);
  }
  const enc = await createEncoder('audio/mpeg', wasm);
  enc.configure({ sampleRate, channels, bitrate });
  return {
    // The encoder owns the returned view and reuses it: copy before returning.
    encode: (ch) => enc.encode(ch).slice(),
    finish: () => enc.finalize().slice(),
  };
}
