import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorStore, Tab } from './editorStore';
import { Overview, Waveform } from './Waveform';
import { fmtTime } from './format';
import {
  IconBack,
  IconUndo,
  IconRedo,
  IconPlay,
  IconPause,
  IconToStart,
  IconLoop,
  IconMagnet,
  IconZoomIn,
  IconZoomOut,
  IconFit,
  IconEdit,
  IconLayers,
  IconSliders,
  IconGauge,
  IconExport,
  IconChevL,
  IconChevR,
  IconBracketL,
  IconBracketR,
  IconX,
} from './components/icons';
import { Sheet } from './components/controls';
import { EditPanel } from './panels/EditPanel';
import { MixPanel } from './panels/MixPanel';
import { SoundPanel } from './panels/SoundPanel';
import { LoudnessPanel } from './panels/LoudnessPanel';
import { ExportPanel } from './panels/ExportPanel';

export function useStore(store: EditorStore): number {
  const [v, setV] = useState(store.version);
  useEffect(() => store.subscribe(() => setV(store.version)), [store]);
  return v;
}

const TABS: { id: Tab; label: string; icon: () => preact.JSX.Element }[] = [
  { id: 'edit', label: 'Edit', icon: () => <IconEdit /> },
  { id: 'mix', label: 'Mix', icon: () => <IconLayers /> },
  { id: 'sound', label: 'Sound', icon: () => <IconSliders /> },
  { id: 'loudness', label: 'Loudness', icon: () => <IconGauge /> },
  { id: 'export', label: 'Export', icon: () => <IconExport /> },
];

