/**
 * RIFF/WAVE reading and writing. Reads integer PCM (8/16/24/32-bit), IEEE
 * float (32/64-bit), and WAVE_FORMAT_EXTENSIBLE wrappers of those; also
 * LIST/INFO text tags and embedded "id3 " chunks. Writes 16/24-bit PCM
 * (optionally TPDF-dithered) or 32-bit float with optional metadata.
 */

export interface WavInfoTags {
  title?: string; // INAM
  artist?: string; // IART
  album?: string; // IPRD
  date?: string; // ICRD
  genre?: string; // IGNR
  comment?: string; // ICMT
  track?: string; // ITRK
  software?: string; // ISFT
}

export interface ParsedWav {
  sampleRate: number;
  channels: Float32Array[];
  bitsPerSample: number;
  formatCode: number;
  info: WavInfoTags;
  id3?: Uint8Array;
}

const INFO_IDS: Record<string, keyof WavInfoTags> = {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  ICRD: 'date',
  IGNR: 'genre',
  ICMT: 'comment',
  ITRK: 'track',
  IPRT: 'track',
  ISFT: 'software',
};

export class WavFormatError extends Error {}

function fourcc(v: DataView, off: number): string {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
}

function decodeText(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const slice = bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return new TextDecoder('latin1').decode(slice);
  }
}

/** Reads only the format header (cheap) — used to detect the native rate. */
export function wavHeader(buf: ArrayBuffer): { sampleRate: number; channels: number; bitsPerSample: number } | null {
  if (buf.byteLength < 12) return null;
  const v = new DataView(buf);
  if (fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = fourcc(v, off);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ' && off + 24 <= buf.byteLength) {
      return {
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        bitsPerSample: v.getUint16(off + 22, true),
      };
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

export function parseWav(buf: ArrayBuffer): ParsedWav {
  const v = new DataView(buf);
  if (buf.byteLength < 12 || fourcc(v, 0) !== 'RIFF' || fourcc(v, 8) !== 'WAVE') {
    throw new WavFormatError('Not a RIFF/WAVE file');
  }
  let fmt: { code: number; channels: number; sampleRate: number; blockAlign: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  const info: WavInfoTags = {};
  let id3: Uint8Array | undefined;

  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = fourcc(v, off);
    let size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'data') {
      // Streaming writers sometimes leave 0 or 0xFFFFFFFF; use what is present.
      if (size === 0 || size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      dataOff = body;
      dataLen = size;
    } else if (id === 'fmt ') {
      let code = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const blockAlign = v.getUint16(body + 12, true);
      const bits = v.getUint16(body + 14, true);
      if (code === 0xfffe && size >= 40) {
        code = v.getUint16(body + 24, true); // first two bytes of SubFormat GUID
      }
      fmt = { code, channels, sampleRate, blockAlign, bits };
    } else if (id === 'LIST' && size >= 4 && fourcc(v, body) === 'INFO') {
      let p = body + 4;
      const end = Math.min(body + size, buf.byteLength);
      while (p + 8 <= end) {
        const sid = fourcc(v, p);
        const ssize = v.getUint32(p + 4, true);
        const key = INFO_IDS[sid];
        if (key && p + 8 + ssize <= end) {
          info[key] = decodeText(new Uint8Array(buf, p + 8, ssize));
        }
        p += 8 + ssize + (ssize & 1);
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && body + size <= buf.byteLength) {
      id3 = new Uint8Array(buf.slice(body, body + size));
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw new WavFormatError('Missing fmt chunk');
  if (dataOff < 0) throw new WavFormatError('Missing data chunk');
  const { code, channels: nch, sampleRate, blockAlign, bits } = fmt;
  if (nch < 1) throw new WavFormatError('No channels');
  const bytesPer = bits / 8;
  if (!Number.isInteger(bytesPer) || blockAlign < nch * bytesPer) throw new WavFormatError('Unsupported sample layout');
  const frames = Math.floor(dataLen / blockAlign);
  const out = Array.from({ length: nch }, () => new Float32Array(frames));

  if (code === 1) {
    if (bits === 16) {
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) out[c][f] = v.getInt16(base + c * 2, true) / 32768;
      }
    } else if (bits === 24) {
      const u8 = new Uint8Array(buf);
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) {
          const o = base + c * 3;
          let s = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
          if (s & 0x800000) s -= 0x1000000;
          out[c][f] = s / 8388608;
        }
      }
    } else if (bits === 32) {
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) out[c][f] = v.getInt32(base + c * 4, true) / 2147483648;
      }
    } else if (bits === 8) {
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) out[c][f] = (v.getUint8(base + c) - 128) / 128;
      }
    } else {
      throw new WavFormatError(`Unsupported PCM bit depth: ${bits}`);
    }
  } else if (code === 3) {
    if (bits === 32) {
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) out[c][f] = v.getFloat32(base + c * 4, true);
      }
    } else if (bits === 64) {
      for (let f = 0; f < frames; f++) {
        const base = dataOff + f * blockAlign;
        for (let c = 0; c < nch; c++) out[c][f] = v.getFloat64(base + c * 8, true);
      }
    } else {
      throw new WavFormatError(`Unsupported float bit depth: ${bits}`);
    }
  } else {
    throw new WavFormatError(`Unsupported WAV encoding (format code ${code})`);
  }
  return { sampleRate, channels: out, bitsPerSample: bits, formatCode: code, info, id3 };
}

export type WavSampleFormat = 'pcm16' | 'pcm24' | 'float32';

/** xorshift32 — deterministic, fast PRNG for dither. */
export class Xorshift32 {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  /** Uniform in [0, 1). */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
}

/**
 * Incremental WAV encoder: call encode() per block, then finish() to obtain
 * the header (which needs the final data size). Metadata chunks are placed
 * before the data chunk.
 */
