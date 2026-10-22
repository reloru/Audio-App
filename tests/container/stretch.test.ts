/**
 * Integration tests for cloud tempo/pitch. They build container/ with Docker and run it twice:
 * directly, and behind the Worker and Durable Objects under `wrangler dev` with containers on.
 * Pitch is measured from ffmpeg-decoded output by counting zero crossings, so the check does not
 * depend on any DSP code in this repository.
 *
 * Without Docker these tests are skipped, unless REQUIRE_DOCKER=1 (CI), in which case they fail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../../src/cloud/params';
import { encodeWav } from '../../src/io/wav';
import { ffmpegDecode, ffprobe, musicLike, sine, tmp } from '../helpers';

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!dockerOk && process.env.REQUIRE_DOCKER === '1') throw new Error('Docker is required for these tests (REQUIRE_DOCKER=1).');

const FS = 48000;
const ROOT = process.cwd();
const dir = tmp();
const sinePath = join(dir, 'sine440.wav');
const sineWav = new Uint8Array(encodeWav(FS, sine(FS, 10, 440, -6), 'pcm16'));
writeFileSync(sinePath, sineWav);
const notWav = new Uint8Array(4096).fill(7);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Frequency of a steady tone from upward zero crossings (linearly interpolated) between t0 and t1 seconds. */
function zeroCrossingHz(ch: Float32Array, fs: number, t0: number, t1: number): number {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = Math.round(t0 * fs) + 1; i < Math.round(t1 * fs); i++) {
    if (ch[i - 1] < 0 && ch[i] >= 0) {
      const t = i - 1 + -ch[i - 1] / (ch[i] - ch[i - 1]);
      if (first < 0) first = t;
      last = t;
      n++;
    }
  }
  return ((n - 1) * fs) / (last - first);
}

function analyse(wav: ArrayBuffer) {
  const path = join(tmp(), 'out.wav');
  writeFileSync(path, new Uint8Array(wav));
  const probe = ffprobe(path) as { streams: { codec_name: string; channels: number; sample_rate: string }[]; format: { duration: string } };
  return { probe, seconds: Number(probe.format.duration), channels: ffmpegDecode(path) };
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await sleep(500);
  }
}

/** Polls a status URL until done; returns every progress value seen. */
async function pollDone(url: string): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < 1200; i++) {
    const s = (await (await fetch(url, { cache: 'no-store' })).json()) as { state: string; progress: number; error?: string };
    seen.push(s.progress);
    if (s.state === 'done') return seen;
    if (s.state !== 'running') throw new Error(`job ${s.state}: ${s.error ?? ''}`);
    await sleep(200);
  }
  throw new Error('job did not finish');
}