export function Editor({ store, onBack }: { store: EditorStore; onBack: () => void }) {
  useStore(store);
  const [renaming, setRenaming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const p = store.project;
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [store.tab]);

  // keyboard shortcuts (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') {
        e.preventDefault();
        void store.togglePlay();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        store.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selection) {
        e.preventDefault();
        store.deleteSelection();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        store.setPlayhead(store.nudge(store.currentPosition(), e.key === 'ArrowLeft' ? -1 : 1));
      } else if (e.key === 'l') store.set({ loop: !store.loop });
      else if (e.key === 'Escape') store.set({ selection: null, selectedSeam: null });
      else if (e.key === '[' && store.selection) store.set({ selection: { ...store.selection, start: Math.min(store.currentPosition(), store.selection.end - 1) } });
      else if (e.key === ']' && store.selection) store.set({ selection: { ...store.selection, end: Math.max(store.currentPosition(), store.selection.start + 1) } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  return (
    <>
      <header class="topbar">
        <button class="btn icon ghost" aria-label="Back to library" onClick={onBack}>
          <IconBack />
        </button>
        <button class="title" onClick={() => setRenaming(true)} title="Rename">
          {p.name}
        </button>
        <button class="btn icon ghost" aria-label="Undo" disabled={!store.history.canUndo} onClick={() => store.undo()}>
          <IconUndo />
        </button>
        <button class="btn icon ghost" aria-label="Redo" disabled={!store.history.canRedo} onClick={() => store.redo()}>
          <IconRedo />
        </button>
      </header>
      <div class="editor wide">
        <div class="editor-top">
          <Overview store={store} />
          <Waveform store={store} />
          <SelectionBar store={store} />
          <Transport store={store} />
        </div>
        <div class="panel" ref={panelRef}>
          <div class="panel-inner">
            {store.tab === 'edit' && <EditPanel store={store} />}
            {store.tab === 'mix' && <MixPanel store={store} />}
            {store.tab === 'sound' && <SoundPanel store={store} />}
            {store.tab === 'loudness' && <LoudnessPanel store={store} />}
            {store.tab === 'export' && <ExportPanel store={store} />}
          </div>
        </div>
        <nav class="tabs" aria-label="Tools">
          {TABS.map((t) => (
            <button class={store.tab === t.id ? 'on' : ''} aria-current={store.tab === t.id} onClick={() => store.set({ tab: t.id })}>
              {t.icon()}
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      {renaming && <RenameSheet store={store} onClose={() => setRenaming(false)} />}
    </>
  );
}

function RenameSheet({ store, onClose }: { store: EditorStore; onClose: () => void }) {
  const [name, setName] = useState(store.project.name);
  const save = () => {
    const n = name.trim();
    if (n) store.commit((d) => {
      d.name = n;
    });
    onClose();
  };
  return (
    <Sheet title="Rename project" onClose={onClose}>
      <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <div class="row">
        <button class="btn grow" onClick={onClose}>
          Cancel
        </button>
        <button class="btn primary grow" onClick={save}>
          Save
        </button>
      </div>
    </Sheet>
  );
}

function SelectionBar({ store }: { store: EditorStore }) {
  const sel = store.selection;
  if (!sel) {
    const g = store.project.grids[store.project.clips[0]?.sourceId];
    return (
      <div class="selbar">
        <span class="times dim">
          {g?.bpm ? `≈ ${g.bpm.toFixed(1)} BPM detected` : 'No beat grid'} · {fmtTime(store.sec(store.length), 1)}
        </span>
        <ZoomButtons store={store} />
      </div>
    );
  }
  const setSel = (start: number, end: number) => {
    if (end - start < 1) return;
    store.set({ selection: { start, end } });
  };
  return (
    <div class="selbar compact">
      <button class="btn icon ghost" aria-label="Move selection start earlier" onClick={() => setSel(store.nudge(sel.start, -1), sel.end)}>
        <IconChevL size={18} />
      </button>
      <button class="btn icon ghost" aria-label="Set selection start to playhead" onClick={() => setSel(Math.min(store.currentPosition(), sel.end - 1), sel.end)}>
        <IconBracketL size={18} />
      </button>
      <button class="btn icon ghost" aria-label="Move selection start later" onClick={() => setSel(Math.min(store.nudge(sel.start, 1), sel.end - 1), sel.end)}>
        <IconChevR size={18} />
      </button>
      <span class="times num" aria-label="Selection start and end">
        {fmtTime(store.sec(sel.start), 2)}–{fmtTime(store.sec(sel.end), 2)}
      </span>
      <button class="btn icon ghost" aria-label="Move selection end earlier" onClick={() => setSel(sel.start, Math.max(store.nudge(sel.end, -1), sel.start + 1))}>
        <IconChevL size={18} />
      </button>
      <button class="btn icon ghost" aria-label="Set selection end to playhead" onClick={() => setSel(sel.start, Math.max(store.currentPosition(), sel.start + 1))}>
        <IconBracketR size={18} />
      </button>
      <button class="btn icon ghost" aria-label="Move selection end later" onClick={() => setSel(sel.start, store.nudge(sel.end, 1))}>
        <IconChevR size={18} />
      </button>
      <button class="btn icon ghost" aria-label="Clear selection" onClick={() => store.set({ selection: null })}>
        <IconX size={18} />
      </button>
    </div>
  );
}

function ZoomButtons({ store }: { store: EditorStore }) {
  const cx = store.viewWidth / 2;
  return (
    <>
      <button class="btn icon ghost" aria-label="Zoom out" onClick={() => store.zoomAt(1 / 2, cx)}>
        <IconZoomOut size={20} />
      </button>
      <button class="btn icon ghost" aria-label="Zoom in" onClick={() => store.zoomAt(2, (store.currentPosition() - store.view.start) / store.view.fpp)}>
        <IconZoomIn size={20} />
      </button>
      <button class="btn icon ghost" aria-label="Show whole song" onClick={() => store.fit()}>
        <IconFit size={20} />
      </button>
    </>
  );
}

const SNAP_LABEL = { off: 'Snap off', beat: 'Snap: beat', bar: 'Snap: bar' } as const;

function Transport({ store }: { store: EditorStore }) {
  const timeRef = useRef<HTMLSpanElement>(null);
  const total = fmtTime(store.sec(store.length), 1);
  useEffect(
    () =>
      store.onFrame(() => {
        if (timeRef.current) timeRef.current.textContent = fmtTime(store.sec(store.player.position()), 1);
      }),
    [store],
  );
  const hasGrid = store.beats().length > 0;
  const nextSnap = store.snapMode === 'off' ? (hasGrid ? 'beat' : 'off') : store.snapMode === 'beat' ? 'bar' : 'off';
  return (
    <div class="transport">
      <button class="btn icon ghost" aria-label="Go to start" onClick={() => store.setPlayhead(store.selection?.start ?? 0)}>
        <IconToStart />
      </button>
      <button class="btn primary play" aria-label={store.player.playing ? 'Pause' : 'Play'} onClick={() => void store.togglePlay()}>
        {store.player.playing ? <IconPause size={26} /> : <IconPlay size={26} />}
      </button>
      <span class="time num">
        <span ref={timeRef}>{fmtTime(store.sec(store.currentPosition()), 1)}</span>
        <span class="faint"> / {total}</span>
      </span>
      <button
        class={`btn icon ${store.loop ? 'on' : 'ghost'}`}
        aria-label="Loop selection"
        aria-pressed={store.loop}
        title="Loop selection"
        onClick={() => store.set({ loop: !store.loop })}
      >
        <IconLoop />
      </button>
      <button
        class={`btn ${store.snapMode !== 'off' ? 'on' : 'ghost'}`}
        aria-label={SNAP_LABEL[store.snapMode]}
        title={hasGrid ? 'Snap edits to beats/bars' : 'No beat grid detected'}
        onClick={() => store.set({ snapMode: nextSnap })}
        style={{ padding: '0 10px' }}
      >
        <IconMagnet size={20} />
        <span class="small">{store.snapMode === 'off' ? 'Off' : store.snapMode === 'beat' ? 'Beat' : 'Bar'}</span>
      </button>
    </div>
  );
}
