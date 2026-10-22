import { defineConfig, devices } from '@playwright/test';

// E2E_HOST=cloudflare serves the build with `wrangler dev` (Workers static assets + public/_headers)
// instead of `vite preview`, so host behaviour is tested too.
const cloudflare = process.env.E2E_HOST === 'cloudflare';
const baseURL = cloudflare ? 'http://127.0.0.1:4173/' : 'http://localhost:4173/';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
    // Without this, about 1 in 20 runs in Claude cloud sessions froze the page on opening the editor:
    // the main thread blocked in native code (CDP Debugger.pause could not interrupt it). 60 repeats
    // with the GPU disabled passed.
    launchOptions: { args: ['--disable-gpu'] },
  },
  webServer: {
    command: cloudflare
      ? 'npx vite build && npx wrangler dev --port 4173 --ip 127.0.0.1 --enable-containers=false'
      : 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: baseURL,
    env: { WRANGLER_SEND_METRICS: 'false' },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
