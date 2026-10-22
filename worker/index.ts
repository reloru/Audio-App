/**
 * Cloud tempo/pitch API. The Worker only runs for /api/* (assets.run_worker_first).
 *
 *   POST   /api/jobs?tempo&pitch&formant   body: WAV  -> 202 {id, state, seconds}
 *   GET    /api/jobs/:id                              -> {state, progress, error?}
 *   GET    /api/jobs/:id/result                       -> audio/wav
 *   DELETE /api/jobs/:id                              -> 204
 *
 * Each job is one Stretcher Durable Object with its own container instance (container/server.py).
 * The job record lives in that object's storage, so an unknown id answers 404 without starting a
 * container.
 */
import { DurableObject } from 'cloudflare:workers';
import { MAX_UPLOAD_BYTES, fromQuery, toQuery, validateParams } from '../src/cloud/params';

export interface Env {
  ASSETS: Fetcher;
  STRETCHER: DurableObjectNamespace<Stretcher>;
  QUOTA: DurableObjectNamespace<Quota>;
  JOB_RATE_LIMIT: RateLimit;
  DAILY_JOB_LIMIT: string;
}

const PORT = 8080;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** How long the container keeps running after its Durable Object stops receiving requests. */
const INACTIVITY_MS = 5 * 60_000;
/** Hard limit for a job from upload start to result download. */
const JOB_LIFETIME_MS = 30 * 60_000;
const READY_TIMEOUT_MS = 60_000;
const LENGTH_HEADER = 'x-bounce-upload-length';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

const NOT_FOUND = () => json(404, { error: 'This job no longer exists on the server. It may have expired; please start again.' });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const m = /^\/api\/jobs(?:\/([^/]+)(\/result)?)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'not found' });
    const [, id, result] = m;
    if (!id) {
      if (request.method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST' });
      return createJob(request, env, url);
    }
    if (!JOB_ID.test(id)) return NOT_FOUND();
    const allowed = result ? ['GET'] : ['GET', 'DELETE'];
    if (!allowed.includes(request.method)) return json(405, { error: 'method not allowed' }, { Allow: allowed.join(', ') });
    const path = result ? '/jobs/result' : '/jobs';
    return env.STRETCHER.getByName(id).fetch(new Request(`http://job${path}`, { method: request.method }));
  },
} satisfies ExportedHandler<Env>;