export class WavEncoder {
  private dataBytes = 0;
  private readonly rng = new Xorshift32();
  readonly bytesPerSample: number;

  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
    readonly format: WavSampleFormat,
    /** TPDF dither of +/-1 LSB peak before integer quantisation. */
    readonly dither = true,
  ) {
    this.bytesPerSample = format === 'pcm16' ? 2 : format === 'pcm24' ? 3 : 4;
  }

  encode(channels: Float32Array[], n = channels[0].length): Uint8Array {
    const nch = this.channelCount;
    const bps = this.bytesPerSample;
    const out = new Uint8Array(n * nch * bps);
    const v = new DataView(out.buffer);
    const rng = this.rng;
    const dith = this.dither;
    if (this.format === 'float32') {
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) v.setFloat32((i * nch + c) * 4, channels[c][i], true);
    } else if (this.format === 'pcm16') {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < nch; c++) {
          let s = channels[c][i] * 32768;
          if (dith) s += rng.next() - rng.next();
          let q = Math.round(s);
          if (q > 32767) q = 32767;
          else if (q < -32768) q = -32768;
          v.setInt16((i * nch + c) * 2, q, true);
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < nch; c++) {
          let s = channels[c][i] * 8388608;
          if (dith) s += rng.next() - rng.next();
          let q = Math.round(s);
          if (q > 8388607) q = 8388607;
          else if (q < -8388608) q = -8388608;
          const o = (i * nch + c) * 3;
          out[o] = q & 0xff;
          out[o + 1] = (q >> 8) & 0xff;
          out[o + 2] = (q >> 16) & 0xff;
        }
      }
    }
    this.dataBytes += out.length;
    return out;
  }

  /** Returns the bytes that precede the encoded data. */
  header(meta?: { info?: WavInfoTags; id3?: Uint8Array }): Uint8Array {
    const chunks: Uint8Array[] = [];
    const isFloat = this.format === 'float32';
    const fmt = new Uint8Array(8 + 16);
    const fv = new DataView(fmt.buffer);
    writeFourcc(fmt, 0, 'fmt ');
    fv.setUint32(4, 16, true);
    fv.setUint16(8, isFloat ? 3 : 1, true);
    fv.setUint16(10, this.channelCount, true);
    fv.setUint32(12, this.sampleRate, true);
    const blockAlign = this.channelCount * this.bytesPerSample;
    fv.setUint32(16, this.sampleRate * blockAlign, true);
    fv.setUint16(20, blockAlign, true);
    fv.setUint16(22, this.bytesPerSample * 8, true);
    chunks.push(fmt);
    if (isFloat) {
      // Non-PCM formats should carry a fact chunk with the frame count.
      const fact = new Uint8Array(12);
      writeFourcc(fact, 0, 'fact');
      new DataView(fact.buffer).setUint32(4, 4, true);
      new DataView(fact.buffer).setUint32(8, this.dataBytes / blockAlign, true);
      chunks.push(fact);
    }
    const list = meta?.info ? infoChunk(meta.info) : null;
    if (list) chunks.push(list);
    if (meta?.id3 && meta.id3.length) chunks.push(rawChunk('id3 ', meta.id3));
    const dataHdr = new Uint8Array(8);
    writeFourcc(dataHdr, 0, 'data');
    new DataView(dataHdr.buffer).setUint32(4, this.dataBytes, true);
    chunks.push(dataHdr);

    const pre = chunks.reduce((s, c) => s + c.length, 0);
    const riff = new Uint8Array(12);
    writeFourcc(riff, 0, 'RIFF');
    const pad = this.dataBytes & 1;
    new DataView(riff.buffer).setUint32(4, 4 + pre + this.dataBytes + pad, true);
    writeFourcc(riff, 8, 'WAVE');
    return concatBytes([riff, ...chunks]);
  }

  /** Pad byte required after odd-sized data. */
  trailer(): Uint8Array {
    return new Uint8Array(this.dataBytes & 1);
  }

  get bytesWritten(): number {
    return this.dataBytes;
  }
}

function writeFourcc(b: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < 4; i++) b[off + i] = s.charCodeAt(i);
}

function rawChunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length & 1;
  const out = new Uint8Array(8 + body.length + pad);
  writeFourcc(out, 0, id);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function infoChunk(info: WavInfoTags): Uint8Array | null {
  const enc = new TextEncoder();
  const subs: Uint8Array[] = [];
  const order: [string, keyof WavInfoTags][] = [
    ['INAM', 'title'],
    ['IART', 'artist'],
    ['IPRD', 'album'],
    ['ICRD', 'date'],
    ['IGNR', 'genre'],
    ['ITRK', 'track'],
    ['ICMT', 'comment'],
    ['ISFT', 'software'],
  ];
  for (const [id, key] of order) {
    const val = info[key];
    if (!val) continue;
    const text = enc.encode(val);
    const body = new Uint8Array(text.length + 1); // ZSTR
    body.set(text);
    subs.push(rawChunk(id, body));
  }
  if (!subs.length) return null;
  const inner = concatBytes([new TextEncoder().encode('INFO'), ...subs]);
  return rawChunk('LIST', inner);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One-shot helper: encode whole buffers to a WAV byte array. */
export function encodeWav(
  sampleRate: number,
  channels: Float32Array[],
  format: WavSampleFormat = 'pcm16',
  meta?: { info?: WavInfoTags; id3?: Uint8Array },
  dither = format !== 'float32',
): Uint8Array {
  const enc = new WavEncoder(sampleRate, channels.length, format, dither);
  const data = enc.encode(channels);
  return concatBytes([enc.header(meta), data, enc.trailer()]);
}
