/** MPEG audio frame-header parsing (ISO/IEC 11172-3 / 13818-3 header layout). */
import { id3v2Length } from './id3';

const RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

export interface Mp3Info {
  sampleRate: number;
  channels: 1 | 2;
  /** Byte offset of the first frame header. */
  offset: number;
}

/**
 * Finds the first valid frame header (after any ID3v2 tag) and returns its
 * sample rate and channel mode. Two consecutive headers must agree on version
 * and rate to reject false syncs inside the data.
 */
export function mp3Info(buf: Uint8Array): Mp3Info | null {
  let i = id3v2Length(buf);
  const limit = Math.min(buf.length - 4, i + 256 * 1024);
  for (; i < limit; i++) {
    const h = parse(buf, i);
    if (!h) continue;
    const next = parse(buf, i + h.frameLen);
    if (next && next.version === h.version && next.sampleRate === h.sampleRate) {
      return { sampleRate: h.sampleRate, channels: h.channels, offset: i };
    }
  }
  return null;
}

function parse(b: Uint8Array, i: number) {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 0: 2.5, 2: 2, 3: 1
  const layer = (b[i + 1] >> 1) & 3; // 1: III
  if (version === 1 || layer !== 1) return null;
  const brIdx = (b[i + 2] >> 4) & 15;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const padding = (b[i + 2] >> 1) & 1;
  const mode = (b[i + 3] >> 6) & 3;
  const sampleRate = RATES[version][srIdx];
  const v1 = version === 3;
  const brTable = v1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = brTable[brIdx] * 1000;
  const frameLen = Math.floor(((v1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (frameLen < 24) return null;
  return { version, sampleRate, channels: (mode === 3 ? 1 : 2) as 1 | 2, frameLen };
}
