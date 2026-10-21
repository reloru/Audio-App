import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** Emits sw.js with a precache list of every built and public file. */
export function serviceWorker(): Plugin {
  let publicDir = 'public';
  return {
    name: 'bounce-service-worker',
    apply: 'build',
    configResolved(c) {
      publicDir = c.publicDir;
    },
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      // Host config files (_headers, .assetsignore) are read by the host, not served.
      const pub = listFiles(publicDir)
        .map((f) => relative(publicDir, f).split('\\').join('/'))
        .filter((f) => !f.split('/').some((part) => part.startsWith('.') || part.startsWith('_')));
      const files = ['./', ...[...built, ...pub].filter((f) => f !== 'sw.js').sort().map((f) => `./${f}`)];
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}
