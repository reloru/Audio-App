/**
 * ID3v2 tags (id3.org informal standards v2.2 / v2.3.0 / v2.4.0).
 * Reading supports v2.2-v2.4 including unsynchronisation and extended
 * headers. Writing produces v2.3 (widest player support).
 */

export interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: string;
  genre?: string;
  track?: string;
  bpm?: string;
  key?: string;
  comment?: string;
  lyrics?: string;
  cover?: { mime: string; data: Uint8Array };
}

const TEXT_IDS: Record<string, keyof TrackMeta> = {
  TIT2: 'title',
  TT2: 'title',
  TPE1: 'artist',
  TP1: 'artist',
  TALB: 'album',
  TAL: 'album',
  TPE2: 'albumArtist',
  TP2: 'albumArtist',
  TYER: 'year',
  TYE: 'year',
  TDRC: 'year',
  TCON: 'genre',
  TCO: 'genre',
  TRCK: 'track',
  TRK: 'track',
  TBPM: 'bpm',
  TBP: 'bpm',
  TKEY: 'key',
  TKE: 'key',
};

function syncsafe(b: Uint8Array, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function removeUnsync(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && i + 1 < b.length && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

/** Length in bytes of an ID3v2 tag at the start of the buffer (0 if none). */
export function id3v2Length(b: Uint8Array): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
  const footer = (b[5] & 0x10) !== 0;
  return 10 + syncsafe(b, 6) + (footer ? 10 : 0);
}

function decodeString(enc: number, bytes: Uint8Array): string {
  let s: string;
  if (enc === 0) s = new TextDecoder('latin1').decode(bytes);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(bytes);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(bytes);
  else {
    // UTF-16 with BOM
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) s = new TextDecoder('utf-16be').decode(bytes.subarray(2));
    else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) s = new TextDecoder('utf-16le').decode(bytes.subarray(2));
    else s = new TextDecoder('utf-16le').decode(bytes);
  }
  return s;
}

/** Splits at the first terminator for the encoding; returns [field, rest]. */
function splitTerminated(enc: number, b: Uint8Array): [Uint8Array, Uint8Array] {
  if (enc === 1 || enc === 2) {
    for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [b.subarray(0, i), b.subarray(i + 2)];
    return [b, new Uint8Array(0)];
  }
  const i = b.indexOf(0);
  return i < 0 ? [b, new Uint8Array(0)] : [b.subarray(0, i), b.subarray(i + 1)];
}

function cleanText(s: string): string {
  // v2.4 separates multiple values with NUL; trailing NULs are padding.
  return s
    .split('\u0000')
    .filter((p) => p.length > 0)
    .join(' / ')
    .trim();
}

export function readId3(buf: Uint8Array): TrackMeta {
  const meta: TrackMeta = {};
  const total = id3v2Length(buf);
  if (!total) return meta;
  const ver = buf[3];
  if (ver < 2 || ver > 4) return meta;
  const flags = buf[5];
  let body = buf.subarray(10, Math.min(buf.length, 10 + syncsafe(buf, 6)));
  if (ver < 4 && flags & 0x80) body = removeUnsync(body);
  let p = 0;
  if (flags & 0x40 && ver >= 3) {
    // extended header
    p = ver === 3 ? 4 + u32(body, 0) : syncsafe(body, 0);
  }
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  while (p + hdrLen <= body.length) {
    if (body[p] === 0) break; // padding
    const id = String.fromCharCode(...body.subarray(p, p + idLen));
    let size: number;
    let fflags = 0;
    if (ver === 2) size = (body[p + 3] << 16) | (body[p + 4] << 8) | body[p + 5];
    else if (ver === 3) size = u32(body, p + 4);
    else size = syncsafe(body, p + 4);
    if (ver >= 3) fflags = (body[p + 8] << 8) | body[p + 9];
    const start = p + hdrLen;
    const end = start + size;
    if (size <= 0 || end > body.length) break;
    let data = body.subarray(start, end);
    p = end;
    // Skip compressed/encrypted frames (v2.3: 0x0080/0x0040, v2.4: 0x0008/0x0004).
    if (ver === 3 && fflags & 0x00c0) continue;
    if (ver === 4) {
      if (fflags & 0x000c) continue;
      if (fflags & 0x0001) data = data.subarray(4); // data length indicator
      if (fflags & 0x0002) data = removeUnsync(data);
    }
    try {
      const key = TEXT_IDS[id];
      if (key && data.length > 1) {
        const v = cleanText(decodeString(data[0], data.subarray(1)));
        if (v) (meta as Record<string, unknown>)[key] = key === 'year' ? v.slice(0, 4) : v;
      } else if ((id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') && data.length > 4) {
        const enc = data[0];
        const [, text] = splitTerminated(enc, data.subarray(4));
        const v = cleanText(decodeString(enc, text));
        if (v) {
          if (id === 'COMM' || id === 'COM') meta.comment ??= v;
          else meta.lyrics ??= v;
        }
      } else if ((id === 'TXXX' || id === 'TXX') && data.length > 2) {
        // User-defined text; some taggers (e.g. ffmpeg) store comments here.
        const enc = data[0];
        const [desc, text] = splitTerminated(enc, data.subarray(1));
        const d = cleanText(decodeString(enc, desc)).toLowerCase();
        const v = cleanText(decodeString(enc, text));
        if (v && (d === 'comment' || d === 'description')) meta.comment ??= v;
      } else if ((id === 'APIC' || id === 'PIC') && data.length > 4 && !meta.cover) {
        const enc = data[0];
        let rest: Uint8Array;
        let mime: string;
        if (id === 'APIC') {
          const z = data.indexOf(0, 1);
          if (z < 0) continue;
          mime = new TextDecoder('latin1').decode(data.subarray(1, z)) || 'image/jpeg';
          rest = data.subarray(z + 1);
        } else {
          const fmt = new TextDecoder('latin1').decode(data.subarray(1, 4)).toUpperCase();
          mime = fmt === 'PNG' ? 'image/png' : 'image/jpeg';
          rest = data.subarray(4);
        }
        // rest: picture type (1), description (terminated), image data
        const [, img] = splitTerminated(enc, rest.subarray(1));
        if (img.length) {
          if (!mime.includes('/')) mime = `image/${mime.toLowerCase() === 'jpg' ? 'jpeg' : mime.toLowerCase()}`;
          meta.cover = { mime, data: img.slice() };
        }
      }
    } catch {
      // Ignore malformed frames; keep whatever else is readable.
    }
  }
  return meta;
}

// ---------------------------------------------------------------- writing

function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0xff) return false;
  return true;
}

