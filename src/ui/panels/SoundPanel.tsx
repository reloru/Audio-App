import { useEffect, useRef } from 'preact/hooks';
import type { EditorStore } from '../editorStore';
import { biquadCoeffs, biquadMagnitude } from '../../dsp/biquad';
import { eqToBiquads } from '../../engine/eq';
import { EQ_PRESETS, FLAT_EQ, SPEED_PRESETS } from '../../model/presets';
import type { EqSettings } from '../../model/types';
import { Slider, logScale } from '../components/controls';
import { fmtDb, fmtHz } from '../format';

const sameEq = (a: EqSettings, b: EqSettings) => JSON.stringify(a) === JSON.stringify(b);

export function SoundPanel({ store }: { store: EditorStore }) {
  const p = store.project;
  const eq = p.eq;
  const setEq = (fn: (e: EqSettings) => void, merge: string) =>
    store.commit((d) => {
      fn(d.eq);
    }, merge);
  const grid = p.clips[0] ? p.grids[p.clips[0].sourceId] : undefined;
  const semis = 12 * Math.log2(p.speed);

  return (
    <>
      <div class="card stack">
        <div class="row">
          <h3 class="grow">EQ</h3>
          {!sameEq(eq, FLAT_EQ) && (
            <button class="btn ghost" onClick={() => store.commit((d) => void (d.eq = structuredClone(FLAT_EQ)))}>
              Reset
            </button>
          )}
        </div>
        <div class="chips">
          {EQ_PRESETS.map((pr) => (
            <button class={`chip ${sameEq(eq, pr.eq) ? 'on' : ''}`} onClick={() => store.commit((d) => void (d.eq = structuredClone(pr.eq)))}>
              {pr.label}
            </button>
          ))}
        </div>
        <EqGraph eq={eq} sampleRate={p.sampleRate} />
        <Slider
          label="Low cut (high-pass)"
          value={eq.hpf}
          min={0}
          max={400}
          scale={{
            toPos: (v) => (v <= 0 ? 0 : 50 + logScale(20, 400).toPos(v) * 0.95),
            fromPos: (pos) => (pos < 50 ? 0 : logScale(20, 400).fromPos((pos - 50) / 0.95)),
          }}
          reset={0}
          format={(v) => (v <= 0 ? 'Off' : fmtHz(v))}
          onInput={(v) => setEq((e) => void (e.hpf = v), 'hpf')}
        />
        <Slider label="Bass shelf" value={eq.lowShelf.gain} min={-12} max={12} step={0.5} reset={0} format={(v) => fmtDb(v)} onInput={(v) => setEq((e) => void (e.lowShelf.gain = v), 'ls-g')} />
        {eq.lowShelf.gain !== 0 && (
          <Slider label="Bass shelf frequency" value={eq.lowShelf.freq} min={40} max={500} scale={logScale(40, 500)} format={fmtHz} onInput={(v) => setEq((e) => void (e.lowShelf.freq = v), 'ls-f')} />
        )}
        <Slider label="Mid band" value={eq.mid.gain} min={-12} max={12} step={0.5} reset={0} format={(v) => fmtDb(v)} onInput={(v) => setEq((e) => void (e.mid.gain = v), 'mid-g')} />
        {eq.mid.gain !== 0 && (
          <>
            <Slider label="Mid frequency" value={eq.mid.freq} min={150} max={9000} scale={logScale(150, 9000)} format={fmtHz} onInput={(v) => setEq((e) => void (e.mid.freq = v), 'mid-f')} />
            <Slider
              label="Mid width (Q)"
              value={eq.mid.q}
              min={0.3}
              max={4}
              step={0.1}
              reset={1}
              format={(v) => v.toFixed(1)}
              onInput={(v) => setEq((e) => void (e.mid.q = v), 'mid-q')}
            />
          </>
        )}
        <Slider label="Treble shelf" value={eq.highShelf.gain} min={-12} max={12} step={0.5} reset={0} format={(v) => fmtDb(v)} onInput={(v) => setEq((e) => void (e.highShelf.gain = v), 'hs-g')} />
        {eq.highShelf.gain !== 0 && (
          <Slider label="Treble shelf frequency" value={eq.highShelf.freq} min={2000} max={16000} scale={logScale(2000, 16000)} format={fmtHz} onInput={(v) => setEq((e) => void (e.highShelf.freq = v), 'hs-f')} />
        )}
        <Slider
          label="High cut (low-pass)"
          value={eq.lpf}
          min={0}
          max={20000}
          scale={{
            toPos: (v) => (v <= 0 ? 1000 : logScale(2000, 20000).toPos(v) * 0.95),
            fromPos: (pos) => (pos > 950 ? 0 : logScale(2000, 20000).fromPos(pos / 0.95)),
          }}
          reset={0}
          format={(v) => (v <= 0 ? 'Off' : fmtHz(v))}
          onInput={(v) => setEq((e) => void (e.lpf = v), 'lpf')}
        />
        <p class="tiny faint" style={{ margin: 0 }}>
          Some Suno renders have metallic “shimmer” in the 4–12 kHz range; a gentle treble cut can soften it, but cannot remove it.
        </p>
      </div>

      <div class="card stack">
        <h3>Stereo width</h3>
        <Slider
          label="Width"
          value={p.width}
          min={0}
          max={2}
          step={0.05}
          reset={1}
          format={(v) => (v === 0 ? 'Mono' : `${Math.round(v * 100)}%`)}
          onInput={(v) => store.commit((d) => void (d.width = v), 'width')}
        />
        <div class="chips">
          <button class={`chip ${p.width === 0 ? 'on' : ''}`} onClick={() => store.commit((d) => void (d.width = 0))}>
            Mono check
          </button>
          <button class={`chip ${p.width === 1 ? 'on' : ''}`} onClick={() => store.commit((d) => void (d.width = 1))}>
            Original
          </button>
        </div>
      </div>

      <div class="card stack">
        <h3>Speed</h3>
        <p class="small dim" style={{ margin: 0 }}>
          Changes tempo and pitch together (like a turntable) — the “slowed” and “sped up” sound.
        </p>
        <Slider
          label="Speed"
          value={p.speed}
          min={0.5}
          max={1.5}
          step={0.01}
          reset={1}
          format={(v) => `${v.toFixed(2)}×`}
          onInput={(v) => store.commit((d) => void (d.speed = v), 'speed')}
        />
        <div class="chips">
          {SPEED_PRESETS.map((s) => (
            <button class={`chip ${Math.abs(p.speed - s) < 1e-6 ? 'on' : ''}`} onClick={() => store.commit((d) => void (d.speed = s))}>
              {s.toFixed(2)}×
            </button>
          ))}
        </div>
        <div class="small dim num">
          Pitch {semis >= 0 ? '+' : '−'}
          {Math.abs(semis).toFixed(2)} semitones
          {grid && grid.bpm > 0 && ` · ${(grid.bpm * p.speed).toFixed(1)} BPM`}
          {` · length ${(store.sec(store.length) / 60).toFixed(0)}:${String(Math.round(store.sec(store.length) % 60)).padStart(2, '0')}`}
        </div>
      </div>

      <div class="card stack">
        <h3>Output gain</h3>
        <Slider
          label="Gain"
          value={p.gainDb}
          min={-12}
          max={12}
          step={0.5}
          reset={0}
          format={(v) => fmtDb(v)}
          onInput={(v) => store.commit((d) => void (d.gainDb = v), 'gain')}
        />
        <p class="tiny faint" style={{ margin: 0 }}>
          For a target loudness (e.g. Spotify), use the Loudness tab instead — it measures and sets the gain for you.
        </p>
      </div>
    </>
  );
}

