/** Browser client for the cloud tempo/pitch API (same origin, /api/jobs). */
import { toQuery, type StretchParams } from './params';

export interface JobStatus {
  state: 'receiving' | 'running' | 'done' | 'error' | 'idle';
  progress: number;
  error?: string;
}

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const API = './api/jobs';

async function errorFrom(res: Response | XMLHttpRequest): Promise<CloudError> {
  const status = res.status;
  let text = '';
  try {
    text = res instanceof Response ? await res.text() : res.responseText;
  } catch {
    /* ignore */
  }
  let msg = '';
  try {
    msg = (JSON.parse(text) as { error?: string }).error ?? '';
  } catch {
    msg = text.slice(0, 200);
  }
  if (status === 429) msg ||= 'Too many requests right now. Try again in a minute.';
  if (status === 503) msg ||= 'Cloud processing is busy or has reached today’s limit. Try again later.';
  if (status === 413) msg ||= 'The song is too long for cloud processing.';
  return new CloudError(msg || `Request failed (${status})`, status);
}

/** Uploads the WAV and starts a job. Reports upload progress (0..1). */
export function submitJob(wav: Blob, params: StretchParams, onProgress: (f: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}?${toQuery(params)}`);
    xhr.setRequestHeader('Content-Type', 'audio/wav');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = async () => {
      if (xhr.status === 202 || xhr.status === 200) {
        try {
          resolve((JSON.parse(xhr.responseText) as { id: string }).id);
        } catch {
          reject(new CloudError('Unexpected response from the server'));
        }
      } else reject(await errorFrom(xhr));
    };
    xhr.onerror = () => reject(new CloudError('Network error. Check your connection.'));
    xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(wav);
  });
}

export async function jobStatus(id: string, signal?: AbortSignal): Promise<JobStatus> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, { cache: 'no-store', signal });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as JobStatus;
}

/** Polls until the job is done; reports processing progress (0..1). */
export async function waitForJob(id: string, onProgress: (f: number) => void, signal?: AbortSignal, intervalMs = 1500): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const s = await jobStatus(id, signal);
    if (s.state === 'done') return;
    if (s.state === 'error') throw new CloudError(s.error || 'Processing failed');
    if (s.state === 'idle') throw new CloudError('The job was lost on the server. Please try again.');
    onProgress(s.progress);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Downloads the processed WAV with progress (0..1). */
export async function downloadResult(id: string, onProgress: (f: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(`${API}/${encodeURIComponent(id)}/result`, { cache: 'no-store', signal });
  if (!res.ok || !res.body) throw await errorFrom(res);
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** Deletes the job and its audio on the server. Best effort. */
export async function deleteJob(id: string): Promise<void> {
  try {
    await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    /* the instance also discards its disk when it sleeps */
  }
}
