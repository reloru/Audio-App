import { test, expect, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtures, FIXTURES } from './fixtures';
import { biquadCoeffs, Biquad, type BiquadParams } from '../src/dsp/biquad';

const SHOTS = join(process.cwd(), 'test-results', 'screens');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

function probe(path: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { encoding: 'utf8' }));
}
function ebur128(path: string) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const s = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return { I: Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec(s)?.[1]), TP: Number(/Peak:\s+(-?[\d.]+)\s+dBFS/.exec(s)?.[1]) };
}

/** Total length shown in the transport, in seconds. */
async function totalSeconds(page: Page): Promise<number> {
  const t = await page.locator('.transport .time .faint').innerText();
  const m = /(\d+):(\d+(?:\.\d+)?)/.exec(t)!;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function openFiles(page: Page, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open MP3 or WAV', exact: true }).click();
  await (await chooser).setFiles(files);
}

test.describe.configure({ mode: 'serial' });

let fx: ReturnType<typeof makeFixtures>;
test.beforeAll(() => {
  fx = makeFixtures();
});

test('library loads with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Bounce' })).toBeVisible();
  await expect(page.getByText('Getting songs out of Suno')).toBeVisible();
  await shot(page, '01-library');
  expect(errors).toEqual([]);
});

test('import an MP3, edit, measure and export MP3 + WAV', async ({ page }) => {
  await page.goto('./');
  await openFiles(page, [fx.mp3]);
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain', { timeout: 60_000 });
  await expect(page.getByText(/BPM detected/)).toBeVisible();
  const bpmText = await page.getByText(/BPM detected/).innerText();
  expect(Math.abs(Number(/([\d.]+) BPM/.exec(bpmText)![1]) - 120)).toBeLessThan(1.5);
  const total0 = await totalSeconds(page);
  expect(total0).toBeGreaterThan(22.5);
  await shot(page, '02-editor');

  // play / pause
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const pos = await page.locator('.transport .time > span').first().innerText();
  expect(pos).not.toBe('0:00.0');

  // select by dragging across the middle of the waveform, then cut it out
  const wave = page.locator('.wave-wrap');
  const box = (await wave.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.section-title').first()).toContainText('beats');
  await shot(page, '03-selection');
  await page.getByRole('button', { name: 'Cut out', exact: true }).click();
  const total1 = await totalSeconds(page);
  expect(total1).toBeLessThan(total0 - 1);
  await shot(page, '04-after-cut');

  // undo / redo
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await totalSeconds(page)).toBeCloseTo(total0, 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await totalSeconds(page)).toBeCloseTo(total1, 1);

  // trim silence (0.8 s at the start, 2 s at the end in the fixture)
  await page.getByRole('button', { name: 'Trim silence', exact: true }).click();
  const total2 = await totalSeconds(page);
  expect(total1 - total2).toBeGreaterThan(2.4);
  expect(total1 - total2).toBeLessThan(3.0);

  // fade out
  await page.getByRole('slider', { name: 'Fade out' }).fill('3');

  // loudness
  await page.getByRole('button', { name: 'Loudness', exact: true }).click();
  await expect(page.getByText('Integrated loudness')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('radio', { name: 'Spotify (−14 LUFS)' }).click();
  await expect(page.getByText(/Export will apply/)).toBeVisible();
  await shot(page, '05-loudness');

  // sound tab renders
  await page.getByRole('button', { name: 'Sound', exact: true }).click();
  await page.getByRole('button', { name: 'Tame harsh highs', exact: true }).click();
  await shot(page, '06-sound');

  // export MP3 320
  await page.getByRole('button', { name: 'Export', exact: true }).last().click();
  await expect(page.getByLabel('Title')).toHaveValue('Neon Rain');
  await page.getByRole('radio', { name: '320 kbps' }).click();
  await page.getByRole('button', { name: 'Export MP3', exact: true }).click();
  await expect(page.getByText(/^Ready:/)).toBeVisible({ timeout: 90_000 });
  await shot(page, '07-export-done');
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const mp3Path = join(FIXTURES, 'out.mp3');
  await (await dl).saveAs(mp3Path);
  const pm = probe(mp3Path);
  const a = pm.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
  expect(a.codec_name).toBe('mp3');
  expect(Number(a.bit_rate)).toBe(320000);
  expect(pm.format.tags.title).toBe('Neon Rain');
  expect(pm.format.tags.artist).toBe('Test Artist');
  expect(pm.streams.some((s: { disposition?: { attached_pic?: number } }) => s.disposition?.attached_pic === 1)).toBe(true);
  expect(Math.abs(Number(pm.format.duration) - total2)).toBeLessThan(0.15);
  const lm = ebur128(mp3Path);
  expect(Math.abs(lm.I + 14)).toBeLessThan(0.5);

  // export WAV 24-bit
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('radio', { name: 'WAV' }).click();
  await page.getByRole('radio', { name: '24-bit' }).click();
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  await expect(page.getByText(/^Ready:/)).toBeVisible({ timeout: 90_000 });
  const dl2 = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download' }).click();
  const wavPath = join(FIXTURES, 'out.wav');
  await (await dl2).saveAs(wavPath);
  const pw = probe(wavPath);
  expect(pw.streams[0].codec_name).toBe('pcm_s24le');
  expect(pw.streams[0].sample_rate).toBe('48000');
  const lw = ebur128(wavPath);
  expect(Math.abs(lw.I + 14)).toBeLessThan(0.15);
  expect(lw.TP).toBeLessThanOrEqual(-0.9);
});

test('projects persist across reloads and the app works offline', async ({ page, context }) => {
  await page.goto('./');
  await openFiles(page, [fx.wav]);
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Back to library', exact: true }).click();
  await expect(page.getByRole('button', { name: /Neon Rain/ }).first()).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // A controlled reload makes the service worker serve and cache the shell.
  await page.reload();
  await expect(page.getByRole('button', { name: /Neon Rain/ }).first()).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Bounce' })).toBeVisible();
  await page.getByRole('button', { name: /Neon Rain/ }).first().click();
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).last().click();
  await page.getByRole('radio', { name: 'MP3' }).click();
  await page.getByRole('button', { name: 'Export MP3', exact: true }).click();
  await expect(page.getByText(/^Ready:/)).toBeVisible({ timeout: 90_000 });
  await shot(page, '10-offline-export');
  await context.setOffline(false);
});