function EqGraph({ eq, sampleRate }: { eq: EqSettings; sampleRate: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width;
    const h = r.height;
    const cs = getComputedStyle(cv);
    ctx.clearRect(0, 0, w, h);
    const range = 15;
    const y = (db: number) => h / 2 - (db / range) * (h / 2 - 8);
    ctx.fillStyle = cs.getPropertyValue('--grid-bar').trim();
    for (const f of [100, 1000, 10000]) {
      const x = (Math.log(f / 20) / Math.log(1000)) * w;
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillRect(0, Math.round(y(0)), w, 1);
    ctx.font = '10px system-ui';
    ctx.fillStyle = cs.getPropertyValue('--text-faint').trim();
    ctx.fillText('100', (Math.log(5) / Math.log(1000)) * w + 3, h - 4);
    ctx.fillText('1k', (Math.log(50) / Math.log(1000)) * w + 3, h - 4);
    ctx.fillText('10k', (Math.log(500) / Math.log(1000)) * w + 3, h - 4);
    const coeffs = eqToBiquads(eq, sampleRate).map((q) => biquadCoeffs(q, sampleRate));
    ctx.strokeStyle = cs.getPropertyValue('--accent').trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const f = 20 * Math.pow(1000, x / w);
      let mag = 1;
      for (const c of coeffs) mag *= biquadMagnitude(c, Math.min(f, sampleRate / 2 - 1), sampleRate);
      const db = Math.max(-range, Math.min(range, 20 * Math.log10(mag)));
      if (x === 0) ctx.moveTo(x, y(db));
      else ctx.lineTo(x, y(db));
    }
    ctx.stroke();
  }, [JSON.stringify(eq), sampleRate]);
  return <canvas class="eq-graph" ref={ref} aria-label="EQ response curve" />;
}
