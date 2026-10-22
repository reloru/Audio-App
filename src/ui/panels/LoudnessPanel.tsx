import { useEffect, useRef } from 'preact/hooks';
import type { EditorStore } from '../editorStore';
import { LOUDNESS_PRESETS } from '../../model/presets';
import { Slider, Toggle, Progress } from '../components/controls';
import { fmtDb, fmtLufs } from '../format';

export function LoudnessPanel({ store }: { store: EditorStore }) {
  const p = store.project;
  const m = p.master;
  const a = store.analysis;
  const r = a.result;
  const preset = LOUDNESS_PRESETS.find((x) => x.id === m.presetId) ?? LOUDNESS_PRESETS[0];

  useEffect(() => {
    if (!a.running && (!r || store.analysisStale)) void store.analyze();
  }, []);

  const gain = r && m.normalize && Number.isFinite(r.integrated) ? m.targetLufs - r.integrated : 0;
  const predictedTp = r ? r.truePeakDb + gain : NaN;
  const limiterWillWork = m.limiter && predictedTp > m.ceilingDb;

  return (
    <>
      <div class="card stack">
        <div class="row">
          <h3 class="grow">Measured</h3>
          <button class="btn" disabled={a.running} onClick={() => void store.analyze()}>
            {a.running ? 'Measuring…' : store.analysisStale && r ? 'Re-measure' : 'Measure'}
          </button>
        </div>
        {a.running && <Progress value={a.progress} />}
        {r ? (
          <>
            <div class="meter-grid">
              <Stat k="Integrated loudness" v={`${fmtLufs(r.integrated)} LUFS`} />
              <Stat k="True peak" v={`${fmtLufs(r.truePeakDb)} dBTP`} warn={r.truePeakDb > -1} />
              <Stat k="Loudness range" v={`${r.lra.toFixed(1)} LU`} />
              <Stat k="Max short-term" v={`${fmtLufs(r.shortTermMax)} LUFS`} />
            </div>
            <LoudnessGraph store={store} />
            <p class="tiny faint" style={{ margin: 0 }}>
              Measured with ITU-R BS.1770-5 gating and true-peak method (checked against the EBU Tech 3341/3342 test signals), after your edits,
              mix and EQ{p.exportSettings.range === 'selection' && store.selection ? ', for the selection only' : ''}.
              {store.analysisStale && ' Settings changed since this measurement.'}
            </p>
            {Number.isFinite(r.integrated) && <SpotifyNote lufs={r.integrated + gain} tp={Math.min(predictedTp, m.limiter ? m.ceilingDb : Infinity)} />}
          </>
        ) : (
          !a.running && <p class="small dim">Measure to see how loud the song is.</p>
        )}
      </div>

      <div class="card stack">
        <h3>Target</h3>
        <div class="stack" style={{ gap: '8px' }} role="radiogroup" aria-label="Loudness target">
          {LOUDNESS_PRESETS.map((pr) => (
            <button
              role="radio"
              aria-checked={pr.id === m.presetId}
              class={`btn block ${pr.id === m.presetId ? 'on' : ''}`}
              style={{ justifyContent: 'flex-start' }}
              onClick={() =>
                store.commit((d) => {
                  d.master.presetId = pr.id;
                  d.master.normalize = pr.normalize;
                  if (pr.id !== 'custom') {
                    d.master.targetLufs = pr.targetLufs;
                    d.master.ceilingDb = pr.ceilingDb;
                  }
                })
              }
            >
              {pr.label}
            </button>
          ))}
        </div>
        <p class="tiny faint" style={{ margin: 0 }}>
          {preset.source}
        </p>
        {m.presetId === 'custom' && (
          <Slider
            label="Target loudness"
            value={m.targetLufs}
            min={-30}
            max={-6}
            step={0.5}
            format={(v) => `${fmtLufs(v)} LUFS`}
            onInput={(v) => store.commit((d) => void (d.master.targetLufs = v), 'target')}
          />
        )}
        {m.normalize && r && Number.isFinite(r.integrated) && (
          <div class={`note ${limiterWillWork ? 'warn' : ''}`}>
            Export will apply <b class="num">{fmtDb(gain)}</b>
            {limiterWillWork
              ? ` and the limiter will hold peaks at ${m.ceilingDb} dBTP (peaks would reach ${predictedTp.toFixed(1)} dBTP otherwise). Loudness is re-measured and corrected after limiting.`
              : ' — no limiting needed.'}
            {m.targetLufs > -14 && m.ceilingDb > -2 && ' Spotify recommends a −2 dBTP ceiling for masters louder than −14 LUFS.'}
          </div>
        )}
        {m.normalize && (
          <p class="tiny faint" style={{ margin: 0 }}>
            While you listen, the preview applies the same gain{r ? '' : ' (after measuring)'}.
          </p>
        )}
      </div>

      <div class="card stack">
        <Toggle
          label="True-peak limiter"
          hint="Catches peaks above the ceiling, including peaks between samples."
          checked={m.limiter}
          onChange={(v) => store.commit((d) => void (d.master.limiter = v))}
        />
        {m.limiter && (
          <Slider
            label="Ceiling"
            value={m.ceilingDb}
            min={-6}
            max={0}
            step={0.1}
            reset={-1}
            format={(v) => `${fmtLufs(v)} dBTP`}
            onInput={(v) => store.commit((d) => void (d.master.ceilingDb = v), 'ceiling')}
          />
        )}
      </div>
    </>
  );
}

