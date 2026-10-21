import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { serviceWorker } from './build/sw-plugin.ts';

export default defineConfig({
  // Relative base so the build works from any sub-path (e.g. GitHub Pages /Audio-App/).
  base: './',
  plugins: [preact(), serviceWorker()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Maps are written for local debugging but not referenced or deployed (see public/.assetsignore).
    sourcemap: 'hidden',
    assetsInlineLimit: 0,
  },
  server: { host: true },
  preview: { host: true },
});
