/** File import, decoding and project creation/opening. */
import { decodeAudioFile, bufferChannels } from '../io/decode';
import type { TrackMeta } from '../io/id3';
import { buildPeaks, type PeakPyramid } from '../dsp/analysis';
import { analyzeBeatsInWorker } from '../engine/browser';
import type { Pcm } from '../engine/render';
import { getFile, getProject, putFile, putProject, requestPersistence } from '../storage/db';
import { newLayer, newProject, newSource, titleFromFileName, uid } from '../model/project';
import { appendSource } from '../model/timeline';
import type { BeatGrid, Id, Layer, Project, Source } from '../model/types';

export interface LoadedLayer {
  buffer: AudioBuffer;
  pcm: Pcm;
  peaks: PeakPyramid;
}

export type ImportMode = 'stems' | 'join' | 'separate';

export type ProgressFn = (text: string, fraction: number) => void;

/** Decoded audio per file id at a given rate, kept for the session. */
const cache = new Map<string, AudioBuffer>();
const cacheKey = (fileId: Id, rate: number) => `${fileId}@${rate}`;

function trimCache(keep: Set<string>): void {
  for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
}

export function loadedFromBuffer(buffer: AudioBuffer): LoadedLayer {
  const channels = bufferChannels(buffer);
  return { buffer, pcm: { sampleRate: buffer.sampleRate, channels }, peaks: buildPeaks(channels) };
}

async function storeOriginal(file: File): Promise<Id> {
  const id = uid();
  await putFile({ id, name: file.name, type: file.type || guessType(file.name), size: file.size, blob: file, createdAt: Date.now() });
  return id;
}

function guessType(name: string): string {
  if (/\.wav$/i.test(name)) return 'audio/wav';
  if (/\.mp3$/i.test(name)) return 'audio/mpeg';
  return 'application/octet-stream';
}

async function decodeFileId(fileId: Id, targetRate?: number): Promise<{ buffer: AudioBuffer; meta: TrackMeta }> {
  if (targetRate) {
    const hit = cache.get(cacheKey(fileId, targetRate));
    if (hit) return { buffer: hit, meta: {} };
  }
  const f = await getFile(fileId);
  if (!f) throw new Error('A file of this project is missing from storage.');
  const d = await decodeAudioFile(await f.blob.arrayBuffer(), targetRate);
  cache.set(cacheKey(fileId, d.buffer.sampleRate), d.buffer);
  return { buffer: d.buffer, meta: d.meta };
}

/** Removes the longest common prefix/suffix so stems read "Vocals", "Drums". */
export function stemNames(names: string[]): string[] {
  const base = names.map((n) => n.replace(/\.[a-z0-9]{2,4}$/i, ''));
  if (base.length < 2) return base;
  let pre = 0;
  while (base.every((b) => b.length > pre && b[pre] === base[0][pre])) pre++;
  let suf = 0;
  while (base.every((b) => b.length > pre + suf && b[b.length - 1 - suf] === base[0][base[0].length - 1 - suf])) suf++;
  return base.map((b, i) => {
    const core = b
      .slice(pre, b.length - suf)
      .replace(/^[\s\-_–—([{]+|[\s\-_–—)\]}]+$/g, '')
      .trim();
    return core || base[i];
  });
}

/** Guesses whether files are stems of one song (equal length within 50 ms). */
export function looksLikeStems(lengthsSec: number[]): boolean {
  if (lengthsSec.length < 2) return false;
  const min = Math.min(...lengthsSec);
  const max = Math.max(...lengthsSec);
  return max - min < 0.05;
}

