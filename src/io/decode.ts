/**
 * Browser-side decoding. WAV is parsed directly (exact, any bit depth); other
 * formats go through decodeAudioData on an OfflineAudioContext running at the
 * file's own sample rate, because decodeAudioData resamples to the context
 * rate (W3C Web Audio API, decodeAudioData step 5).
 */
import { parseWav, wavHeader } from './wav';
import { mp3Info } from './mp3info';
import { readId3, type TrackMeta } from './id3';
import { Resampler, zeroPaddedReader } from '../dsp/resample';

export interface DecodedAudio {
  buffer: AudioBuffer;
  /** Sample rate of the file before any conversion. */
  nativeRate: number;
  meta: TrackMeta;
  format: 'wav' | 'mp3' | 'other';
}

export class DecodeError extends Error {}

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const buf = new AudioBuffer({ numberOfChannels: channels.length, length: Math.max(1, channels[0].length), sampleRate });
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return buf;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Band-limited conversion to `rate`, in slices so the UI stays responsive. */
export async function resampleChannels(channels: Float32Array[], from: number, to: number): Promise<Float32Array[]> {
  const rs = new Resampler(from / to);
  const read = zeroPaddedReader(channels);
  const n = rs.outputLength(channels[0].length);
  const out = channels.map(() => new Float32Array(n));
  const BLOCK = 65536;
  for (let s = 0; s < n; s += BLOCK) {
    const blk = rs.process(read, channels.length, s, Math.min(BLOCK, n - s));
    blk.forEach((b, i) => out[i].set(b, s));
    await yieldToUi();
  }
  return out;
}

export async function decodeAudioFile(data: ArrayBuffer, targetRate?: number): Promise<DecodedAudio> {
  const bytes = new Uint8Array(data);
  let channels: Float32Array[];
  let rate: number;
  let meta: TrackMeta = {};
  let format: DecodedAudio['format'] = 'other';
  let buffer: AudioBuffer | null = null;

  if (wavHeader(data)) {
    const w = parseWav(data);
    channels = w.channels;
    rate = w.sampleRate;
    format = 'wav';
    meta = w.id3 ? readId3(w.id3) : {};
    meta.title ||= w.info.title;
    meta.artist ||= w.info.artist;
    meta.album ||= w.info.album;
    meta.year ||= w.info.date;
    meta.genre ||= w.info.genre;
    meta.comment ||= w.info.comment;
  } else {
    const info = mp3Info(bytes);
    if (info) format = 'mp3';
    meta = readId3(bytes);
    const guess = info?.sampleRate ?? targetRate ?? 48000;
    try {
      const ctx = new OfflineAudioContext(1, 1, guess);
      buffer = await ctx.decodeAudioData(data.slice(0));
    } catch {
      throw new DecodeError('This file could not be decoded. Is it an MP3 or WAV file?');
    }
    rate = buffer.sampleRate;
    channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer!.getChannelData(i));
  }
  if (!channels.length || channels[0].length === 0) throw new DecodeError('The file contains no audio.');
  if (channels.length > 2) channels = channels.slice(0, 2);

  const nativeRate = rate;
  if (targetRate && targetRate !== rate) {
    channels = await resampleChannels(channels, rate, targetRate);
    rate = targetRate;
    buffer = null;
  }
  if (!buffer || buffer.numberOfChannels !== channels.length) {
    try {
      buffer = makeBuffer(channels, rate);
    } catch {
      // Some browsers only accept common rates for AudioBuffer: convert.
      channels = await resampleChannels(channels, rate, 48000);
      rate = 48000;
      buffer = makeBuffer(channels, rate);
    }
  }
  return { buffer, nativeRate, meta, format };
}

/** Channel views of an AudioBuffer (no copy). */
export function bufferChannels(b: AudioBuffer): Float32Array[] {
  return Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
}
