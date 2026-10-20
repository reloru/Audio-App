import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorStore } from '../editorStore';
import { chooseOutputRate } from '../../engine/export';
import type { ExportSettings, ProjectMeta } from '../../model/types';
import { Segmented, Progress } from '../components/controls';
import { IconShare, IconDownload, IconMusic } from '../components/icons';
import { fmtBytes, fmtDuration, fmtLufs } from '../format';
import { loadCover, storeImage } from '../importer';
import { toast, errorText } from '../toast';

const STAGE_TEXT = { analyze: 'Measuring loudness', adjust: 'Fine-tuning loudness after limiting', render: 'Rendering and encoding' } as const;

export function ExportPanel({ store }: { store: EditorStore }) {
  const p = store.project;
  const s = p.exportSettings;
  const ex = store.exportState;
  const set = (patch: Partial<ExportSettings>) => store.commit((d) => void Object.assign(d.exportSettings, patch));
  const outRate = chooseOutputRate(p);
  const hasSel = !!store.selection;

  return (
    <>
      <div class="card stack">
        <h3>Format</h3>
        <Segmented
          label="Format"
          value={s.format}
          options={[
            { value: 'mp3', label: 'MP3' },
            { value: 'wav', label: 'WAV' },
          ]}
          onChange={(format) => set({ format })}
        />
        {s.format === 'mp3' ? (
          <div class="chips" role="radiogroup" aria-label="MP3 bitrate">
            {([128, 192, 256, 320] as const).map((b) => (
              <button role="radio" aria-checked={s.mp3Bitrate === b} class={`chip ${s.mp3Bitrate === b ? 'on' : ''}`} onClick={() => set({ mp3Bitrate: b })}>
                {b} kbps
              </button>
            ))}
          </div>
        ) : (
          <div class="chips" role="radiogroup" aria-label="WAV bit depth">
            {(
              [
                ['pcm16', '16-bit'],
                ['pcm24', '24-bit'],
                ['float32', '32-bit float'],
              ] as const
            ).map(([v, l]) => (
              <button role="radio" aria-checked={s.wavFormat === v} class={`chip ${s.wavFormat === v ? 'on' : ''}`} onClick={() => set({ wavFormat: v })}>
                {l}
              </button>
            ))}
          </div>
        )}
        <p class="tiny faint" style={{ margin: 0 }}>
          {s.format === 'mp3'
            ? 'Constant bitrate, works everywhere. Re-encoding an MP3 loses a little quality each time: pick 320 kbps, or WAV if your source is WAV.'
            : s.wavFormat === 'pcm16'
              ? '16-bit with TPDF dither (CD format). Lossless and accepted by distributors; files are about 10 MB per minute.'
              : s.wavFormat === 'pcm24'
                ? '24-bit, lossless, more headroom for further processing.'
                : '32-bit float: no quantisation; for importing into a DAW.'}
        </p>
        <div class="label">Sample rate</div>
        <Segmented
          label="Sample rate"
          value={s.sampleRate}
          options={[
            { value: 'source', label: `Source (${(p.sampleRate / 1000).toFixed(1)} kHz)` },
            { value: 44100, label: '44.1 kHz' },
            { value: 48000, label: '48 kHz' },
          ]}
          onChange={(sampleRate) => set({ sampleRate })}
        />
        {outRate !== p.sampleRate && <p class="tiny faint" style={{ margin: 0 }}>Will be converted to {(outRate / 1000).toFixed(1)} kHz.</p>}
        <div class="label">What to export</div>
        <Segmented
          label="Range"
          value={s.range}
          options={[
            { value: 'all', label: 'Whole song' },
            { value: 'selection', label: hasSel ? `Selection (${store.sec(store.selection!.end - store.selection!.start).toFixed(1)} s)` : 'Selection' },
          ]}
          onChange={(range) => {
            if (range === 'selection' && !hasSel) return void toast('Select a part of the song first.');
            set({ range });
          }}
        />
      </div>

      <MetaCard store={store} />

      <button class="btn primary block" style={{ minHeight: '52px', fontSize: '16px' }} disabled={!!ex && !['done', 'error'].includes(ex.stage)} onClick={() => void store.runExport()}>
        Export {s.format.toUpperCase()}
      </button>
      <p class="tiny faint" style={{ margin: '-6px 0 0', textAlign: 'center' }}>
        {p.master.normalize ? `Loudness target ${fmtLufs(p.master.targetLufs)} LUFS` : 'Original loudness'}
        {p.master.limiter ? ` · peaks ≤ ${fmtLufs(p.master.ceilingDb)} dBTP` : ' · limiter off'} · processed on this device
      </p>
      {ex && <ExportStatus store={store} />}
    </>
  );
}