async function beatGridFor(source: Source, layers: Map<Id, LoadedLayer>): Promise<BeatGrid | null> {
  const n = source.frames;
  if (!n) return null;
  const mono = new Float32Array(n);
  let rate = 48000;
  let count = 0;
  for (const l of source.layers) {
    const ll = layers.get(l.id);
    if (!ll) continue;
    rate = ll.pcm.sampleRate;
    count++;
    const chs = ll.pcm.channels;
    const g = 1 / chs.length;
    for (const ch of chs) for (let i = 0; i < ch.length && i < n; i++) mono[i] += ch[i] * g;
  }
  if (!count) return null;
  try {
    const r = await analyzeBeatsInWorker(mono, rate);
    if (!r.beats.length) return null;
    return { beats: r.beats, bpm: r.bpm, barOffset: r.barOffset, beatsPerBar: 4 };
  } catch {
    return null;
  }
}

async function storeCover(meta: TrackMeta): Promise<Id | undefined> {
  if (!meta.cover) return undefined;
  const id = uid();
  const blob = new Blob([meta.cover.data as BlobPart], { type: meta.cover.mime });
  await putFile({ id, name: 'cover', type: meta.cover.mime, size: blob.size, blob, createdAt: Date.now() });
  return id;
}

function applyMeta(p: Project, meta: TrackMeta, fallbackTitle: string): void {
  p.meta.title = meta.title || fallbackTitle;
  p.meta.artist = meta.artist ?? '';
  p.meta.album = meta.album ?? '';
  p.meta.year = meta.year ?? '';
  p.meta.genre = meta.genre ?? '';
  p.meta.track = meta.track ?? '';
  p.meta.comment = meta.comment ?? '';
  p.meta.lyrics = meta.lyrics ?? '';
  p.name = p.meta.title;
}

export interface CreatedProject {
  project: Project;
  layers: Map<Id, LoadedLayer>;
}

/** Imports files as one project (stems or joined) or as separate projects. */
export async function importFiles(files: File[], mode: ImportMode, progress: ProgressFn): Promise<CreatedProject[]> {
  void requestPersistence();
  if (mode === 'separate' && files.length > 1) {
    const out: CreatedProject[] = [];
    for (let i = 0; i < files.length; i++) {
      const sub: ProgressFn = (t, f) => progress(`${t} (${i + 1}/${files.length})`, (i + f) / files.length);
      out.push(...(await importFiles([files[i]], 'stems', sub)));
    }
    return out;
  }
  const decoded: { fileId: Id; file: File; buffer: AudioBuffer; meta: TrackMeta }[] = [];
  let rate: number | undefined;
  for (let i = 0; i < files.length; i++) {
    progress(`Reading ${files[i].name}`, (i / files.length) * 0.7);
    const fileId = await storeOriginal(files[i]);
    const { buffer, meta } = await decodeFileId(fileId, rate);
    rate ??= buffer.sampleRate;
    decoded.push({ fileId, file: files[i], buffer, meta });
  }
  const sampleRate = rate!;
  const layers = new Map<Id, LoadedLayer>();
  const names = mode === 'stems' ? stemNames(files.map((f) => f.name)) : files.map((f) => titleFromFileName(f.name));
  const mkLayer = (d: (typeof decoded)[number], name: string): Layer => {
    const l = newLayer(d.fileId, name, d.buffer.length, d.buffer.numberOfChannels);
    layers.set(l.id, loadedFromBuffer(d.buffer));
    return l;
  };
  let sources: Source[];
  if (mode === 'stems') {
    sources = [newSource(files.length > 1 ? stemTitle(files) : titleFromFileName(files[0].name), decoded.map((d, i) => mkLayer(d, names[i])))];
  } else {
    sources = decoded.map((d, i) => newSource(names[i], [mkLayer(d, names[i])]));
  }
  const firstMeta = decoded[0].meta;
  const title = files.length > 1 && mode === 'stems' ? stemTitle(files) : titleFromFileName(files[0].name);
  const project = newProject(title, sampleRate, sources);
  if (mode === 'join') {
    project.clips = [];
    for (const s of sources) project.clips = appendSource(project.clips, s, 0, uid);
  }
  applyMeta(project, firstMeta, title);
  project.meta.coverFileId = await storeCover(firstMeta);
  for (let i = 0; i < sources.length; i++) {
    progress('Finding the beat', 0.7 + (0.25 * i) / sources.length);
    const g = await beatGridFor(sources[i], layers);
    if (g) project.grids[sources[i].id] = g;
  }
  progress('Saving', 0.98);
  await putProject(project);
  return [{ project, layers }];
}