test('stems import as layers of one song', async ({ page }) => {
  await page.goto('./');
  await openFiles(page, fx.stems);
  await expect(page.getByRole('radio', { name: 'Stems' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText(/Guessed because the files have the same length/)).toBeVisible();
  await shot(page, '08-import-sheet');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.locator('.topbar .title')).toHaveText('Neon Rain', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Mix', exact: true }).click();
  await expect(page.locator('.layer .nm')).toHaveText(['Vocals', 'Instrumental']);
  await page.getByRole('button', { name: 'Instrumental', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute Vocals', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await shot(page, '09-mix');
});

test('native BiquadFilterNode matches the export filters (preview = export)', async ({ page }) => {
  await page.goto('./');
  const fs = 48000;
  const n = 4096;
  const input = Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) * 0.5 + Math.sin(i * 1.3) * 0.25 + (i === 100 ? 0.9 : 0));
  const filters: BiquadParams[] = [
    { type: 'highpass', frequency: 80, Q: 20 * Math.log10(Math.SQRT1_2), gain: 0 },
    { type: 'lowpass', frequency: 6000, Q: 20 * Math.log10(Math.SQRT1_2), gain: 0 },
    { type: 'lowshelf', frequency: 150, Q: 1, gain: 4 },
    { type: 'highshelf', frequency: 8000, Q: 1, gain: -3 },
    { type: 'peaking', frequency: 3000, Q: 1.4, gain: 5 },
  ];
  for (const f of filters) {
    const browser: number[] = await page.evaluate(
      async ({ f, input, fs }) => {
        const ctx = new OfflineAudioContext(1, input.length, fs);
        const buf = ctx.createBuffer(1, input.length, fs);
        buf.copyToChannel(Float32Array.from(input), 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const bq = ctx.createBiquadFilter();
        bq.type = f.type;
        bq.frequency.value = f.frequency;
        bq.Q.value = f.Q;
        bq.gain.value = f.gain;
        src.connect(bq).connect(ctx.destination);
        src.start();
        return Array.from((await ctx.startRendering()).getChannelData(0));
      },
      { f, input, fs },
    );
    const ours = Float32Array.from(input);
    new Biquad(biquadCoeffs(f, fs)).process(ours);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(browser[i] - ours[i]));
    expect(maxDiff, `${f.type}`).toBeLessThan(1e-4);
  }
});

test('Cloudflare headers: security headers, wasm MIME, real 404s, config files hidden', async ({ request }) => {
  test.skip(process.env.E2E_HOST !== 'cloudflare', 'only meaningful when served by wrangler');
  const home = await request.get('./');
  expect(home.status()).toBe(200);
  expect(home.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(home.headers()['x-content-type-options']).toBe('nosniff');
  const html = await home.text();
  const wasm = /assets\/mp3-[\w-]+\.wasm/.exec(await (await request.get('./sw.js')).text())![0];
  const w = await request.get(`./${wasm}`);
  expect(w.headers()['content-type']).toBe('application/wasm');
  const missing = await request.get('./assets/does-not-exist-123.js');
  expect(missing.status()).toBe(404);
  expect(missing.headers()['content-type'] ?? '').not.toContain('text/html');
  for (const hidden of ['./_headers', './.assetsignore']) expect((await request.get(hidden)).status()).toBe(404);
  const js = /assets\/index-[\w-]+\.js/.exec(html)![0];
  expect((await request.get(`./${js}.map`)).status()).toBe(404);
});