async function createJob(request: Request, env: Env, url: URL): Promise<Response> {
  const params = fromQuery(url.searchParams);
  const invalid = validateParams(params);
  if (invalid) return json(400, { error: invalid });
  const length = Number(request.headers.get('content-length'));
  if (!request.body || !Number.isSafeInteger(length) || length <= 44) return json(411, { error: 'A WAV body with Content-Length is required.' });
  if (length > MAX_UPLOAD_BYTES) return json(413, { error: 'The song is too long for cloud processing.' });
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.JOB_RATE_LIMIT.limit({ key: ip });
  if (!success) return json(429, { error: 'Too many requests right now. Try again in a minute.' });
  const allowedToday = await env.QUOTA.getByName('global').take(Number(env.DAILY_JOB_LIMIT) || 0);
  if (!allowedToday) return json(503, { error: 'Cloud processing has reached today’s limit. Try again tomorrow.' });

  const id = crypto.randomUUID();
  const job = env.STRETCHER.getByName(id);
  // The container must be up before the upload is forwarded: a refusal sent while the body is still
  // streaming leaves the runtime reading a request whose response has already gone.
  const ready = await job.prepare();
  if (ready === 'unavailable') return json(503, { error: 'Cloud processing is not available on this server.' });
  if (ready === 'busy') return json(503, { error: 'Cloud processing is busy right now. Try again in a few minutes.' });
  const res = await job.fetch(
    new Request(`http://job/jobs?${toQuery(params)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', [LENGTH_HEADER]: String(length) },
      body: request.body,
    }),
  );
  if (res.status !== 202) return res;
  return json(202, { id, ...(await res.json<Record<string, unknown>>()) });
}

interface JobRecord {
  createdAt: number;
}

export class Stretcher extends DurableObject<Env> {
  private starting: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // The timeout does not survive a Durable Object restart (for example after a deploy).
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
  }

  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    const { pathname, search } = new URL(request.url);
    const job = await this.ctx.storage.get<JobRecord>('job');

    if (!job) {
      await request.body?.cancel();
      return NOT_FOUND();
    }
    if (request.method === 'POST') return this.upload(request, search);
    if (request.method === 'DELETE') {
      await this.finish();
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }
    // Never start a container to answer a status or result request.
    if (!container?.running) {
      return pathname === '/jobs'
        ? json(200, { state: 'idle', progress: 0 })
        : json(410, { error: 'The result is no longer available on the server. Please start again.' });
    }
    try {
      return await container.getTcpPort(PORT).fetch(`http://container${pathname}`);
    } catch {
      return json(502, { error: 'The processing server did not respond. Try again in a moment.' });
    }
  }

  /** Creates the job and starts its container. Called before the upload is sent. */
  async prepare(): Promise<'ready' | 'busy' | 'unavailable'> {
    const container = this.ctx.container;
    if (!container) return 'unavailable';
    await this.ctx.storage.put('job', { createdAt: Date.now() } satisfies JobRecord);
    await this.ctx.storage.setAlarm(Date.now() + JOB_LIFETIME_MS);
    try {
      this.starting ??= this.startAndWait(container).finally(() => (this.starting = null));
      await this.starting;
      return 'ready';
    } catch (e) {
      console.error('container did not start', e);
      await this.finish();
      return 'busy';
    }
  }

  private async upload(request: Request, search: string): Promise<Response> {
    const container = this.ctx.container;
    const length = Number(request.headers.get(LENGTH_HEADER));
    if (!container?.running || !request.body || !Number.isSafeInteger(length)) {
      await request.body?.cancel();
      await this.finish();
      return json(409, { error: 'The job was not ready for the upload. Please try again.' });
    }
    // The container server needs Content-Length; a FixedLengthStream sends it and checks the byte count.
    const body = new FixedLengthStream(length);
    this.ctx.waitUntil(request.body.pipeTo(body.writable).catch(() => undefined));
    let res: Response;
    try {
      res = await container.getTcpPort(PORT).fetch(`http://container/jobs${search}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: body.readable,
      });
    } catch (e) {
      console.error('upload to container failed', e);
      await this.finish();
      return json(400, { error: 'The upload was interrupted. Please try again.' });
    }
    if (res.status === 202) return res;
    const text = await res.text();
    await this.finish();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  private async startAndWait(container: Container): Promise<void> {
    if (!container.running) container.start({ enableInternet: false });
    await container.setInactivityTimeout(INACTIVITY_MS);
    const port = container.getTcpPort(PORT);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await port.fetch('http://container/health', { signal: AbortSignal.timeout(2000) });
        await res.body?.cancel();
        if (res.ok) return;
        last = new Error(`health check returned ${res.status}`);
      } catch (e) {
        last = e;
      }
      await scheduler.wait(250);
    }
    throw new Error('container did not become ready', { cause: last });
  }

  /** Deletes the job's audio, stops the container and forgets the job. */
  private async finish(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running) {
      try {
        const res = await container.getTcpPort(PORT).fetch('http://container/jobs', { method: 'DELETE', signal: AbortSignal.timeout(3000) });
        await res.body?.cancel();
      } catch {
        /* destroy() below discards the disk anyway */
      }
      await container.destroy().catch(() => undefined);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.finish();
  }
}

/** Global count of new jobs per UTC day (a single instance, named "global"). */
export class Quota extends DurableObject<Env> {
  async take(limit: number): Promise<boolean> {
    const key = `jobs:${new Date().toISOString().slice(0, 10)}`;
    const used = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (used >= limit) return false;
    await this.ctx.storage.put(key, used + 1);
    if (used === 0) {
      const old = [...(await this.ctx.storage.list({ prefix: 'jobs:' })).keys()].filter((k) => k !== key);
      if (old.length) await this.ctx.storage.delete(old);
    }
    return true;
  }
}
