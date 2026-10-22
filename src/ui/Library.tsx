import { useEffect, useRef, useState } from 'preact/hooks';
import type { Project } from '../model/types';
import { deleteProject, listProjects, putProject, storageEstimate } from '../storage/db';
import { uid } from '../model/project';
import { timelineLength } from '../model/timeline';
import { IconLogo, IconUpload, IconMore, IconMusic } from './components/icons';
import { Sheet, Segmented } from './components/controls';
import { fmtAgo, fmtBytes, fmtTime } from './format';
import { importFiles, looksLikeStems, loadCover, type CreatedProject, type ImportMode } from './importer';
import { runBusy } from './busy';
import { toast, errorText } from './toast';

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function Library({ onOpen, onCreated }: { onOpen: (id: string) => void; onCreated: (c: CreatedProject) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pending, setPending] = useState<File[] | null>(null);
  const [menu, setMenu] = useState<Project | null>(null);
  const [drag, setDrag] = useState(false);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setProjects(await listProjects());
    setUsage(await storageEstimate());
  };
  useEffect(() => {
    void refresh();
  }, []);

  const start = async (files: File[], mode: ImportMode) => {
    setPending(null);
    try {
      const created = await runBusy('Importing', (prog) => importFiles(files, mode, prog));
      if (created.length === 1) onCreated(created[0]);
      else {
        toast(`Imported ${created.length} songs`);
        void refresh();
      }
    } catch (e) {
      toast(errorText(e), 'error', 6000);
      void refresh();
    }
  };

  const pick = (list: FileList | File[] | null) => {
    const files = [...(list ?? [])].filter((f) => /audio|octet-stream/.test(f.type) || /\.(mp3|wav|wave|m4a|aac|ogg|flac)$/i.test(f.name));
    if (!files.length) return void toast('Please choose MP3 or WAV files.');
    if (files.length === 1) void start(files, 'stems');
    else setPending(files);
  };

  return (
    <div
      class={`scroll dropzone ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        pick(e.dataTransfer?.files ?? null);
      }}
    >
      <div class="page">
        <section class="hero">
          <div class="row" style={{ gap: '12px' }}>
            <IconLogo size={40} />
            <div>
              <h1>Bounce</h1>
              <div class="small dim">Pocket editor for Suno songs</div>
            </div>
          </div>
          <p>Trim, cut, loop, fix endings, remix stems and master to streaming loudness — then export MP3 or WAV. Everything runs on this device; nothing is uploaded.</p>
          <button class="btn primary block" style={{ minHeight: '52px', fontSize: '16px' }} onClick={() => fileRef.current?.click()}>
            <IconUpload /> Open MP3 or WAV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.wav"
            multiple
            hidden
            onChange={(e) => {
              const input = e.target as HTMLInputElement;
              pick(input.files);
              input.value = '';
            }}
          />
          <div class="tiny faint">Tip: choose several files at once to load Suno stems or to join takes.</div>
        </section>

        {!isStandalone() && isIos() && (
          <div class="note">
            <b>Add to Home Screen</b> (Share → Add to Home Screen) to use Bounce like an app. Safari clears website storage after 7 days without use;
            Home Screen apps are exempt, so your projects stay put.
          </div>
        )}

        {projects && projects.length > 0 && (
          <section class="stack" aria-label="Your projects">
            <div class="section-title">Your projects</div>
            {projects.map((p) => (
              <ProjectRow p={p} onOpen={() => onOpen(p.id)} onMenu={() => setMenu(p)} />
            ))}
          </section>
        )}
        {projects && projects.length === 0 && (
          <div class="card stack">
            <h3>Getting songs out of Suno</h3>
            <ul class="small dim" style={{ margin: 0, paddingLeft: '18px' }}>
              <li>
                Open the song’s <b>⋯</b> menu → <b>Download</b>. MP3 works on every plan, in the app and on the website.
              </li>
              <li>WAV needs Pro or Premier and is only offered on suno.com (the mobile app downloads MP3).</li>
              <li>Stems: get them in Suno, download them, then open them together here (or add them under Mix).</li>
              <li>Suno counts one download per song, whatever the format, and re-downloading costs nothing. Editing here uses no downloads or credits.</li>
            </ul>
            <div class="tiny faint">Source: Suno Help Center, “What types of files can I download?” and “What counts as one download?”</div>
          </div>
        )}
        {usage && usage.usage > 0 && (
          <div class="tiny faint" style={{ textAlign: 'center' }}>
            Stored on this device: {fmtBytes(usage.usage)}
            {usage.quota ? ` of ${fmtBytes(usage.quota)} available` : ''}
          </div>
        )}
        <div class="tiny faint" style={{ textAlign: 'center' }}>
          Not affiliated with Suno. “Suno” is a trademark of its owner.
        </div>
      </div>

      {pending && <ImportSheet files={pending} onCancel={() => setPending(null)} onGo={(mode) => void start(pending, mode)} />}
      {menu && (
        <Sheet title={menu.name} onClose={() => setMenu(null)}>
          <button
            class="btn block"
            onClick={async () => {
              const copy: Project = { ...structuredClone(menu), id: uid(), name: `${menu.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() };
              await putProject(copy);
              setMenu(null);
              void refresh();
              toast('Duplicated');
            }}
          >
            Duplicate
          </button>
          <ConfirmDelete
            onDelete={async () => {
              await deleteProject(menu.id);
              setMenu(null);
              void refresh();
              toast('Deleted');
            }}
          />
          <button class="btn block ghost" onClick={() => setMenu(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}

function ConfirmDelete({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  return sure ? (
    <div class="row">
      <span class="small grow">Delete this project and its audio from this device?</span>
      <button class="btn danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  ) : (
    <button class="btn block danger" onClick={() => setSure(true)}>
      Delete…
    </button>
  );
}

function ProjectRow({ p, onOpen, onMenu }: { p: Project; onOpen: () => void; onMenu: () => void }) {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void loadCover(p.meta.coverFileId).then((c) => setCover((url = c?.url ?? null)));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [p.meta.coverFileId]);
  const secs = timelineLength(p.clips) / (p.sampleRate * p.speed);
  const stems = Math.max(...p.sources.map((s) => s.layers.length));
  return (
    <div class="project">
      <button class="open" onClick={onOpen}>
        <span class="thumb">{cover ? <img src={cover} alt="" /> : <IconMusic size={20} />}</span>
        <span class="grow" style={{ minWidth: 0 }}>
          <div class="name">{p.name}</div>
          <div class="tiny dim num">
            {fmtTime(secs, 0)} · {fmtAgo(p.updatedAt)} {stems > 1 && <span class="badge">{stems} stems</span>}
          </div>
        </span>
      </button>
      <button class="btn icon ghost" aria-label={`More actions for ${p.name}`} onClick={onMenu}>
        <IconMore />
      </button>
    </div>
  );
}

function ImportSheet({ files, onCancel, onGo }: { files: File[]; onCancel: () => void; onGo: (m: ImportMode) => void }) {
  const [mode, setMode] = useState<ImportMode>('stems');
  const [guessed, setGuessed] = useState(false);
  useEffect(() => {
    // Guess from durations via <audio> metadata (cheap, no full decode).
    let cancelled = false;
    void Promise.all(
      files.map(
        (f) =>
          new Promise<number>((res) => {
            const a = new Audio();
            const url = URL.createObjectURL(f);
            a.preload = 'metadata';
            a.onloadedmetadata = () => {
              URL.revokeObjectURL(url);
              res(a.duration);
            };
            a.onerror = () => {
              URL.revokeObjectURL(url);
              res(NaN);
            };
            a.src = url;
          }),
      ),
    ).then((d) => {
      if (cancelled) return;
      setMode(looksLikeStems(d.filter(Number.isFinite)) && d.every(Number.isFinite) ? 'stems' : 'join');
      setGuessed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [files]);
  const desc: Record<ImportMode, string> = {
    stems: 'Layers of one song (e.g. Suno stems: vocals, drums, bass…). They play together and you can balance them under Mix.',
    join: 'One after another in the order chosen — e.g. two takes or an extension. You can then cut and crossfade between them.',
    separate: 'Each file becomes its own project.',
  };
  return (
    <Sheet title={`${files.length} files`} onClose={onCancel}>
      <ul class="small dim" style={{ margin: 0, paddingLeft: '18px', maxHeight: '120px', overflow: 'auto' }}>
        {files.map((f) => (
          <li>{f.name}</li>
        ))}
      </ul>
      <Segmented
        label="How to use these files"
        value={mode}
        options={[
          { value: 'stems', label: 'Stems' },
          { value: 'join', label: 'Join' },
          { value: 'separate', label: 'Separate' },
        ]}
        onChange={setMode}
      />
      <p class="small dim" style={{ margin: 0 }}>
        {desc[mode]}
        {guessed && mode === 'stems' && ' (Guessed because the files have the same length.)'}
      </p>
      <div class="row">
        <button class="btn grow" onClick={onCancel}>
          Cancel
        </button>
        <button class="btn primary grow" onClick={() => onGo(mode)}>
          Import
        </button>
      </div>
    </Sheet>
  );
}
