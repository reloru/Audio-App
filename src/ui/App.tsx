import { useEffect, useState } from 'preact/hooks';
import { Library } from './Library';
import { Editor } from './Editor';
import { EditorStore } from './editorStore';
import { importFiles, openProject, type CreatedProject } from './importer';
import { BusyOverlay, runBusy } from './busy';
import { toast, useToasts, errorText } from './toast';

type Route = { name: 'library' } | { name: 'editor'; store: EditorStore };

export function App() {
  const [route, setRoute] = useState<Route>({ name: 'library' });
  const toasts = useToasts();

  const openStore = (c: CreatedProject, replace = false) => {
    const store = new EditorStore(c.project, c.layers);
    setRoute({ name: 'editor', store });
    if (replace) history.replaceState({ editor: c.project.id }, '');
    else history.pushState({ editor: c.project.id }, '');
  };

  const open = async (id: string) => {
    try {
      const c = await runBusy('Opening', (prog) => openProject(id, prog));
      openStore(c);
    } catch (e) {
      toast(errorText(e), 'error', 6000);
    }
  };

  const back = () => {
    if (route.name === 'editor') {
      route.store.dispose();
      setRoute({ name: 'library' });
    }
  };

  // Android back button / browser back leaves the editor.
  useEffect(() => {
    const onPop = () => back();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  // Save before the page is hidden (mobile browsers may kill it afterwards).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && route.name === 'editor') {
        route.store.player.pause();
        void route.store.flush();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [route]);

  // Files shared to the installed app (Web Share Target, Android).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('shared')) return;
    history.replaceState(null, '', location.pathname);
    void (async () => {
      try {
        const cache = await caches.open('bounce-share');
        const keys = await cache.keys();
        const files: File[] = [];
        for (const k of keys) {
          const r = await cache.match(k);
          if (!r) continue;
          const name = decodeURIComponent(new URL(k.url).searchParams.get('name') ?? 'shared-audio');
          files.push(new File([await r.blob()], name, { type: r.headers.get('content-type') ?? '' }));
          await cache.delete(k);
        }
        if (!files.length) return;
        const created = await runBusy('Importing', (prog) => importFiles(files, files.length > 1 ? 'join' : 'stems', prog));
        if (created[0]) openStore(created[0]);
      } catch (e) {
        toast(errorText(e), 'error');
      }
    })();
  }, []);

  return (
    <>
      {route.name === 'library' ? (
        <Library onOpen={(id) => void open(id)} onCreated={openStore} />
      ) : (
        <Editor
          store={route.store}
          onBack={() => {
            if (history.state?.editor) history.back();
            else back();
          }}
          onOpen={(c) => {
            route.store.dispose();
            openStore(c, true);
          }}
        />
      )}
      <BusyOverlay />
      <div class="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div class={`toast ${t.kind === 'error' ? 'error' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