describe.skipIf(!dockerOk)('container server (docker run)', () => {
  let id = '';
  let base = '';

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-t', 'bounce-stretch:test', 'container'], { cwd: ROOT, stdio: 'inherit' });
    id = execFileSync('docker', ['run', '-d', '--rm', '--cpus=1', '--memory=1g', '-p', '127.0.0.1::8080', 'bounce-stretch:test'], { encoding: 'utf8' }).trim();
    const port = execFileSync('docker', ['port', id, '8080/tcp'], { encoding: 'utf8' }).trim().split('\n')[0].split(':').pop();
    base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/health`, 30_000);
  });

  afterAll(() => {
    if (id) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  });

  it('rejects bad requests', async () => {
    const post = (q: string, body?: Uint8Array<ArrayBuffer>) => fetch(`${base}/jobs?${q}`, { method: 'POST', body });
    expect((await post('tempo=1.1')).status).toBe(411);
    expect((await post('tempo=3', sineWav)).status).toBe(400);
    expect((await post('tempo=1&pitch=0', sineWav)).status).toBe(400);
    expect((await post('pitch=13', sineWav)).status).toBe(400);
    expect((await post('tempo=1.1', notWav)).status).toBe(415);
    expect((await fetch(`${base}/jobs/result`)).status).toBe(409);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('shifts pitch by +2 semitones without changing the length, and keeps the result until DELETE', async () => {
    const res = await fetch(`${base}/jobs?tempo=1&pitch=2&formant=1`, { method: 'POST', body: sineWav });
    expect(res.status).toBe(202);
    await pollDone(`${base}/jobs`);
    const out = await (await fetch(`${base}/jobs/result`)).arrayBuffer();
    const again = await (await fetch(`${base}/jobs/result`)).arrayBuffer();
    expect(again.byteLength).toBe(out.byteLength);
    const { probe, seconds, channels } = analyse(out);
    expect(probe.streams[0].codec_name).toBe('pcm_s16le');
    expect(probe.streams[0].channels).toBe(2);
    expect(probe.streams[0].sample_rate).toBe('48000');
    expect(Math.abs(seconds - 10)).toBeLessThan(0.01);
    expect(Math.abs(zeroCrossingHz(channels[0], FS, 1, 9) - 440 * Math.pow(2, 2 / 12))).toBeLessThan(0.5);
    expect((await fetch(`${base}/jobs`, { method: 'DELETE' })).status).toBe(204);
    expect(((await (await fetch(`${base}/jobs`)).json()) as { state: string }).state).toBe('idle');
  });

  it('changes tempo by ×1.25 without changing pitch', async () => {
    expect((await fetch(`${base}/jobs?tempo=1.25`, { method: 'POST', body: sineWav })).status).toBe(202);
    await pollDone(`${base}/jobs`);
    const { seconds, channels } = analyse(await (await fetch(`${base}/jobs/result`)).arrayBuffer());
    expect(Math.abs(seconds - 8)).toBeLessThan(0.01);
    expect(Math.abs(zeroCrossingHz(channels[0], FS, 1, 7) - 440)).toBeLessThan(0.5);
  });

  it('reports progress of the processing pass only, never going backwards', async () => {
    const long = new Uint8Array(encodeWav(FS, musicLike(FS, 90, 120, 5, 0.4), 'pcm16'));
    expect((await fetch(`${base}/jobs?tempo=0.8&pitch=1`, { method: 'POST', body: long })).status).toBe(202);
    const seen = await pollDone(`${base}/jobs`);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen.some((p) => p > 0.05 && p < 0.95)).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });
});

describe.skipIf(!dockerOk)('/api through the Worker and Durable Objects (wrangler dev)', () => {
  const PORT = 8798;
  const api = `http://127.0.0.1:${PORT}/api/jobs`;
  let dev: ChildProcess | null = null;
  let log = '';
  const devContainers = () =>
    execFileSync('docker', ['ps', '--filter', 'name=workerd-bounce-Stretcher', '--format', '{{.Image}}'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('stretcher')).length;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'dist', 'index.html'))) execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    // A daily limit of 2 lets the last test reach both the daily limit and the per-IP rate limit.
    dev = spawn(
      'npx',
      ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', join(tmp(), 'state'), '--var', 'DAILY_JOB_LIMIT:2'],
      { cwd: ROOT, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    dev.stdout!.on('data', (d) => (log += d));
    dev.stderr!.on('data', (d) => (log += d));
    try {
      await waitFor(`http://127.0.0.1:${PORT}/`, 600_000);
    } catch (e) {
      console.error(log.slice(-4000));
      throw e;
    }
  });

  afterAll(() => {
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  });

  it('answers bad requests in the Worker without starting a container', async () => {
    const before = devContainers();
    const r405 = await fetch(api);
    expect(r405.status).toBe(405);
    expect(r405.headers.get('allow')).toBe('POST');
    expect((await fetch(`${api}/not-a-job`)).status).toBe(404);
    expect((await fetch(`${api}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${api}/${crypto.randomUUID()}/result`)).status).toBe(404);
    expect((await fetch(`${api}/${crypto.randomUUID()}`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${api}?tempo=9`, { method: 'POST', body: sineWav })).status).toBe(400);
    expect((await fetch(`${api}?tempo=1.1`, { method: 'POST' })).status).toBe(411);
    const tooBig = await fetch(`${api}?tempo=1.1`, { method: 'POST', body: new Uint8Array(MAX_UPLOAD_BYTES + 1) });
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toMatch(/too long for cloud processing/);
    expect((await fetch(`http://127.0.0.1:${PORT}/api/other`)).status).toBe(404);
    expect(devContainers()).toBe(before);
  });

  it('runs a job end to end and removes the container on DELETE', async () => {
    const before = devContainers();
    const res = await fetch(`${api}?tempo=1&pitch=-3&formant=0`, { method: 'POST', body: sineWav, headers: { 'Content-Type': 'audio/wav' } });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await pollDone(`${api}/${id}`);
    const { seconds, channels } = analyse(await (await fetch(`${api}/${id}/result`)).arrayBuffer());
    expect(Math.abs(seconds - 10)).toBeLessThan(0.01);
    expect(Math.abs(zeroCrossingHz(channels[0], FS, 1, 9) - 440 * Math.pow(2, -3 / 12))).toBeLessThan(0.5);
    expect((await fetch(`${api}/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${api}/${id}`)).status).toBe(404);
    for (let i = 0; i < 50 && devContainers() > before; i++) await sleep(200);
    expect(devContainers()).toBe(before);
  });

  it('passes container errors through, then enforces the daily limit and the per-IP rate limit', async () => {
    const post = () => fetch(`${api}?tempo=1.1`, { method: 'POST', body: notWav });
    // Job 2 of 2 today: the container rejects the body.
    expect((await post()).status).toBe(415);
    const limited = await post();
    expect(limited.status).toBe(503);
    expect(((await limited.json()) as { error: string }).error).toMatch(/today’s limit/);
    // The per-IP limit is 4 per minute in windows aligned to the wall clock (Miniflare emulates this),
    // so if a minute boundary falls in this test up to 4 more requests pass before the 429.
    const statuses: number[] = [];
    while (statuses.length < 10 && statuses.at(-1) !== 429) statuses.push((await post()).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 503)).toBe(true);
  });
});
