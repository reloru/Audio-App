import { useRef, useState } from 'preact/hooks';
import type { EditorStore } from '../editorStore';
import { FADE_CURVES, type FadeCurve } from '../../dsp/fades';
import { doubleBeats, halveBeats, bpmFromBeats } from '../../dsp/beats';
import { CLIP_LENGTHS } from '../../model/presets';
import { seamExtent } from '../../model/timeline';
import { Slider } from '../components/controls';
import {
  IconScissors,
  IconCrop,
  IconRepeat,
  IconSplit,
  IconFadeOut,
  IconFadeIn,
  IconWand,
  IconPlus,
  IconExport,
  IconLoop,
  IconClock,
} from '../components/icons';
import { toast, errorText } from '../toast';
import { useBusy } from '../busy';

export function EditPanel({ store }: { store: EditorStore }) {
  const sel = store.selection;
  const p = store.project;
  const seam = store.selectedSeam;
  const insertRef = useRef<HTMLInputElement>(null);
  const [insertWhere, setInsertWhere] = useState<'playhead' | 'end'>('playhead');
  const busy = useBusy();
  const grid = p.clips[0] ? p.grids[p.clips[0].sourceId] : undefined;

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      await busy.run('Adding audio', (prog) => store.insertFiles([...files], insertWhere, prog));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <>
      {seam !== null && p.clips[seam] && <SeamCard store={store} index={seam} />}

      <div class="section-title num">
        {sel
          ? `Selection · ${store.sec(sel.end - sel.start).toFixed(2)} s${(() => {
              const n = store.beats().filter((b) => b.t >= sel.start && b.t < sel.end).length;
              return n ? ` · ${n} beats` : '';
            })()}`
          : 'Select a part to edit it'}
      </div>
      <div class="actions">
        <button class="action" disabled={!sel} onClick={() => store.deleteSelection()}>
          <IconScissors />
          Cut out
        </button>
        <button class="action" disabled={!sel} onClick={() => store.keepSelection()}>
          <IconCrop />
          Keep only this
        </button>
        <button class="action" disabled={!sel} onClick={() => store.repeatSelection(1)}>
          <IconRepeat />
          Repeat it
        </button>
        <button class="action" disabled={!sel} onClick={() => store.repeatSelection(3)}>
          <IconLoop />
          Loop ×4
        </button>
        <button
          class="action"
          disabled={!sel}
          onClick={() => {
            store.commit((d) => {
              d.exportSettings.range = 'selection';
            });
            store.set({ tab: 'export' });
          }}
        >
          <IconExport />
          Export this part
        </button>
      </div>

      <div class="section-title">At the playhead</div>
      <div class="actions">
        <button class="action" onClick={() => store.endHere(3)}>
          <IconFadeOut />
          End song here
          <span class="tiny faint">3 s fade-out</span>
        </button>
        <button class="action" onClick={() => store.startHere()}>
          <IconFadeIn />
          Start song here
        </button>
        <button class="action" onClick={() => store.splitAtPlayhead()}>
          <IconSplit />
          Split
        </button>
        <button class="action" onClick={() => store.trimSilence()}>
          <IconWand />
          Trim silence
        </button>
      </div>

      <div class="card stack">
        <h3>Fades</h3>
        <p class="small dim" style={{ margin: 0 }}>
          Applied to the start and end of what you export{p.exportSettings.range === 'selection' ? ' (the selection)' : ''}.
        </p>
        <FadeControls store={store} which="fadeIn" label="Fade in" max={10} />
        <FadeControls store={store} which="fadeOut" label="Fade out" max={20} />
      </div>

      <div class="card stack">
        <h3>Short clip</h3>
        <p class="small dim" style={{ margin: 0 }}>
          Selects a clip starting at the bar before the playhead and loops it, for Reels, TikTok, Shorts or a ringtone.
        </p>
        <div class="chips">
          {CLIP_LENGTHS.map((s) => (
            <button class="chip" onClick={() => store.makeClipSelection(s)}>
              <IconClock size={14} /> {s} s
            </button>
          ))}
        </div>
        <button
          class="btn block"
          disabled={!sel}
          onClick={async () => {
            const secs = sel ? store.sec(sel.end - sel.start) : 0;
            const np = await store.saveSelectionAsProject(0.05, Math.min(2, secs * 0.15), `${Math.round(secs)} s clip`);
            if (np) toast(`Saved “${np.name}” to your library`);
          }}
        >
          Save selection as a new project
        </button>
      </div>

      <div class="card stack">
        <h3>Add audio</h3>
        <p class="small dim" style={{ margin: 0 }}>
          Join another take or an extension. Cuts and joins get a short crossfade; tap a pink seam marker to adjust it.
        </p>
        <div class="row">
          <button
            class="btn grow"
            onClick={() => {
              setInsertWhere('playhead');
              insertRef.current?.click();
            }}
          >
            <IconPlus size={18} /> Insert at playhead
          </button>
          <button
            class="btn grow"
            onClick={() => {
              setInsertWhere('end');
              insertRef.current?.click();
            }}
          >
            <IconPlus size={18} /> Add at end
          </button>
        </div>
        <input
          ref={insertRef}
          type="file"
          accept="audio/*,.mp3,.wav"
          multiple
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void onFiles(input.files);
            input.value = '';
          }}
        />
      </div>

      <div class="card stack">
        <h3>Beat grid</h3>
        {grid ? (
          <>
            <p class="small dim" style={{ margin: 0 }}>
              Detected ≈ <b class="num">{grid.bpm.toFixed(1)} BPM</b> (beat tracking after Ellis, 2007). If edits snap to every other
              beat, halve or double it. Bar lines are a best guess — set one on a downbeat if needed.
            </p>
            <div class="row wrap">
              <button class="btn" onClick={() => setGrid(store, (b) => doubleBeats(b))}>
                ×2 tempo
              </button>
              <button class="btn" onClick={() => setGrid(store, (b) => halveBeats(b))}>
                ÷2 tempo
              </button>
              <button class="btn" onClick={() => setBarAtPlayhead(store)}>
                Bar starts at playhead
              </button>
            </div>
          </>
        ) : (
          <p class="small dim" style={{ margin: 0 }}>
            No steady beat was detected, so edits snap to clip edges only.
          </p>
        )}
      </div>
    </>
  );
}