function ExportStatus({ store }: { store: EditorStore }) {
  const ex = store.exportState!;
  const [url, setUrl] = useState<string | null>(null);
  const res = ex.result;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [ex.stage, !!res]);
  useEffect(() => {
    if (!res) return;
    const u = URL.createObjectURL(res.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [res]);

  if (ex.stage === 'error') {
    return (
      <div class="card stack" role="alert" ref={box}>
        <h3>Export failed</h3>
        <p class="small dim" style={{ margin: 0 }}>
          {ex.error}
        </p>
        <button class="btn" onClick={() => store.dismissExport()}>
          OK
        </button>
      </div>
    );
  }
  if (!res) {
    return (
      <div class="card stack" aria-live="polite" ref={box}>
        <h3>{STAGE_TEXT[ex.stage as keyof typeof STAGE_TEXT] ?? 'Working'}…</h3>
        <Progress value={ex.progress} />
        <button class="btn" onClick={() => store.cancelExport()}>
          Cancel
        </button>
      </div>
    );
  }
  const st = res.stats;
  const file = new File([res.blob], res.fileName, { type: res.mime });
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  return (
    <div class="card stack" aria-live="polite" ref={box}>
      <div class="row">
        <h3 class="grow">Ready: {res.fileName}</h3>
        <button class="btn ghost" onClick={() => store.dismissExport()}>
          Close
        </button>
      </div>
      <div class="small dim num">
        {fmtDuration(st.durationSec)} · {fmtBytes(res.blob.size)} · {(st.sampleRate / 1000).toFixed(1)} kHz
      </div>
      <div class="meter-grid">
        <div class="stat">
          <div class="v">{fmtLufs(st.integratedLufs)}</div>
          <div class="k">LUFS integrated</div>
        </div>
        <div class="stat">
          <div class="v">{fmtLufs(st.truePeakDb)}</div>
          <div class="k">dBTP true peak</div>
        </div>
      </div>
      {st.limiterActiveFraction > 0 && (
        <p class="tiny faint" style={{ margin: 0 }}>
          Limiter reduced peaks by up to {(-st.limiterReductionDb).toFixed(1)} dB on {(st.limiterActiveFraction * 100).toFixed(1)}% of the song.
          {st.limiterReductionDb < -4 && ' That is a lot of limiting — consider a lower target.'}
        </p>
      )}
      {url && <audio controls src={url} style={{ width: '100%' }} preload="metadata" />}
      <div class="row">
        {canShare && (
          <button
            class="btn primary grow"
            onClick={async () => {
              try {
                await navigator.share({ files: [file], title: res.fileName });
              } catch (e) {
                if ((e as DOMException).name !== 'AbortError') toast(errorText(e), 'error');
              }
            }}
          >
            <IconShare size={18} /> Share / Save
          </button>
        )}
        {url && (
          <a class={`btn grow ${canShare ? '' : 'primary'}`} href={url} download={res.fileName}>
            <IconDownload size={18} /> Download
          </a>
        )}
      </div>
    </div>
  );
}

function MetaCard({ store }: { store: EditorStore }) {
  const m = store.project.meta;
  const [cover, setCover] = useState<string | null>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let url: string | null = null;
    void loadCover(m.coverFileId).then((c) => {
      url = c?.url ?? null;
      setCover(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [m.coverFileId]);
  const setMeta = (k: keyof ProjectMeta, v: string) => store.commit((d) => void ((d.meta as unknown as Record<string, string>)[k] = v), `meta-${k}`);
  const field = (k: keyof ProjectMeta, label: string, attrs: Record<string, unknown> = {}) => (
    <div class="field">
      <label for={`meta-${k}`}>{label}</label>
      <input id={`meta-${k}`} class="input" value={(m[k] as string) ?? ''} onInput={(e) => setMeta(k, (e.target as HTMLInputElement).value)} {...attrs} />
    </div>
  );
  return (
    <div class="card stack">
      <h3>Song details</h3>
      <div class="row" style={{ alignItems: 'flex-start', gap: '14px' }}>
        <button class="btn ghost" style={{ padding: 0, height: 'auto' }} aria-label="Choose cover art" onClick={() => imgRef.current?.click()}>
          {cover ? (
            <img class="cover" src={cover} alt="Cover art" />
          ) : (
            <div class="cover" style={{ display: 'grid', placeItems: 'center', color: 'var(--text-faint)' }}>
              <IconMusic size={30} />
            </div>
          )}
        </button>
        <div class="stack grow" style={{ gap: '8px' }}>
          {field('title', 'Title')}
          {field('artist', 'Artist')}
        </div>
      </div>
      <input
        ref={imgRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={async (e) => {
          const input = e.target as HTMLInputElement;
          const f = input.files?.[0];
          input.value = '';
          if (!f) return;
          if (f.size > 5 * 1024 * 1024) return void toast('Please choose an image under 5 MB.', 'error');
          const id = await storeImage(f);
          store.commit((d) => void (d.meta.coverFileId = id));
        }}
      />
      <div class="grid2">
        {field('album', 'Album')}
        {field('genre', 'Genre')}
        {field('year', 'Year', { inputMode: 'numeric' })}
        {field('track', 'Track no.', { inputMode: 'numeric' })}
      </div>
      <div class="field">
        <label for="meta-comment">Comment</label>
        <input id="meta-comment" class="input" value={m.comment} onInput={(e) => setMeta('comment', (e.target as HTMLInputElement).value)} />
      </div>
      <details>
        <summary class="small dim" style={{ cursor: 'pointer', minHeight: '32px' }}>
          Lyrics (embedded in MP3)
        </summary>
        <textarea class="input" value={m.lyrics} onInput={(e) => setMeta('lyrics', (e.target as HTMLTextAreaElement).value)} />
      </details>
      <p class="tiny faint" style={{ margin: 0 }}>
        Written as ID3v2.3 tags in MP3, and as RIFF INFO plus an ID3 chunk in WAV. Tags already in the Suno file are kept.
      </p>
    </div>
  );
}