function stemTitle(files: File[]): string {
  const base = files.map((f) => f.name.replace(/\.[a-z0-9]{2,4}$/i, ''));
  let pre = 0;
  while (base.every((b) => b.length > pre && b[pre] === base[0][pre])) pre++;
  const t = base[0].slice(0, pre).replace(/[\s\-_–—([{]+$/g, '').trim();
  return t || titleFromFileName(files[0].name);
}

/** Decodes files as new sources for an existing project (the caller places them). */
export async function decodeIntoProject(
  files: File[],
  project: Project,
  progress: ProgressFn,
): Promise<{ sources: Source[]; layers: Map<Id, LoadedLayer>; grids: Record<Id, BeatGrid> }> {
  const { added, layers } = await decodeLayers(files, project, progress, files.map((f) => titleFromFileName(f.name)));
  const sources = added.map((l) => newSource(l.name, [l]));
  const grids: Record<Id, BeatGrid> = {};
  for (const s of sources) {
    progress('Finding the beat', 0.9);
    const g = await beatGridFor(s, layers);
    if (g) grids[s.id] = g;
  }
  return { sources, layers, grids };
}

async function decodeLayers(
  files: File[],
  project: Project,
  progress: ProgressFn,
  names: string[],
): Promise<{ added: Layer[]; layers: Map<Id, LoadedLayer> }> {
  const layers = new Map<Id, LoadedLayer>();
  const added: Layer[] = [];
  for (let i = 0; i < files.length; i++) {
    progress(`Reading ${files[i].name}`, i / files.length);
    const fileId = await storeOriginal(files[i]);
    const { buffer } = await decodeFileId(fileId, project.sampleRate);
    const l = newLayer(fileId, names[i], buffer.length, buffer.numberOfChannels);
    layers.set(l.id, loadedFromBuffer(buffer));
    added.push(l);
  }
  return { added, layers };
}

/** Decodes stems to add to an existing source. */
export function decodeStems(
  files: File[],
  project: Project,
  progress: ProgressFn,
): Promise<{ added: Layer[]; layers: Map<Id, LoadedLayer> }> {
  return decodeLayers(files, project, progress, stemNames(files.map((f) => f.name)));
}

/** Loads a saved project and decodes its audio. */
export async function openProject(id: Id, progress: ProgressFn): Promise<CreatedProject> {
  const project = await getProject(id);
  if (!project) throw new Error('Project not found');
  const layers = new Map<Id, LoadedLayer>();
  const all = project.sources.flatMap((s) => s.layers);
  const keep = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    progress(`Loading ${all[i].name}`, i / all.length);
    const { buffer } = await decodeFileId(all[i].fileId, project.sampleRate);
    keep.add(cacheKey(all[i].fileId, project.sampleRate));
    layers.set(all[i].id, loadedFromBuffer(buffer));
  }
  trimCache(keep);
  return { project, layers };
}

export async function loadCover(fileId?: Id): Promise<{ mime: string; data: Uint8Array; url: string } | null> {
  if (!fileId) return null;
  const f = await getFile(fileId);
  if (!f) return null;
  const data = new Uint8Array(await f.blob.arrayBuffer());
  return { mime: f.type, data, url: URL.createObjectURL(f.blob) };
}

export async function storeImage(file: File): Promise<Id> {
  const id = uid();
  await putFile({ id, name: file.name, type: file.type || 'image/jpeg', size: file.size, blob: file, createdAt: Date.now() });
  return id;
}
