import { DEFAULT_EXPORT, DEFAULT_MASTER, FLAT_EQ, NO_FADE } from './presets';
import type { Clip, Id, Layer, Project, Source } from './types';

export function uid(): Id {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function newLayer(fileId: Id, name: string, frames: number, channels: number): Layer {
  return { id: uid(), fileId, name, frames, channels, gainDb: 0, balance: 0, mute: false, solo: false };
}

export function newSource(name: string, layers: Layer[]): Source {
  return { id: uid(), name, layers, frames: Math.max(0, ...layers.map((l) => l.frames)) };
}

export function wholeSourceClip(s: Source): Clip {
  return { id: uid(), sourceId: s.id, start: 0, end: s.frames, xfade: 0 };
}

export function newProject(name: string, sampleRate: number, sources: Source[], clips?: Clip[]): Project {
  const now = Date.now();
  return {
    id: uid(),
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    sampleRate,
    sources,
    clips: clips ?? sources.slice(0, 1).map(wholeSourceClip),
    fadeIn: { ...NO_FADE },
    fadeOut: { ...NO_FADE },
    eq: structuredClone(FLAT_EQ),
    width: 1,
    speed: 1,
    gainDb: 0,
    master: { ...DEFAULT_MASTER },
    grids: {},
    meta: { title: name, artist: '', album: '', year: '', genre: '', track: '', comment: '', lyrics: '' },
    exportSettings: { ...DEFAULT_EXPORT },
  };
}

/** Strips an extension and common download suffixes from a file name. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').trim() || 'Untitled';
}

/** File ids referenced by a project (audio layers and cover). */
export function referencedFiles(p: Project): Set<Id> {
  const s = new Set<Id>();
  for (const src of p.sources) for (const l of src.layers) s.add(l.fileId);
  if (p.meta.coverFileId) s.add(p.meta.coverFileId);
  return s;
}

/** Fields that undo/redo restores (everything except identity and timestamps). */
export type EditState = Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'version'>;

export function editState(p: Project): EditState {
  const { id: _id, createdAt: _c, updatedAt: _u, version: _v, ...rest } = p;
  return structuredClone(rest);
}

export class History {
  private past: EditState[] = [];
  private future: EditState[] = [];
  constructor(private readonly limit = 100) {}

  push(before: EditState): void {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: EditState): EditState | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: EditState): EditState | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}