function setGrid(store: EditorStore, fn: (beats: number[]) => number[]) {
  const id = store.project.clips[0]?.sourceId;
  if (!id) return;
  store.commit((d) => {
    for (const sid of Object.keys(d.grids)) {
      const g = d.grids[sid];
      g.beats = fn(g.beats);
      g.bpm = bpmFromBeats(g.beats);
      g.barOffset = 0;
    }
  });
}

function setBarAtPlayhead(store: EditorStore) {
  const t = store.currentPosition();
  const beats = store.beats();
  if (!beats.length) return;
  let best = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i].t - t) < Math.abs(beats[best].t - t)) best = i;
  // find which source beat index this timeline beat corresponds to
  const p = store.project;
  const loc = beats[best].t;
  let pos = 0;
  for (const c of p.clips) {
    const n = c.end - c.start;
    if (loc >= pos && loc < pos + n) {
      const g = p.grids[c.sourceId];
      if (!g) return;
      const srcSec = (c.start + (loc - pos)) / p.sampleRate;
      let k = 0;
      for (let i = 1; i < g.beats.length; i++) if (Math.abs(g.beats[i] - srcSec) < Math.abs(g.beats[k] - srcSec)) k = i;
      store.commit((d) => {
        const gg = d.grids[c.sourceId];
        gg.barOffset = ((k % gg.beatsPerBar) + gg.beatsPerBar) % gg.beatsPerBar;
      });
      toast('Bar lines moved');
      return;
    }
    pos += n;
  }
}

function FadeControls({ store, which, label, max }: { store: EditorStore; which: 'fadeIn' | 'fadeOut'; label: string; max: number }) {
  const f = store.project[which];
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <Slider
        label={label}
        value={f.seconds}
        min={0}
        max={max}
        step={0.05}
        reset={0}
        format={(v) => (v === 0 ? 'Off' : `${v.toFixed(2)} s`)}
        onInput={(v) => store.setFade(which, { seconds: v })}
      />
      {f.seconds > 0 && (
        <div class="chips">
          {FADE_CURVES.map((c) => (
            <button class={`chip ${f.curve === c.id ? 'on' : ''}`} onClick={() => store.setFade(which, { curve: c.id as FadeCurve }, false)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SeamCard({ store, index }: { store: EditorStore; index: number }) {
  const p = store.project;
  const clip = p.clips[index];
  const ext = seamExtent(p.clips, p.sources, index);
  const ms = Math.round((clip.xfade / p.sampleRate) * 1000);
  const effective = Math.round(((ext.pre + ext.post) / p.sampleRate) * 1000);
  return (
    <div class="card stack">
      <div class="row">
        <h3 class="grow">Crossfade at seam</h3>
        <button class="btn ghost" onClick={() => store.set({ selectedSeam: null })}>
          Done
        </button>
      </div>
      <Slider
        label="Length"
        value={ms}
        min={0}
        max={2000}
        step={5}
        reset={15}
        format={(v) => (v === 0 ? 'Hard cut' : `${v} ms`)}
        onInput={(v) => store.setSeamXfade(index, v)}
      />
      {effective < ms && (
        <p class="tiny faint" style={{ margin: 0 }}>
          Limited to {effective} ms by the audio available around this seam.
        </p>
      )}
      <button
        class="btn"
        onClick={() => {
          const start = Math.max(0, p.clips.slice(0, index).reduce((s, c) => s + c.end - c.start, 0) - Math.round(p.sampleRate * 2));
          store.setPlayhead(start);
          void store.togglePlay();
        }}
      >
        Listen from 2 s before
      </button>
    </div>
  );
}
