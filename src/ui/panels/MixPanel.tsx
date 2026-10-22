import { useRef, useState } from 'preact/hooks';
import type { EditorStore } from '../editorStore';
import type { Source } from '../../model/types';
import { Slider } from '../components/controls';
import { IconPlus, IconTrash } from '../components/icons';
import { fmtDb } from '../format';
import { toast, errorText } from '../toast';
import { runBusy } from '../busy';

const isVocal = (name: string) => /vocal|vox|voice|acapella|a cappella/i.test(name) && !/backing|instrumental/i.test(name);

export function MixPanel({ store }: { store: EditorStore }) {
  const p = store.project;
  const usedSources = new Set(p.clips.map((c) => c.sourceId));
  return (
    <>
      <p class="small dim" style={{ margin: 0 }}>
        Suno can split a song into stems (vocals, instrumental, or up to 12 parts). Add the stem files to rebalance the mix: turn the vocals up,
        make an instrumental, or mute a harsh synth.
      </p>
      {p.sources
        .filter((s) => usedSources.has(s.id))
        .map((s) => (
          <SourceCard store={store} source={s} />
        ))}
    </>
  );
}

function SourceCard({ store, source }: { store: EditorStore; source: Source }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const vocals = source.layers.filter((l) => isVocal(l.name));
  const multi = source.layers.length > 1;

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      await runBusy('Adding stems', (prog) => store.addStems([...files], source.id, prog));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const setAll = (fn: (name: string) => { mute?: boolean; solo?: boolean }) =>
    store.commit((d) => {
      const s = d.sources.find((x) => x.id === source.id)!;
      for (const l of s.layers) Object.assign(l, { mute: false, solo: false }, fn(l.name));
    });

  return (
    <div class="card stack">
      <div class="row">
        <h3 class="grow">{source.name}</h3>
        <span class="badge">{multi ? `${source.layers.length} stems` : 'Full mix'}</span>
      </div>
      {multi && (
        <div class="chips">
          {vocals.length > 0 && (
            <>
              <button class="chip" onClick={() => setAll((n) => ({ mute: isVocal(n) }))}>
                Instrumental
              </button>
              <button class="chip" onClick={() => setAll((n) => ({ solo: isVocal(n) }))}>
                A cappella
              </button>
            </>
          )}
          <button
            class="chip"
            onClick={() =>
              store.commit((d) => {
                const s = d.sources.find((x) => x.id === source.id)!;
                for (const l of s.layers) Object.assign(l, { mute: false, solo: false, gainDb: 0, balance: 0 });
              })
            }
          >
            Reset mix
          </button>
        </div>
      )}
      {source.layers.map((l) => (
        <div class="layer">
          <div class="head">
            <span class="nm">{l.name}</span>
            <button
              class={`ms m ${l.mute ? 'on' : ''}`}
              aria-pressed={l.mute}
              aria-label={`Mute ${l.name}`}
              onClick={() => store.setLayer(source.id, l.id, { mute: !l.mute })}
            >
              M
            </button>
            {multi && (
              <button
                class={`ms s ${l.solo ? 'on' : ''}`}
                aria-pressed={l.solo}
                aria-label={`Solo ${l.name}`}
                onClick={() => store.setLayer(source.id, l.id, { solo: !l.solo })}
              >
                S
              </button>
            )}
            {multi && (
              <button class="btn icon ghost" aria-label={`Remove ${l.name}`} onClick={() => setConfirmRemove(l.id)}>
                <IconTrash size={18} />
              </button>
            )}
          </div>
          {confirmRemove === l.id && (
            <div class="row">
              <span class="small grow">Remove this stem from the song?</span>
              <button class="btn" onClick={() => setConfirmRemove(null)}>
                Keep
              </button>
              <button
                class="btn danger"
                onClick={() => {
                  setConfirmRemove(null);
                  store.removeLayer(source.id, l.id);
                }}
              >
                Remove
              </button>
            </div>
          )}
          <Slider
            label="Level"
            value={l.gainDb}
            min={-24}
            max={12}
            step={0.5}
            reset={0}
            format={(v) => fmtDb(v)}
            onInput={(v) => store.setLayer(source.id, l.id, { gainDb: v }, `gain-${l.id}`)}
          />
          {multi && (
            <Slider
              label="Balance"
              value={l.balance}
              min={-1}
              max={1}
              step={0.05}
              reset={0}
              format={(v) => (Math.abs(v) < 0.001 ? 'Centre' : v < 0 ? `L ${Math.round(-v * 100)}%` : `R ${Math.round(v * 100)}%`)}
              onInput={(v) => store.setLayer(source.id, l.id, { balance: v }, `bal-${l.id}`)}
            />
          )}
        </div>
      ))}
      <button class="btn" onClick={() => fileRef.current?.click()}>
        <IconPlus size={18} /> Add stem files
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav"
        multiple
        hidden
        onChange={(e) => {
          const input = e.target as HTMLInputElement;
          void add(input.files);
          input.value = '';
        }}
      />
      {!multi && (
        <p class="tiny faint" style={{ margin: 0 }}>
          Stems should come from the same song so they line up. Adding two or more stems mutes this full mix automatically.
        </p>
      )}
    </div>
  );
}
