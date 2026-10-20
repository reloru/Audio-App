/** IndexedDB persistence: projects (JSON) and original files (Blobs). */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Id, Project } from '../model/types';
import { referencedFiles } from '../model/project';

export interface StoredFile {
  id: Id;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  createdAt: number;
}

interface BounceDB extends DBSchema {
  projects: { key: string; value: Project; indexes: { updatedAt: number } };
  files: { key: string; value: StoredFile };
  kv: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<BounceDB>> | null = null;

function db(): Promise<IDBPDatabase<BounceDB>> {
  dbp ??= openDB<BounceDB>('bounce', 1, {
    upgrade(d) {
      const p = d.createObjectStore('projects', { keyPath: 'id' });
      p.createIndex('updatedAt', 'updatedAt');
      d.createObjectStore('files', { keyPath: 'id' });
      d.createObjectStore('kv');
    },
  });
  return dbp;
}

export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: Id): Promise<Project | undefined> {
  return (await db()).get('projects', id);
}

export async function putProject(p: Project): Promise<void> {
  await (await db()).put('projects', p);
}

export async function putFile(f: StoredFile): Promise<void> {
  await (await db()).put('files', f);
}

export async function getFile(id: Id): Promise<StoredFile | undefined> {
  return (await db()).get('files', id);
}

/** Deletes a project and any files no other project references. */
export async function deleteProject(id: Id): Promise<void> {
  const d = await db();
  const p = await d.get('projects', id);
  await d.delete('projects', id);
  if (!p) return;
  const others = await d.getAll('projects');
  const keep = new Set<Id>();
  for (const o of others) for (const f of referencedFiles(o)) keep.add(f);
  for (const f of referencedFiles(p)) if (!keep.has(f)) await d.delete('files', f);
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

/** Asks the browser not to evict our storage (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