function encodeText(s: string): { enc: number; bytes: Uint8Array; term: Uint8Array } {
  if (isLatin1(s)) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return { enc: 0, bytes: b, term: new Uint8Array([0]) };
  }
  const b = new Uint8Array(2 + s.length * 2);
  b[0] = 0xff;
  b[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[2 + i * 2] = c & 0xff;
    b[3 + i * 2] = c >> 8;
  }
  return { enc: 1, bytes: b, term: new Uint8Array([0, 0]) };
}

function frame(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  const n = body.length;
  out[4] = (n >>> 24) & 0xff;
  out[5] = (n >>> 16) & 0xff;
  out[6] = (n >>> 8) & 0xff;
  out[7] = n & 0xff;
  out.set(body, 10);
  return out;
}

function cat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function textFrame(id: string, value: string): Uint8Array {
  const t = encodeText(value);
  return frame(id, cat([new Uint8Array([t.enc]), t.bytes]));
}

function langFrame(id: 'COMM' | 'USLT', value: string): Uint8Array {
  const t = encodeText(value);
  // encoding, language, empty description + terminator, text
  const empty = t.enc === 1 ? new Uint8Array([0xff, 0xfe]) : new Uint8Array(0);
  return frame(id, cat([new Uint8Array([t.enc]), new TextEncoder().encode('eng'), empty, t.term, t.bytes]));
}

/** Builds an ID3v2.3 tag. Returns an empty array when there is nothing to write. */
export function writeId3v23(meta: TrackMeta, software = 'Bounce'): Uint8Array {
  const frames: Uint8Array[] = [];
  const add = (id: string, v?: string) => {
    if (v && v.trim()) frames.push(textFrame(id, v.trim()));
  };
  add('TIT2', meta.title);
  add('TPE1', meta.artist);
  add('TALB', meta.album);
  add('TPE2', meta.albumArtist);
  add('TYER', meta.year);
  add('TCON', meta.genre);
  add('TRCK', meta.track);
  add('TBPM', meta.bpm);
  add('TKEY', meta.key);
  add('TSSE', software);
  if (meta.comment?.trim()) frames.push(langFrame('COMM', meta.comment.trim()));
  if (meta.lyrics?.trim()) frames.push(langFrame('USLT', meta.lyrics.trim()));
  if (meta.cover && meta.cover.data.length) {
    const mime = new TextEncoder().encode(meta.cover.mime);
    // encoding 0, MIME, NUL, picture type 3 (front cover), empty description NUL, data
    frames.push(frame('APIC', cat([new Uint8Array([0]), mime, new Uint8Array([0, 3, 0]), meta.cover.data])));
  }
  if (!frames.length) return new Uint8Array(0);
  const body = cat(frames);
  const hdr = new Uint8Array(10);
  hdr.set([0x49, 0x44, 0x33, 3, 0, 0]);
  const n = body.length;
  hdr[6] = (n >> 21) & 0x7f;
  hdr[7] = (n >> 14) & 0x7f;
  hdr[8] = (n >> 7) & 0x7f;
  hdr[9] = n & 0x7f;
  return cat([hdr, body]);
}
