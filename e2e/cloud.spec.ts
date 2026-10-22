import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, makeFixtures } from './fixtures';

// The cloud API is mocked here: /api is answered by page.route, with ffmpeg's atempo filter standing
// in for Rubber Band. The real server is covered by tests/container. Service workers are blocked so
// every request reaches page.route.
test.use({ serviceWorkers: 'block' });

const JOB = '0b5d3c1e-8a7f-4c2d-9e6b-1f2a3b4c5d6e';

function peakDb(path: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'astats=measure_perchannel=none:measure_overall=Peak_level', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  return Number(/Peak level dB:\s*(-?[\d.]+)/.exec(r.stderr)?.[1]);
}

async function totalSeconds(page: Page): Promise<number> {
  const t = await page.locator('.transport .time .faint').innerText();
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(t)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function openWav(page: Page, path: string) {
  await page.goto('./');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open MP3 or WAV', exact: true }).click();
  await (await chooser).setFiles([path]);
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain', { timeout: 60_000 });
}

test('cloud tempo: consent, upload with headroom, and the result opens as a new project', async ({ page }) => {
  const fx = makeFixtures();
  const inPath = join(FIXTURES, 'cloud-in.wav');
  const outPath = join(FIXTURES, 'cloud-out.wav');
  const posts: URL[] = [];
  let polls = 0;
  let deletes = 0;
  await page.route('**/api/jobs**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.endsWith('/api/jobs')) {
      posts.push(url);
      writeFileSync(inPath, req.postDataBuffer()!);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inPath, '-af', `atempo=${url.searchParams.get('tempo')}`, '-c:a', 'pcm_s16le', outPath]);
      return route.fulfill({ status: 202, json: { id: JOB, state: 'running', seconds: 1 } });
    }
    if (req.method() === 'GET' && url.pathname.endsWith(`/api/jobs/${JOB}`)) {
      polls++;
      return route.fulfill({ json: polls < 2 ? { state: 'running', progress: 0.4 } : { state: 'done', progress: 1 } });
    }
    if (req.method() === 'GET' && url.pathname.endsWith(`/api/jobs/${JOB}/result`)) {
      return route.fulfill({ body: readFileSync(outPath), headers: { 'content-type': 'audio/wav' } });
    }
    if (req.method() === 'DELETE' && url.pathname.endsWith(`/api/jobs/${JOB}`)) {
      deletes++;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not found' } });
  });

  await openWav(page, fx.wav);
  const total0 = await totalSeconds(page);

  // +12 dB on the only layer pushes the mix past full scale, so the upload must be attenuated.
  await page.getByRole('button', { name: 'Mix', exact: true }).click();
  await page.getByRole('slider', { name: 'Level' }).fill('12');
  const expectedComp = peakDb(fx.wav) + 12 + 6.0206;
  expect(expectedComp).toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await page.getByRole('slider', { name: 'Tempo' }).fill('1.25');
  await expect(page.getByText(/^Length 0:/)).toBeVisible();
  await page.getByRole('heading', { name: 'Tempo & pitch (cloud)' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(process.cwd(), 'test-results', 'screens', '11-cloud-card.png') });
  await page.getByRole('button', { name: 'Process in the cloud…', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Upload this song for processing?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/Tags, cover art and the rest of the project stay on this device/)).toBeVisible();
  await page.screenshot({ path: join(process.cwd(), 'test-results', 'screens', '12-cloud-consent.png') });
  await sheet.getByRole('button', { name: 'Upload and process', exact: true }).click();

  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain (125% tempo)', { timeout: 60_000 });
  await expect(page.getByText(/Opened the new version/)).toBeVisible();

  // What was uploaded: the arrangement as 16-bit stereo at the project rate, peaking at −6 dBFS.
  expect(posts).toHaveLength(1);
  expect(Object.fromEntries(posts[0].searchParams)).toEqual({ tempo: '1.25', pitch: '0', formant: '1' });
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', inPath], { encoding: 'utf8' }));
  expect(probe.streams[0].codec_name).toBe('pcm_s16le');
  expect(probe.streams[0].channels).toBe(2);
  expect(probe.streams[0].sample_rate).toBe('48000');
  expect(Math.abs(Number(probe.format.duration) - total0)).toBeLessThan(0.05);
  expect(Math.abs(peakDb(inPath) + 6.0206)).toBeLessThan(0.05);
  expect(deletes).toBe(1);

  // The new project: shorter by the tempo factor, with the attenuation undone on its layer.
  expect(Math.abs((await totalSeconds(page)) - total0 / 1.25)).toBeLessThan(0.1);
  await page.getByRole('button', { name: 'Mix', exact: true }).click();
  const level = await page.locator('.slider', { has: page.getByRole('slider', { name: 'Level' }) }).locator('.slider-value').innerText();
  expect(Math.abs(Number(level.replace('−', '-').replace(/[^\d.-]/g, '')) - expectedComp)).toBeLessThanOrEqual(0.06);

  // The original is untouched and both projects are in the library.
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await expect(page.locator('.project .name')).toHaveCount(2);
  expect((await page.locator('.project .name').allInnerTexts()).sort()).toEqual(['Neon Rain', 'Neon Rain (125% tempo)']);
  await page.screenshot({ path: join(process.cwd(), 'test-results', 'screens', '13-cloud-library.png') });
});

test('cloud errors are shown in the card, and the consent can be remembered', async ({ page }) => {
  const fx = makeFixtures();
  let posts = 0;
  await page.route('**/api/jobs**', (route) => {
    posts++;
    return route.fulfill({ status: 503, json: { error: 'Cloud processing has reached today’s limit. Try again tomorrow.' } });
  });
  await openWav(page, fx.wav);
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await page.getByRole('slider', { name: 'Pitch' }).fill('-2');
  await page.getByRole('button', { name: 'Process in the cloud…', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Upload this song for processing?' });
  await sheet.getByRole('switch', { name: /Don’t ask again on this device/ }).check();
  await sheet.getByRole('button', { name: 'Upload and process', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'today’s limit' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'OK', exact: true }).click();

  await page.getByRole('button', { name: 'Process in the cloud…', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'today’s limit' })).toBeVisible({ timeout: 30_000 });
  await expect(sheet).toHaveCount(0);
  expect(posts).toBe(2);
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain');
});

test('Cloudflare: /api is answered by the Worker, other paths by the asset server', async ({ request }) => {
  test.skip(process.env.E2E_HOST !== 'cloudflare', 'only meaningful when served by wrangler');
  const list = await request.get('./api/jobs');
  expect(list.status()).toBe(405);
  expect(list.headers()['allow']).toBe('POST');
  const unknown = await request.get(`./api/jobs/${JOB}`);
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['cache-control']).toBe('no-store');
  expect((await unknown.json()).error).toMatch(/no longer exists/);
  expect((await request.post('./api/jobs?tempo=1&pitch=0', { data: Buffer.alloc(100) })).status()).toBe(400);
  // The e2e server runs with containers disabled, so a valid job is refused after the checks.
  const post = await request.post('./api/jobs?tempo=1.1', { data: Buffer.alloc(100), headers: { 'Content-Type': 'audio/wav' } });
  expect(post.status()).toBe(503);
  expect((await post.json()).error).toMatch(/not available/);
  const missing = await request.get('./assets/does-not-exist-123.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type'] ?? '').not.toContain('application/json');
});