function Stat({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div class="stat">
      <div class="v" style={warn ? { color: 'var(--warn)' } : undefined}>
        {v}
      </div>
      <div class="k">{k}</div>
    </div>
  );
}

/**
 * Spotify for Artists ("Loudness normalization"): tracks are normalised to
 * -14 LUFS (Normal); louder ones are turned down; softer ones are turned up
 * leaving about 1 dB of true-peak headroom for lossy encoding.
 */
function SpotifyNote({ lufs, tp }: { lufs: number; tp: number }) {
  const target = -14;
  let text: string;
  if (lufs > target + 0.2) text = `Spotify (Normal setting) would play the export about ${(lufs - target).toFixed(1)} dB quieter.`;
  else if (lufs < target - 0.2) {
    const up = Math.max(0, Math.min(target - lufs, -1 - tp));
    text =
      up < target - lufs - 0.1
        ? `Spotify would raise it by about ${up.toFixed(1)} dB (limited by peak headroom), so it would sound ${(target - lufs - up).toFixed(1)} dB quieter than louder tracks.`
        : `Spotify would raise it by about ${up.toFixed(1)} dB.`;
  } else text = 'Matches Spotify’s −14 LUFS reference: no adjustment on playback.';
  return <div class="note">{text}</div>;
}

function LoudnessGraph({ store }: { store: EditorStore }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const r = store.analysis.result;
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !r) return;
    const rect = cv.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.round(rect.width * dpr);
    cv.height = Math.round(rect.height * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    const cs = getComputedStyle(cv);
    const st = r.shortTerm;
    const lo = -36;
    const hi = -4;
    const y = (v: number) => h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cs.getPropertyValue('--grid-bar').trim();
    ctx.font = '10px system-ui';
    for (const v of [-30, -23, -14, -8]) {
      ctx.fillRect(0, Math.round(y(v)), w, 1);
      ctx.fillText(`${v}`, 4, y(v) - 3);
    }
    const tgt = store.project.master;
    if (tgt.normalize) {
      ctx.fillStyle = cs.getPropertyValue('--accent').trim();
      ctx.fillRect(0, Math.round(y(tgt.targetLufs)), w, 1.5);
    }
    if (st.length > 1) {
      ctx.strokeStyle = cs.getPropertyValue('--wave').trim();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < st.length; i++) {
        const x = (i / (st.length - 1)) * w;
        if (i === 0) ctx.moveTo(x, y(st[i]));
        else ctx.lineTo(x, y(st[i]));
      }
      ctx.stroke();
    }
  }, [r, store.project.master.targetLufs, store.project.master.normalize]);
  if (!r || r.shortTerm.length < 2) return null;
  return (
    <figure style={{ margin: 0 }}>
      <canvas ref={ref} class="eq-graph" aria-label="Short-term loudness over time" />
      <figcaption class="tiny faint">Short-term loudness (3 s window) over the song, LUFS</figcaption>
    </figure>
  );
}
